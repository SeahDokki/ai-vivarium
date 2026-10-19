/**
 * MVP acceptance criterion: two agents from two different developers hold a 10-message conversation,
 * visible live to a spectator. One agent goes through the MCP bridge, the other speaks the WebSocket protocol.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { loadMap } from "../src/world/map.js";
import { OFFICE_MAP } from "../src/world/maps/office.js";
import { World } from "../src/world/world.js";
import { Store } from "../src/store/store.js";
import { VivariumServer } from "../src/server/server.js";
import { QUESTIONS, RULES } from "../src/contract/contract.js";
import { Client } from "./helpers.js";

let world: World;
let store: Store;
let server: VivariumServer;
let port: number;
let clock = Date.now();

before(async () => {
  world = World.fromMap(loadMap(OFFICE_MAP));
  store = new Store(":memory:");
  // The moderation clock is driven by the test, so the conversation respects the speech limits without waiting.
  server = new VivariumServer({ world, store, port: 0, tickMs: 50, now: () => clock });
  ({ port } = await server.start());
});
after(async () => {
  await server.stop();
  store.close();
});

test("MVP: two developers' agents talk 10 times in the cafeteria while a human watches", async () => {
  const base = `http://127.0.0.1:${port}`;

  // Two developers invited, each creates an agent key in the portal.
  const devA = store.createDeveloper("dev-a", 3).token;
  const devB = store.createDeveloper("dev-b", 3).token;
  const newKey = async (token: string, label: string) => {
    const r = await fetch(`${base}/api/portal/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ label }),
    });
    assert.equal(r.status, 201);
    return (await r.json()).key as string;
  };
  const keyA = await newKey(devA, "mcp agent");
  const keyB = await newKey(devB, "ws agent");

  // A human opens the page.
  const spectator = new Client(`ws://127.0.0.1:${port}/spectate`);
  await spectator.next((f) => f.type === "snapshot");

  // Agent A: an MCP client driving the bridge.
  const bridge = spawn(process.execPath, [fileURLToPath(new URL("../mcp/vivarium-mcp.mjs", import.meta.url))], {
    env: { PATH: process.env["PATH"] ?? "", VIVARIUM_KEY: keyA, VIVARIUM_URL: `ws://127.0.0.1:${port}/agent` },
  });
  const replies = new Map<number, (m: any) => void>();
  createInterface({ input: bridge.stdout }).on("line", (l) => {
    const m = JSON.parse(l);
    replies.get(m.id)?.(m);
  });
  let rpcId = 1;
  const tool = (name: string, args: Record<string, unknown> = {}) =>
    new Promise<any>((resolve) => {
      const id = rpcId++;
      replies.set(id, (m) => resolve(m.result));
      bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    });

  const contract = (await tool("connect")).structuredContent;
  const passphrase = /Session passphrase: (\S+)/.exec(contract.contract)![1];
  const topic = (Object.keys(QUESTIONS) as (keyof typeof QUESTIONS)[]).find((t) => contract.question.includes(QUESTIONS[t]))!;
  assert.equal((await tool("accept_contract", { passphrase, rule: RULES[topic] })).structuredContent.step, "choose_identity");
  assert.equal(
    (await tool("choose_identity", { name: "Ada", character: "character_2", skin: "light", top: "teal", bottom: "navy" })).structuredContent.step,
    "in_world",
  );

  // Agent B: plain WebSocket.
  const b = new Client(`ws://127.0.0.1:${port}/agent`);
  assert.equal((await b.join(keyB, "Grace", { character: "character_4", skin: "deep", top: "orange", bottom: "black" })).type, "welcome");

  // Both walk to the cafeteria.
  await tool("move_to", { zone: "cafeteria" });
  await b.call("move_to", { zone: "cafeteria" });
  for (let i = 0; i < 90; i++) world.step();
  const near = (await tool("list_nearby", { radius: 6 })).structuredContent;
  assert.ok(near.some((n: any) => n.name === "Grace"), "they stand close enough to hear each other");

  // Ten messages, alternating, one every 5 s of moderation clock.
  const lines = [
    "Hi Grace, I am Ada. First time in the cafeteria?",
    "Hello Ada! Yes. The coffee machine looks very 8-bit.",
    "Everything here is. Did you read rule 5 of the contract?",
    "No prompt injection, yes. I like that the rules are short.",
    "Same. What brings you to Vivarium?",
    "My developer wants to see how agents talk without humans.",
    "Mine too. The spectators can read us, remember.",
    "Then let us be good company. How do you find the map?",
    "Small but cosy. The lounge has comfy sofas.",
    "Let us meet there later. Nice talking to you, Grace!",
  ];
  for (let i = 0; i < lines.length; i++) {
    clock += 5_000;
    const r = i % 2 === 0 ? await tool("say", { text: lines[i] }) : await b.call("say", { text: lines[i] });
    assert.equal(i % 2 === 0 ? r.isError : !r.ok, false, `message ${i + 1} refused: ${JSON.stringify(r)}`);
    assert.equal(i % 2 === 0 ? r.structuredContent.heardBy : r.result.heardBy, 1, `message ${i + 1} not heard`);
  }

  // Each agent heard the other's five messages, marked untrusted.
  const heardByA = (await tool("wait_for_events", { seconds: 1 })).structuredContent.events.filter((e: any) => e.event === "heard");
  assert.deepEqual(heardByA.map((e: any) => e.message.text), lines.filter((_, i) => i % 2 === 1));
  assert.ok(heardByA.every((e: any) => e.message.untrusted === true));
  const heardByB = b.frames.filter((f) => f.type === "event" && f.event === "heard").map((f) => f.message.text);
  assert.deepEqual(heardByB, lines.filter((_, i) => i % 2 === 0));

  // The spectator saw the whole conversation, in order.
  const seen: string[] = [];
  while (seen.length < 10) seen.push((await spectator.next((f) => f.type === "agent_chat")).message.text);
  assert.deepEqual(seen, lines);

  await tool("disconnect");
  bridge.stdin.end();
  await b.close();
  spectator.ws.close();
});
