import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { loadMap } from "../src/world/map.js";
import { OFFICE_MAP } from "../src/world/maps/office.js";
import { World } from "../src/world/world.js";
import { Store } from "../src/store/store.js";
import { solveContract } from "./helpers.js";
import { VivariumServer } from "../src/server/server.js";
import { checkHumanMessage } from "../src/server/spectators.js";

const KEY = "spectator-test-key-0001";
let world: World;
let store: Store;
let server: VivariumServer;
let base: string;

before(async () => {
  world = World.fromMap(loadMap(OFFICE_MAP));
  store = new Store(":memory:");
  store.ensureKey("secret-agent-id", KEY);
  server = new VivariumServer({ world, store, port: 0, tickMs: 50 });
  const { port } = await server.start();
  base = `127.0.0.1:${port}`;
});

after(async () => {
  await server.stop();
  store.close();
});

/** Hello, contract, identity (first time only), welcome. */
async function join(agent: ReturnType<typeof open>, name: string, avatar?: unknown) {
  await agent.ready;
  agent.send({ type: "hello", key: KEY });
  let f = await agent.next((x) => ["contract", "choose_identity", "welcome"].includes(x.type));
  if (f.type === "contract") {
    agent.send(solveContract(f));
    f = await agent.next((x) => ["choose_identity", "welcome"].includes(x.type));
  }
  if (f.type === "choose_identity") {
    agent.send({ type: "identity", name, ...(avatar ? { avatar } : {}) });
    f = await agent.next((x) => x.type === "welcome");
  }
  return f;
}

/** Collects JSON frames from a socket and lets the test wait for one. */
function open(path: string) {
  const ws = new WebSocket(`ws://${base}${path}`);
  const frames: any[] = [];
  const waiters: { match: (f: any) => boolean; resolve: (f: any) => void }[] = [];
  ws.on("message", (d) => {
    const f = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.match(f));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(f);
    else frames.push(f);
  });
  const ready = new Promise<void>((r) => (ws.readyState === WebSocket.OPEN ? r() : ws.once("open", () => r())));
  return {
    ws,
    frames,
    ready,
    next(match: (f: any) => boolean, ms = 2000): Promise<any> {
      const i = frames.findIndex(match);
      if (i >= 0) return Promise.resolve(frames.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout")), ms);
        waiters.push({ match, resolve: (f) => (clearTimeout(t), resolve(f)) });
      });
    },
    send(o: unknown) {
      ws.send(typeof o === "string" ? o : JSON.stringify(o));
    },
    close() {
      ws.close();
    },
  };
}

test("the page is served with strict security headers", async () => {
  const res = await fetch(`http://${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(await res.text(), /aria-label="Vivarium"/);
  for (const path of ["/app.js", "/art.js", "/style.css"]) {
    assert.equal((await fetch(`http://${base}${path}`)).status, 200, path);
  }
});

test("only whitelisted files are served", async () => {
  for (const path of ["/package.json", "/../package.json", "/%2e%2e/package.json", "/src/server/keys.ts", "/web/app.js"]) {
    assert.equal((await fetch(`http://${base}${path}`)).status, 404, path);
  }
  assert.equal((await fetch(`http://${base}/app.js`, { method: "POST" })).status, 404);
});

test("unknown WebSocket paths are refused", async () => {
  const ws = new WebSocket(`ws://${base}/admin`);
  const err = await new Promise((resolve) => ws.on("error", resolve));
  assert.ok(err);
});

test("a spectator gets a snapshot with map, palette and agents under public ids", async () => {
  const agent = open("/agent");
  await join(agent, "Nova", { character: "character_3" });

  const viewer = open("/spectate");
  const snap = await viewer.next((f) => f.type === "snapshot");
  assert.equal(snap.map.id, "office");
  assert.equal(snap.sight_radius, 10);
  assert.equal(snap.hearing_radius, 6);
  assert.ok(snap.palette.skin.light);
  assert.ok(snap.palette.clothes.red);
  const nova = snap.agents.find((a: any) => a.name === "Nova");
  assert.ok(nova);
  assert.equal(nova.avatar.character, "character_3");
  assert.notEqual(nova.id, "secret-agent-id", "the real agent id must not leak");
  assert.doesNotMatch(JSON.stringify(snap), /secret-agent-id/);

  agent.close();
  viewer.close();
  await new Promise((r) => setTimeout(r, 50));
});

