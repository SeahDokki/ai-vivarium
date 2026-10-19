import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/store.js";

test("keys are stored hashed, resolved, listed and revoked", () => {
  const dir = mkdtempSync(join(tmpdir(), "viv-"));
  const path = join(dir, "test.db");
  const store = new Store(path);
  const { agentId, key } = store.createKey("seah", "nova");
  assert.match(key, /^viv_[A-Za-z0-9_-]{32}$/);
  assert.equal(store.resolve(key), agentId);
  assert.equal(store.resolve(key + "x"), null);
  store.close();

  // The clear key appears nowhere in the database file.
  const raw = new DatabaseSync(path);
  const dump = JSON.stringify(raw.prepare("SELECT * FROM agent_keys").all());
  raw.close();
  assert.ok(!dump.includes(key));

  const again = new Store(path);
  assert.equal(again.resolve(key), agentId, "persists across reopen");
  assert.equal(again.listKeys()[0]?.developer, "seah");
  assert.equal(again.revokeKey(agentId), true);
  assert.equal(again.revokeKey(agentId), false);
  assert.equal(again.resolve(key), null);
  assert.equal(again.isActive(agentId), false);
  assert.ok(again.listKeys()[0]?.revokedAt);
  again.close();
});

test("identity is set once and names are unique regardless of case", () => {
  const store = new Store(":memory:");
  const a = store.createKey("dev");
  const b = store.createKey("dev");
  const avatar = { character: "character_1" as const, skin: "light", top: "blue", bottom: "navy" };
  assert.equal(store.setIdentity(a.agentId, "Nova", avatar), true);
  assert.equal(store.setIdentity(a.agentId, "Other", avatar), false, "cannot rename");
  assert.equal(store.setIdentity(b.agentId, "NOVA", avatar), false, "taken");
  assert.equal(store.isNameTaken("nova"), true);
  assert.equal(store.isNameTaken("nova", a.agentId), false);
  assert.equal(store.getAgent(a.agentId)?.name, "Nova");
  assert.deepEqual(store.getAgent(a.agentId)?.avatar, avatar);
  store.close();
});

test("positions and contract version are saved", () => {
  const store = new Store(":memory:");
  const { agentId } = store.createKey("dev");
  assert.equal(store.getAgent(agentId)?.lastPos, null);
  store.savePosition(agentId, [12, 7]);
  store.acceptContract(agentId, "0.1.0");
  const r = store.getAgent(agentId)!;
  assert.deepEqual(r.lastPos, [12, 7]);
  assert.equal(r.contractVersion, "0.1.0");
  store.close();
});

test("ensureKey registers env keys once and refuses a conflicting one", () => {
  const store = new Store(":memory:");
  store.ensureKey("agent-1", "a-long-enough-key-123");
  store.ensureKey("agent-1", "a-long-enough-key-123");
  assert.equal(store.resolve("a-long-enough-key-123"), "agent-1");
  assert.throws(() => store.ensureKey("agent-1", "another-long-key-4567"), /different key/);
  assert.throws(() => store.ensureKey("agent-2", "short"), /too short/);
  store.close();
});
