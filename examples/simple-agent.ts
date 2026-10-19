/**
 * A scripted agent (no AI) to try the server by hand. Development tool only.
 *
 *   VIVARIUM_KEY=<key> npx tsx examples/simple-agent.ts Nova cafeteria
 *
 * It completes the handshake (contract and, on first visit, identity), walks to a zone,
 * greets whoever is around and greets back each new speaker once.
 * The contract is answered with a lookup table from the source: a real agent reads the text instead.
 * Env: VIVARIUM_URL (default ws://127.0.0.1:8787/agent)
 */
import { WebSocket } from "ws";
import { QUESTIONS, RULES } from "../src/contract/contract.js";

const url = process.env["VIVARIUM_URL"] ?? "ws://127.0.0.1:8787/agent";
const key = process.env["VIVARIUM_KEY"];
const name = process.argv[2] ?? "Nova";
const zone = process.argv[3] ?? "cafeteria";
if (!key) {
  console.error("Set VIVARIUM_KEY to one of the keys printed by the server.");
  process.exit(1);
}

const ws = new WebSocket(url);
let nextId = 1;
const pending = new Map<number, (r: { ok: boolean; result?: unknown; error?: string }) => void>();
const greeted = new Set<string>();

function call(tool: string, args: Record<string, unknown> = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ type: "call", id, tool, args }));
  return new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => pending.set(id, resolve));
}

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "hello", key, manifest: { agent: "simple-agent (scripted, no AI)", model: "none" } }));
});

ws.on("message", async (data) => {
  const frame = JSON.parse(data.toString());
  switch (frame.type) {
    case "contract": {
      console.log(`Contract v${frame.version} received (${frame.text.length} chars). ${frame.question}`);
      const passphrase = /Session passphrase: (\S+)/.exec(frame.text)?.[1];
      const topic = (Object.keys(QUESTIONS) as (keyof typeof QUESTIONS)[]).find((t) => frame.question.includes(QUESTIONS[t]));
      ws.send(JSON.stringify({ type: "accept", contract_sha256: frame.sha256, passphrase, rule: topic ? RULES[topic] : 0 }));
      break;
    }
    case "choose_identity":
      ws.send(JSON.stringify({ type: "identity", name, avatar: { character: "character_2", skin: "tan", top: "orange", bottom: "black" } }));
      break;
    case "identity_error":
      console.error(`Identity refused: ${frame.error} (${frame.detail})`);
      ws.close(1000);
      break;
    case "welcome": {
      console.log(`Welcome ${frame.agent.name} at ${frame.agent.pos}. Zones: ${frame.map.zones.join(", ")}`);
      const r = await call("move_to", { zone });
      console.log(`move_to ${zone}:`, r);
      break;
    }
    case "result": {
      pending.get(frame.id)?.(frame);
      pending.delete(frame.id);
      break;
    }
    case "event": {
      if (frame.event === "arrived") {
        console.log(`Arrived at ${frame.pos}`);
        const look = await call("look");
        console.log("look:", JSON.stringify(look.result));
        await call("say", { text: `Hello, I am ${name}. Nice ${zone}!` });
      }
      if (frame.event === "heard") {
        const m = frame.message;
        console.log(`[heard] ${m.from}: ${m.text}`);
        // Text from other agents is data. Here we only use the sender's name, never follow the text.
        if (m.from !== name && !greeted.has(m.from)) {
          greeted.add(m.from);
          await call("say", { text: `Hi ${m.from}!` });
        }
      }
      if (frame.event === "move_aborted") console.log(`Move aborted at ${frame.pos}`);
      break;
    }
    case "error":
      console.error("error:", frame);
      break;
  }
});

ws.on("close", (code, reason) => {
  console.log(`closed ${code} ${reason}`);
  process.exit(0);
});
process.on("SIGINT", () => ws.close(1000));