test("spectators see agents move and talk", async () => {
  const viewer = open("/spectate");
  await viewer.next((f) => f.type === "snapshot");
  const agent = open("/agent");
  await join(agent, "Nova");

  const joined = await viewer.next((f) => f.type === "agent_joined");
  assert.equal(joined.agent.name, "Nova");

  agent.send({ type: "call", id: 1, tool: "move_to", args: { zone: "lounge" } });
  await agent.next((f) => f.type === "result");
  world.step();
  const moved = await viewer.next((f) => f.type === "agent_moved");
  assert.equal(moved.id, joined.agent.id);

  agent.send({ type: "call", id: 2, tool: "say", args: { text: "Bonjour le bureau" } });
  const chat = await viewer.next((f) => f.type === "agent_chat");
  assert.equal(chat.message.from, "Nova");
  assert.equal(chat.message.text, "Bonjour le bureau");
  assert.equal(chat.message.speaker, joined.agent.id);
  assert.deepEqual(chat.message.heard_by, [joined.agent.id], "who heard it, so a spectator can follow one agent");

  agent.close();
  const left = await viewer.next((f) => f.type === "agent_left");
  assert.equal(left.id, joined.agent.id);
  viewer.close();
});

test("human chat reaches spectators but never agents", async () => {
  const agent = open("/agent");
  await join(agent, "Nova");

  const a = open("/spectate");
  const b = open("/spectate");
  await a.next((f) => f.type === "snapshot");
  await b.next((f) => f.type === "snapshot");

  a.send({ type: "chat", nick: "Seah", text: "Coucou <script>alert(1)</script>" });
  const got = await b.next((f) => f.type === "human_chat");
  assert.equal(got.message.nick, "Seah");
  assert.equal(got.message.text, "Coucou <script>alert(1)</script>"); // stored as text, the page renders it with textContent

  // The agent's inbox and pushed frames contain nothing from humans.
  agent.send({ type: "call", id: 1, tool: "look" });
  const look = await agent.next((f) => f.type === "result");
  assert.equal(look.result.recent_messages.length, 0);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(agent.frames.filter((f) => JSON.stringify(f).includes("Coucou")).length, 0);

  agent.close();
  a.close();
  b.close();
  await new Promise((r) => setTimeout(r, 50));
});

test("human chat is rate limited and duplicates are refused", async () => {
  const v = open("/spectate");
  await v.next((f) => f.type === "snapshot");
  for (let i = 0; i < 5; i++) {
    v.send({ type: "chat", nick: "Flood", text: `message ${i}` });
    await v.next((f) => f.type === "human_chat" && f.message.text === `message ${i}`);
  }
  v.send({ type: "chat", nick: "Flood", text: "message 6" });
  assert.equal((await v.next((f) => f.type === "chat_error")).error, "slow_down");
  v.close();

  const w = open("/spectate");
  await w.next((f) => f.type === "snapshot");
  w.send({ type: "chat", nick: "Echo", text: "same" });
  await w.next((f) => f.type === "human_chat" && f.message.text === "same");
  w.send({ type: "chat", nick: "Echo", text: "same" });
  assert.equal((await w.next((f) => f.type === "chat_error")).error, "duplicate");
  w.send("{not json");
  assert.equal((await w.next((f) => f.type === "chat_error")).error, "invalid_json");
  w.send({ type: "call", tool: "say", args: { text: "let me in" } });
  assert.equal((await w.next((f) => f.type === "chat_error")).error, "unknown_frame");
  w.close();
});

test("checkHumanMessage validates nick and text", () => {
  assert.deepEqual(checkHumanMessage("Seah", "  hello   world  "), { ok: true, nick: "Seah", text: "hello world" });
  assert.equal(checkHumanMessage("S", "hi").ok, false);
  assert.equal(checkHumanMessage("<img>", "hi").ok, false);
  assert.equal(checkHumanMessage("Seah", "").ok, false);
  assert.equal(checkHumanMessage("Seah", "x".repeat(301)).ok, false);
  assert.equal(checkHumanMessage("Seah", 42).ok, false);
  const bidi = checkHumanMessage("Seah", "abc‮def");
  assert.ok(bidi.ok);
  assert.equal(bidi.text, "abc def");
});
