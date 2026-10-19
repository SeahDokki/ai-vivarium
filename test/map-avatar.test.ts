import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMap } from "../src/world/map.js";
import { OFFICE_MAP } from "../src/world/maps/office.js";
import { DEFAULT_AVATAR, parseAvatar } from "../src/world/avatar.js";
import { World } from "../src/world/world.js";

test("the office map loads with every zone reachable from spawn", () => {
  const map = loadMap(OFFICE_MAP);
  assert.equal(map.width, 40);
  assert.equal(map.height, 21);
  const world = World.fromMap(map);
  assert.ok(world.addAgent({ id: "a", name: "Nova" }).ok);
  for (const zone of world.zoneNames()) {
    const cell = world.freeCellInZone(zone, "a");
    assert.ok(cell.ok, `no free cell in ${zone}`);
    assert.equal(world.zoneAt(cell.value), zone);
    if (zone === "reception") continue; // already there
    assert.ok(world.moveTo("a", cell.value).ok, `${zone} unreachable from spawn`);
  }
});

test("furniture blocks movement, chairs and doors do not", () => {
  const world = World.fromMap(loadMap(OFFICE_MAP));
  assert.equal(world.isWalkable([3, 4]), false); // desk
  assert.equal(world.isWalkable([3, 3]), true); // chair
  assert.equal(world.isWalkable([25, 6]), true); // cafeteria door
  assert.equal(world.isWalkable([0, 0]), false); // wall
});

test("loadMap rejects ragged rows and unknown tiles", () => {
  assert.throws(() => loadMap({ id: "bad", rows: ["...", ".."], spawn: [0, 0], zones: [] }), /row 1/);
  assert.throws(() => loadMap({ id: "bad", rows: [".X."], spawn: [0, 0], zones: [] }), /unknown tile/);
  assert.throws(() => loadMap({ id: "bad", rows: ["#.."], spawn: [0, 0], zones: [] }), /spawn/);
});

test("freeCellInZone reports unknown zones", () => {
  const world = World.fromMap(loadMap(OFFICE_MAP));
  const r = world.freeCellInZone("rooftop");
  assert.equal(r.ok, false);
});

test("mapInfo exposes rows, legend and zones", () => {
  const info = World.fromMap(loadMap(OFFICE_MAP)).mapInfo();
  assert.equal(info.id, "office");
  assert.equal(info.rows.length, 21);
  assert.equal(info.legend["D"], "desk");
  assert.ok(info.zones.some((z) => z.name === "cafeteria"));
});

test("parseAvatar fills defaults and rejects unknown values", () => {
  assert.deepEqual(parseAvatar(undefined), { ok: true, value: DEFAULT_AVATAR });
  const partial = parseAvatar({ character: "character_3", top: "red" });
  assert.ok(partial.ok);
  assert.deepEqual(partial.value, { ...DEFAULT_AVATAR, character: "character_3", top: "red" });
  assert.equal(parseAvatar({ character: "character_9" }).ok, false);
  assert.equal(parseAvatar({ skin: "green" }).ok, false);
  assert.equal(parseAvatar({ bottom: "#ff0000" }).ok, false);
  assert.equal(parseAvatar({ top: "toString" }).ok, false); // no prototype keys
  assert.equal(parseAvatar("blue").ok, false);
});

test("the avatar travels with the agent view", () => {
  const world = World.fromMap(loadMap(OFFICE_MAP));
  const avatar = { character: "character_5" as const, skin: "deep", top: "yellow", bottom: "black" };
  const r = world.addAgent({ id: "a", name: "Nova", avatar });
  assert.ok(r.ok);
  assert.deepEqual(world.getAgent("a")?.avatar, avatar);
});

test("two agents sent to the same zone get different cells", () => {
  const world = World.fromMap(loadMap(OFFICE_MAP));
  world.addAgent({ id: "a", name: "Nova" });
  world.addAgent({ id: "b", name: "Orbit" });
  const ca = world.freeCellInZone("cafeteria", "a");
  assert.ok(ca.ok);
  assert.ok(world.moveTo("a", ca.value).ok);
  const cb = world.freeCellInZone("cafeteria", "b");
  assert.ok(cb.ok);
  assert.notDeepEqual(cb.value, ca.value);
});
