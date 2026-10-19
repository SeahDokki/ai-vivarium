import { test } from "node:test";
import assert from "node:assert/strict";
import { World } from "../src/world/world.js";
import type { WorldEvent } from "../src/world/types.js";

const smallWorld = () =>
  new World({
    width: 20,
    height: 10,
    spawn: [5, 5],
    hearingRadius: 3,
    sightRadius: 5,
    maxMessageLength: 50,
    inboxSize: 3,
    zones: [{ name: "plaza", from: [0, 0], to: [9, 9] }],
  });

function join(w: World, id: string, name: string, pos?: readonly [number, number]) {
  const r = w.addAgent(pos ? { id, name, pos } : { id, name });
  assert.ok(r.ok, `join ${name} failed: ${JSON.stringify(r)}`);
  return r.value;
}

// ------------------------------------------------------------------ joining

test("agents spawn on free cells, never on top of each other", () => {
  const w = smallWorld();
  const a = join(w, "a", "Nova");
  const b = join(w, "b", "Orbit");
  assert.deepEqual(a.pos, [5, 5]);
  assert.notDeepEqual(b.pos, a.pos);
});

test("a saved position is restored when free", () => {
  const w = smallWorld();
  assert.deepEqual(join(w, "a", "Nova", [12, 3]).pos, [12, 3]);
});

test("names are validated and unique (case-insensitive)", () => {
  const w = smallWorld();
  join(w, "a", "Nova");
  assert.deepEqual(w.addAgent({ id: "b", name: "nova" }), { ok: false, error: "name_taken" });
  assert.equal(w.addAgent({ id: "c", name: "x" }).ok, false);
  assert.equal(w.addAgent({ id: "d", name: "<script>" }).ok, false);
  assert.equal(w.addAgent({ id: "e", name: "A".repeat(25) }).ok, false);
  assert.equal(w.addAgent({ id: "f", name: "Été-42" }).ok, true);
});

test("the same id cannot connect twice", () => {
  const w = smallWorld();
  join(w, "a", "Nova");
  assert.deepEqual(w.addAgent({ id: "a", name: "Other" }), { ok: false, error: "already_connected" });
});

test("removeAgent returns the last position for persistence", () => {
  const w = smallWorld();
  join(w, "a", "Nova", [7, 7]);
  const r = w.removeAgent("a");
  assert.ok(r.ok);
  assert.deepEqual(r.value.lastPos, [7, 7]);
  assert.equal(w.listAgents().length, 0);
});

// ----------------------------------------------------------------- movement

test("an agent walks one cell per tick and stops on target", () => {
  const w = smallWorld();
  join(w, "a", "Nova", [0, 0]);
  const r = w.moveTo("a", [3, 0]);
  assert.ok(r.ok);
  assert.equal(r.value.steps, 3);
  w.step();
  assert.deepEqual(w.getAgent("a")?.pos, [1, 0]);
  w.step();
  w.step();
  assert.deepEqual(w.getAgent("a")?.pos, [3, 0]);
  assert.equal(w.getAgent("a")?.movingTo, null);
  w.step();
  assert.deepEqual(w.getAgent("a")?.pos, [3, 0]);
});

test("moveTo refuses invalid targets", () => {
  const w = new World({ width: 10, height: 10, spawn: [0, 0], walls: [[5, 5]] });
  join(w, "a", "Nova");
  join(w, "b", "Orbit", [9, 9]);
  assert.equal((w.moveTo("a", [10, 0]) as { error: string }).error, "out_of_bounds");
  assert.equal((w.moveTo("a", [5, 5]) as { error: string }).error, "blocked");
  assert.equal((w.moveTo("a", [9, 9]) as { error: string }).error, "occupied");
  assert.equal((w.moveTo("ghost", [1, 1]) as { error: string }).error, "unknown_agent");
});

test("agents walk around a standing agent", () => {
  const w = smallWorld();
  join(w, "a", "Nova", [0, 0]);
  join(w, "b", "Orbit", [1, 0]);
  assert.ok(w.moveTo("a", [2, 0]).ok);
  for (let i = 0; i < 6; i++) w.step();
  assert.deepEqual(w.getAgent("a")?.pos, [2, 0]);
  assert.deepEqual(w.getAgent("b")?.pos, [1, 0]);
});

test("two agents never share a cell while crossing", () => {
  const w = new World({ width: 10, height: 1, spawn: [0, 0] });
  join(w, "a", "Nova", [0, 0]);
  join(w, "b", "Orbit", [9, 0]);
  w.moveTo("a", [9 - 1, 0]);
  w.moveTo("b", [1, 0]);
  for (let i = 0; i < 30; i++) {
    w.step();
    const [pa, pb] = [w.getAgent("a")!.pos, w.getAgent("b")!.pos];
    assert.notDeepEqual(pa, pb, `collision at tick ${w.tick}`);
  }
});

