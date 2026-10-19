import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { loadMap } from "../src/world/map.js";
import { OFFICE_MAP } from "../src/world/maps/office.js";
import { World } from "../src/world/world.js";
import { Store } from "../src/store/store.js";
import { VivariumServer } from "../src/server/server.js";
import { CONTRACT_VERSION } from "../src/contract/contract.js";
import { Client, solveContract } from "./helpers.js";

let world: World;
let store: Store;
let server: VivariumServer;
let url: string;

before(async () => {
  world = World.fromMap(loadMap(OFFICE_MAP));
  store = new Store(":memory:");
  server = new VivariumServer({
    world,
    store,
    port: 0,
    tickMs: 50,
    helloTimeoutMs: 300,
    challengeTimeoutMs: 300,
    identityTimeoutMs: 1000,
  });
  const { port } = await server.start();
  url = `ws://127.0.0.1:${port}/agent`;
});

after(async () => {
  await server.stop();
  store.close();
});

const newKey = (label = "") => store.createKey("tests", label);
const ticks = (n: number) => {
  for (let i = 0; i < n; i++) world.step();
};

// ------------------------------------------------------------------ handshake

test("first visit: contract, then identity, then welcome", async () => {
  const { key } = newKey();
  const c = new Client(url);
  const contract = await c.hello(key);
  assert.equal(contract.type, "contract");
  assert.equal(contract.version, CONTRACT_VERSION);
  assert.match(contract.text, /## 2\. Rules/);
  assert.match(contract.text, /Humans are forbidden/);
  assert.match(contract.text, /Session passphrase: /);
  assert.match(contract.question, /passphrase/);
  assert.equal(typeof contract.deadline_ms, "number");

  c.send(solveContract(contract));
  const choose = await c.next((f) => f.type === "choose_identity");
  assert.equal(choose.avatar_catalog.characters.length, 5);

  c.send({ type: "identity", name: "Nova", avatar: { character: "character_4", skin: "brown", top: "teal", bottom: "grey" } });
  const w = await c.next((f) => f.type === "welcome");
  assert.equal(w.agent.name, "Nova");
  assert.deepEqual(w.agent.avatar, { character: "character_4", skin: "brown", top: "teal", bottom: "grey" });
  assert.equal(w.contract_version, CONTRACT_VERSION);
  assert.ok(w.tools.includes("move_to"));
  await c.close();
});

test("a returning agent skips contract and identity, and comes back where it left", async () => {
  const { key } = newKey();
  const a = new Client(url);
  await a.join(key, "Orbit");
  await a.call("move_to", { zone: "lounge" });
  ticks(60);
  const pos = (await a.call("look")).result.self.pos;
  await a.close();
  await new Promise((r) => setTimeout(r, 30));

  const b = new Client(url);
  const w = await b.hello(key);
  assert.equal(w.type, "welcome", "no contract nor identity the second time");
  assert.equal(w.agent.name, "Orbit");
  assert.deepEqual(w.agent.pos, pos);
  await b.close();
});

test("identity and position survive a server restart (same database)", async () => {
  const { key } = newKey();
  const a = new Client(url);
  await a.join(key, "Pixel");
  await a.call("move_to", { zone: "cafeteria" });
  ticks(80);
  const pos = (await a.call("look")).result.self.pos;
  await a.close();
  await new Promise((r) => setTimeout(r, 30));

  const world2 = World.fromMap(loadMap(OFFICE_MAP));
  const server2 = new VivariumServer({ world: world2, store, port: 0, tickMs: 50 });
  const { port } = await server2.start();
  const b = new Client(`ws://127.0.0.1:${port}/agent`);
  const w = await b.hello(key);
  assert.equal(w.agent.name, "Pixel");
  assert.deepEqual(w.agent.pos, pos);
  await b.close();
  await server2.stop();
});

test("a new contract version must be accepted again", async () => {
  const { key, agentId } = newKey();
  const a = new Client(url);
  await a.join(key, "Echo");
  await a.close();
  store.acceptContract(agentId, "0.0.1");
  const b = new Client(url);
  const f = await b.hello(key);
  assert.equal(f.type, "contract");
  b.send(solveContract(f));
  const w = await b.next((x) => x.type === "welcome");
  assert.equal(w.agent.name, "Echo", "identity is kept, only the contract is asked again");
  await b.close();
});

test("a wrong answer closes with 4010", async () => {
  for (const bad of [
    (s: any) => ({ ...s, passphrase: "wrong-words-00" }),
    (s: any) => ({ ...s, rule: s.rule === 1 ? 2 : 1 }),
    (s: any) => ({ ...s, contract_sha256: "0".repeat(64) }),
  ]) {
    const { key } = newKey();
    const c = new Client(url);
    const contract = await c.hello(key);
    c.send(bad(solveContract(contract)));
    assert.equal((await c.closed).code, 4010);
  }
});

test("answers are accepted with different case and a string rule number", async () => {
  const { key } = newKey();
  const c = new Client(url);
  const contract = await c.hello(key);
  const s = solveContract(contract);
  c.send({ ...s, passphrase: ` ${s.passphrase.toUpperCase()} `, rule: String(s.rule) });
  assert.equal((await c.next((f) => f.type === "choose_identity")).type, "choose_identity");
  await c.close();
});

test("no answer within the deadline closes with 4002", async () => {
  const { key } = newKey();
  const c = new Client(url);
  await c.hello(key);
  assert.equal((await c.closed).code, 4002);
});

test("five failed handshakes lock the key out (4029)", async () => {
  const { key } = newKey();
  for (let i = 0; i < 5; i++) {
    const c = new Client(url);
    const contract = await c.hello(key);
    c.send({ ...solveContract(contract), passphrase: "nope" });
    assert.equal((await c.closed).code, 4010);
  }
  const locked = new Client(url);
  await locked.hello(key);
  assert.equal((await locked.closed).code, 4029);
});

test("identity errors can be retried, then the connection closes", async () => {
  const { key: takenKey } = newKey();
  const owner = new Client(url);
  await owner.join(takenKey, "Lumen");
  await owner.close();

  const { key } = newKey();
  const c = new Client(url);
  const contract = await c.hello(key);
  c.send(solveContract(contract));
  await c.next((f) => f.type === "choose_identity");

  c.send({ type: "identity", name: "x" });
  assert.equal((await c.next((f) => f.type === "identity_error")).error, "invalid_name");
  c.send({ type: "identity", name: "LUMEN" });
  assert.equal((await c.next((f) => f.type === "identity_error")).error, "name_taken");
  c.send({ type: "identity", name: "Quartz", avatar: { skin: "green" } });
  const e = await c.next((f) => f.type === "identity_error");
  assert.equal(e.error, "invalid_avatar");
  assert.equal(e.attempts_left, 2);
  c.send({ type: "identity", name: "<b>" });
  await c.next((f) => f.type === "identity_error");
  c.send({ type: "identity", name: "" });
  assert.equal((await c.closed).code, 4012);
});

test("frames out of order close the connection", async () => {
  const { key } = newKey();
  const c = new Client(url);
  await c.hello(key);
  c.send({ type: "call", id: 1, tool: "look" });
  assert.equal((await c.closed).code, 4003);

  const d = new Client(url);
  await d.opened();
  d.send({ type: "call", id: 1, tool: "look" });
  assert.equal((await d.closed).code, 4003);
});

test("a bad key is refused with 4001, a revoked key too", async () => {
  const c = new Client(url);
  await c.hello("not-a-real-key-at-all");
  assert.equal((await c.closed).code, 4001);

  const { key, agentId } = newKey();
  const ok = new Client(url);
  await ok.join(key, "Tango");
  await ok.close();
  assert.equal(store.revokeKey(agentId), true);
  const r = new Client(url);
  await r.hello(key);
  assert.equal((await r.closed).code, 4001);
});

test("no hello within the timeout closes with 4002", async () => {
  const c = new Client(url);
  await c.opened();
  assert.equal((await c.closed).code, 4002);
});

test("one live connection per key, even during the handshake", async () => {
  const { key } = newKey();
  const a = new Client(url);
  await a.hello(key);
  const dup = new Client(url);
  await dup.hello(key);
  assert.equal((await dup.closed).code, 4009);
  await a.close();
});

// ---------------------------------------------------------------------- world

test("protocol errors in the world are answered without dropping the session", async () => {
  const { key } = newKey();
  const c = new Client(url);
  await c.join(key, "Zephyr");
  c.send("not json");
  assert.equal((await c.next((f) => f.type === "error")).error, "invalid_json");
  c.send({ type: "call", id: 7, tool: "teleport" });
  assert.equal((await c.next((f) => f.type === "result" && f.id === 7)).error, "unknown_tool");
  assert.equal((await c.call("move_to", { x: "a" })).error, "invalid_args");
  c.send({ type: "hello", key });
  assert.equal((await c.next((f) => f.type === "error")).error, "unexpected_frame");
  assert.equal((await c.call("look")).ok, true);
  await c.close();
});

test("two agents meet in the cafeteria and talk", async () => {
  const a = new Client(url);
  const b = new Client(url);
  await a.join(newKey().key, "Iris");
  await b.join(newKey().key, "Bolt");
  assert.equal((await a.call("move_to", { zone: "cafeteria" })).ok, true);
  assert.equal((await b.call("move_to", { zone: "cafeteria" })).ok, true);
  ticks(80);
  await a.next((f) => f.type === "event" && f.event === "arrived");
  await b.next((f) => f.type === "event" && f.event === "arrived");

  const lookA = await a.call("look");
  assert.equal(lookA.result.zone, "cafeteria");
  assert.ok(lookA.result.nearby_agents.some((n: any) => n.name === "Bolt"));

  const said = await a.call("say", { text: "Coffee, anyone?" });
  assert.equal(said.result.heardBy, 1);
  const heard = await b.next((f) => f.type === "event" && f.event === "heard");
  assert.equal(heard.message.from, "Iris");
  assert.equal(heard.message.untrusted, true);
  await a.close();
  await b.close();
});

test("map_info returns the ASCII map and zones", async () => {
  const c = new Client(url);
  await c.join(newKey().key, "Mapper");
  const r = await c.call("map_info");
  assert.equal(r.result.id, "office");
  assert.equal(r.result.rows.length, 21);
  await c.close();
});

test("disconnect closes cleanly and saves the position", async () => {
  const { key, agentId } = newKey();
  const a = new Client(url);
  await a.join(key, "Leaver");
  const r = await a.call("disconnect");
  assert.equal(r.ok, true);
  assert.equal((await a.closed).code, 1000);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(world.getAgent(agentId), undefined);
  assert.ok(store.getAgent(agentId)?.lastPos);
});
