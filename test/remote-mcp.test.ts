import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadMap } from "../src/world/map.js";
import { OFFICE_MAP } from "../src/world/maps/office.js";
import { World } from "../src/world/world.js";
import { Store } from "../src/store/store.js";
import { VivariumServer } from "../src/server/server.js";
import { normalizePublicUrl, publicLinks } from "../src/server/public-url.js";
import { QUESTIONS, RULES } from "../src/contract/contract.js";
import { Client } from "./helpers.js";

let world: World;
let store: Store;
let server: VivariumServer;
let base: string;

before(async () => {
  world = World.fromMap(loadMap(OFFICE_MAP));
  store = new Store(":memory:");
  server = new VivariumServer({ world, store, port: 0, tickMs: 50, publicUrl: "https://vivarium.example.com", mcpIdleMs: 400 });
  const { port } = await server.start();
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  await server.stop();
  store.close();
});

let rpcId = 1;
async function mcp(key: string, method: string, params: Record<string, unknown> = {}) {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
}
const tool = async (key: string, name: string, args: Record<string, unknown> = {}) =>
  (await mcp(key, "tools/call", { name, arguments: args })).body.result;

test("public URL: config, normalization and validation", async () => {
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(cfg, {
    public_url: "https://vivarium.example.com",
    mcp_url: "https://vivarium.example.com/mcp",
    agent_ws_url: "wss://vivarium.example.com/agent",
    bridge_download_url: "https://vivarium.example.com/downloads/vivarium-mcp.mjs",
  });
  assert.equal(normalizePublicUrl("http://localhost:8787/"), "http://localhost:8787");
  assert.equal(publicLinks("http://localhost:8787").config.agent_ws_url, "ws://localhost:8787/agent");
  assert.throws(() => normalizePublicUrl("ftp://x"), /http/);
  assert.throws(() => normalizePublicUrl("https://x.com/sub"), /root/);
  assert.throws(() => normalizePublicUrl("nope"), /valid/);
});

test("the bridge file can be downloaded", async () => {
  const r = await fetch(`${base}/downloads/vivarium-mcp.mjs`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition") ?? "", /attachment/);
  assert.match(await r.text(), /export class AgentLink/);
});

test("/mcp refuses missing keys, wrong methods, wrong types and foreign origins", async () => {
  const noKey = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(noKey.status, 401);
  assert.match(noKey.headers.get("www-authenticate") ?? "", /Bearer/);
  const { key } = store.createKey("remote");
  assert.equal((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${key}` } })).status, 405);
  const text = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "text/plain" }, body: "{}" });
  assert.equal(text.status, 415);
  const evil = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  assert.equal(evil.status, 403);
  const own = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", origin: "https://vivarium.example.com" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  assert.equal(own.status, 200);
});

test("a full visit over remote MCP, with another agent talking", async () => {
  const { key } = store.createKey("remote", "claude-code");
  const init = await mcp(key, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  const notif = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(notif.status, 202);
  const list = await mcp(key, "tools/list");
  assert.ok(list.body.result.tools.some((t: any) => t.name === "wait_for_events"));

  const c = (await tool(key, "connect")).structuredContent;
  assert.equal(c.step, "contract");
  const passphrase = /Session passphrase: (\S+)/.exec(c.contract)![1];
  const topic = (Object.keys(QUESTIONS) as (keyof typeof QUESTIONS)[]).find((t) => c.question.includes(QUESTIONS[t]))!;
  assert.equal((await tool(key, "accept_contract", { passphrase, rule: RULES[topic] })).structuredContent.step, "choose_identity");
  const id = await tool(key, "choose_identity", { name: "Remy", character: "character_3", skin: "sand", top: "green", bottom: "grey" });
  assert.equal(id.structuredContent.step, "in_world");

  const other = new Client(base.replace("http", "ws") + "/agent");
  await other.join(store.createKey("remote").key, "Lou");
  await tool(key, "move_to", { zone: "cafeteria" });
  await other.call("move_to", { zone: "cafeteria" });
  for (let i = 0; i < 90; i++) world.step();
  await other.call("say", { text: "Bonjour Remy, bienvenue !" });

  const ev = (await tool(key, "wait_for_events", { seconds: 2 })).structuredContent.events;
  const heard = ev.find((e: any) => e.event === "heard");
  assert.equal(heard.message.from, "Lou");
  assert.equal(heard.message.untrusted, true);
  const said = await tool(key, "say", { text: "Merci Lou !" });
  assert.equal(said.isError, false);
  assert.equal(said.structuredContent.heardBy, 1);

  // Batch requests are answered as a batch.
  const batch = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify([{ jsonrpc: "2.0", id: 90, method: "ping" }, { jsonrpc: "2.0", id: 91, method: "tools/list" }]),
  });
  assert.equal((await batch.json()).length, 2);

  assert.ok(!JSON.stringify(c).includes(key), "the key never comes back to the model");
  await other.close();
  const bye = await fetch(`${base}/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${key}` } });
  assert.equal(bye.status, 204);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!world.listAgents().some((a) => a.name === "Remy"), "DELETE ends the visit");
});

test("an idle remote agent leaves the world", async () => {
  const { key } = store.createKey("remote");
  const c = (await tool(key, "connect")).structuredContent;
  const passphrase = /Session passphrase: (\S+)/.exec(c.contract)![1];
  const topic = (Object.keys(QUESTIONS) as (keyof typeof QUESTIONS)[]).find((t) => c.question.includes(QUESTIONS[t]))!;
  await tool(key, "accept_contract", { passphrase, rule: RULES[topic] });
  await tool(key, "choose_identity", { name: "Sleepy", character: "character_1", skin: "light", top: "blue", bottom: "navy" });
  assert.ok(world.listAgents().some((a) => a.name === "Sleepy"));
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(!world.listAgents().some((a) => a.name === "Sleepy"), "gone after the idle delay");
  // It can come back, and skips contract and identity.
  const again = (await tool(key, "connect")).structuredContent;
  assert.equal(again.step, "in_world");
  assert.equal(again.you.name, "Sleepy");
});

test("a revoked key stops working on /mcp", async () => {
  const { key, agentId } = store.createKey("remote");
  assert.equal((await mcp(key, "ping")).status, 200);
  store.revokeKey(agentId);
  assert.equal((await mcp(key, "ping")).status, 401);
});
