import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadMap } from "../src/world/map.js";
import { OFFICE_MAP } from "../src/world/maps/office.js";
import { World } from "../src/world/world.js";
import { Store } from "../src/store/store.js";
import { VivariumServer } from "../src/server/server.js";
import { Client } from "./helpers.js";

let store: Store;
let server: VivariumServer;
let base: string;
let alice: string;
let bob: string;

before(async () => {
  store = new Store(":memory:");
  alice = store.createDeveloper("alice", 2).token;
  bob = store.createDeveloper("bob", 5).token;
  server = new VivariumServer({ world: World.fromMap(loadMap(OFFICE_MAP)), store, port: 0, tickMs: 50 });
  const { port } = await server.start();
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  await server.stop();
  store.close();
});

const api = (token: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });

test("the portal page is served", async () => {
  const r = await fetch(`${base}/portal`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Portail développeur/);
  assert.equal((await fetch(`${base}/portal.js`)).status, 200);
});

test("a developer sees their account, creates a key that works, and revokes it", async () => {
  const me = await (await api(alice, "GET", "/api/portal/me")).json();
  assert.equal(me.developer, "alice");
  assert.equal(me.max_agents, 2);
  assert.deepEqual(me.agents, []);

  const created = await api(alice, "POST", "/api/portal/agents", { label: "claude-test" });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("cache-control"), "no-store");
  const { agent_id, key } = await created.json();
  assert.match(key, /^viv_/);

  const agent = new Client(base.replace("http", "ws") + "/agent");
  const w = await agent.join(key, "Alicebot");
  assert.equal(w.type, "welcome");

  const after = await (await api(alice, "GET", "/api/portal/me")).json();
  const listed = after.agents.find((a: any) => a.agent_id === agent_id);
  assert.equal(listed.name, "Alicebot");
  assert.equal(listed.online, true);
  assert.equal(listed.label, "claude-test");
  assert.ok(!JSON.stringify(after).includes(key), "the key is never shown again");

  const revoked = await api(alice, "POST", `/api/portal/agents/${agent_id}/revoke`);
  assert.equal(revoked.status, 200);
  assert.equal((await agent.closed).code, 4001, "the live connection is cut at once");
  const again = new Client(base.replace("http", "ws") + "/agent");
  await again.hello(key);
  assert.equal((await again.closed).code, 4001);
});

test("a developer cannot exceed their quota nor touch another developer's agents", async () => {
  const a1 = await api(alice, "POST", "/api/portal/agents", { label: "one" });
  assert.equal(a1.status, 201);
  const a2 = await api(alice, "POST", "/api/portal/agents", { label: "two" });
  assert.equal(a2.status, 201);
  const a3 = await api(alice, "POST", "/api/portal/agents", { label: "three" });
  assert.equal(a3.status, 409);
  assert.equal((await a3.json()).error, "limit_reached");

  const { agent_id } = await a1.json();
  const stolen = await api(bob, "POST", `/api/portal/agents/${agent_id}/revoke`);
  assert.equal(stolen.status, 404);
  assert.equal(store.isActive(agent_id), true);
  const bobView = await (await api(bob, "GET", "/api/portal/me")).json();
  assert.equal(bobView.agents.length, 0);
});

test("bad requests are refused", async () => {
  assert.equal((await api(bob, "POST", "/api/portal/agents", { label: "<script>" })).status, 400);
  assert.equal((await api(bob, "POST", "/api/portal/agents", "{nope")).status, 400);
  assert.equal(
    (await fetch(`${base}/api/portal/agents`, { method: "POST", headers: { authorization: `Bearer ${bob}`, "content-type": "text/plain" }, body: "{}" })).status,
    415,
  );
  assert.equal((await api(bob, "POST", "/api/portal/agents", { label: "x".repeat(2000) })).status, 413);
  assert.equal((await api(bob, "GET", "/api/portal/secret")).status, 404);
  assert.equal((await api(bob, "POST", "/api/portal/agents/../../revoke")).status, 404);
});

test("a revoked developer loses portal access", async () => {
  const { token } = store.createDeveloper("carol", 1);
  assert.equal((await api(token, "GET", "/api/portal/me")).status, 200);
  store.revokeDeveloper("carol");
  assert.equal((await api(token, "GET", "/api/portal/me")).status, 401);
});

test("wrong tokens are locked out after 10 tries per IP", async () => {
  // Uses its own server so the lockout does not affect other tests.
  const s2 = new Store(":memory:");
  const { token } = s2.createDeveloper("dave", 1);
  const srv = new VivariumServer({ world: World.fromMap(loadMap(OFFICE_MAP)), store: s2, port: 0, tickMs: 50 });
  const { port } = await srv.start();
  const url = `http://127.0.0.1:${port}/api/portal/me`;
  for (let i = 0; i < 10; i++) {
    const r = await fetch(url, { headers: { authorization: `Bearer vivdev_wrong${i}` } });
    assert.equal(r.status, 401);
  }
  const locked = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(locked.status, 429, "even the right token waits once the IP is locked");
  await srv.stop();
  s2.close();
});

test("store: developer names and tokens", () => {
  const s = new Store(":memory:");
  assert.throws(() => s.createDeveloper("Bad Name"), /developer name/);
  const { token } = s.createDeveloper("eve");
  assert.throws(() => s.createDeveloper("eve"), /already exists/);
  assert.equal(s.resolveDeveloper(token)?.name, "eve");
  assert.equal(s.resolveDeveloper("viv_" + token.slice(7)), null);
  s.close();
});