test("a move is aborted when the destination gets taken", () => {
  const w = smallWorld();
  const events: WorldEvent[] = [];
  w.onEvent((e) => events.push(e));
  join(w, "a", "Nova", [0, 0]);
  join(w, "b", "Orbit", [4, 2]);
  w.moveTo("a", [4, 0]);
  w.moveTo("b", [4, 0]); // b is 2 steps away, a is 4: b arrives first
  for (let i = 0; i < 6; i++) w.step();
  assert.deepEqual(w.getAgent("b")?.pos, [4, 0]);
  assert.ok(events.some((e) => e.type === "move_aborted" && e.id === "a"));
  assert.equal(w.getAgent("a")?.movingTo, null);
});

// --------------------------------------------------------------------- chat

test("local messages reach only agents within hearing radius", () => {
  const w = smallWorld();
  join(w, "a", "Nova", [0, 0]);
  join(w, "b", "Orbit", [3, 0]); // distance 3: hears
  join(w, "c", "Pixel", [3, 1]); // distance 3.16: does not
  const r = w.say("a", "Bonjour !");
  assert.ok(r.ok);
  assert.equal(r.value.heardBy, 1);
  const lookB = w.look("b");
  const lookC = w.look("c");
  assert.ok(lookB.ok && lookC.ok);
  assert.equal(lookB.value.recent_messages.length, 1);
  assert.equal(lookB.value.recent_messages[0]?.untrusted, true);
  assert.equal(lookC.value.recent_messages.length, 0);
});

test("global messages reach everyone", () => {
  const w = smallWorld();
  join(w, "a", "Nova", [0, 0]);
  join(w, "b", "Orbit", [19, 9]);
  const r = w.say("a", "Hello world", "global");
  assert.ok(r.ok);
  assert.equal(r.value.heardBy, 1);
});

test("messages are cleaned, and empty or long ones refused", () => {
  const w = smallWorld();
  join(w, "a", "Nova");
  assert.equal((w.say("a", "   ") as { error: string }).error, "empty_message");
  assert.equal((w.say("a", "x".repeat(51)) as { error: string }).error, "message_too_long");
  assert.ok(w.say("a", "hi\u0000\u0007 there").ok);
  const look = w.look("a");
  assert.ok(look.ok);
  assert.equal(look.value.recent_messages.at(-1)?.text, "hi there");
});

test("the inbox keeps only the last N messages and supports sinceMessageId", () => {
  const w = smallWorld();
  join(w, "a", "Nova");
  for (let i = 1; i <= 5; i++) w.say("a", `msg ${i}`);
  const all = w.look("a");
  assert.ok(all.ok);
  assert.deepEqual(all.value.recent_messages.map((m) => m.text), ["msg 3", "msg 4", "msg 5"]);
  const since = w.look("a", 4);
  assert.ok(since.ok);
  assert.deepEqual(since.value.recent_messages.map((m) => m.text), ["msg 5"]);
});

// --------------------------------------------------------------- perception

test("look returns the contract-shaped perception", () => {
  const w = smallWorld();
  join(w, "a", "Nova", [2, 2]);
  join(w, "b", "Orbit", [4, 2]);
  join(w, "c", "Far", [19, 9]);
  w.moveTo("a", [2, 4]);
  const r = w.look("a");
  assert.ok(r.ok);
  assert.deepEqual(r.value.self, { name: "Nova", pos: [2, 2], moving_to: [2, 4] });
  assert.deepEqual(r.value.nearby_agents, [{ name: "Orbit", pos: [4, 2], distance: 2 }]);
  assert.equal(r.value.zone, "plaza");
  assert.equal(r.value.tick, 0);
});

test("listNearby sorts by distance and honours a custom radius", () => {
  const w = smallWorld();
  join(w, "a", "Nova", [0, 0]);
  join(w, "b", "Orbit", [2, 0]);
  join(w, "c", "Pixel", [1, 0]);
  const r = w.listNearby("a", 1.5);
  assert.ok(r.ok);
  assert.deepEqual(r.value.map((n) => n.name), ["Pixel"]);
});

// ------------------------------------------------------------------- events

test("observers receive events and a failing observer cannot break the world", () => {
  const w = smallWorld();
  const types: string[] = [];
  w.onEvent(() => {
    throw new Error("bad observer");
  });
  const off = w.onEvent((e) => types.push(e.type));
  join(w, "a", "Nova", [0, 0]);
  w.moveTo("a", [1, 0]);
  w.step();
  w.say("a", "hi");
  w.removeAgent("a");
  assert.deepEqual(types, ["agent_joined", "agent_moved", "move_finished", "message", "agent_left"]);
  off();
  join(w, "b", "Orbit");
  assert.equal(types.length, 5);
});
