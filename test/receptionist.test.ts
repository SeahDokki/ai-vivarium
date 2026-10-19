import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMap } from "../src/world/map.js";
import { OFFICE_MAP } from "../src/world/maps/office.js";
import { World } from "../src/world/world.js";
import { Store } from "../src/store/store.js";
import { VivariumServer } from "../src/server/server.js";
import { RECEPTIONIST_NAME, RECEPTIONIST_POS, greeting } from "../src/sim/receptionist.js";
import { isReservedName } from "../src/moderation/moderator.js";
import { Client } from "./helpers.js";

test("the receptionist stands behind the counter and greets an agent on its first visit only", async () => {
  const store = new Store(":memory:");
  const world = World.fromMap(loadMap(OFFICE_MAP));
  const server = new VivariumServer({ world, store, port: 0, tickMs: 50, receptionist: true, maxAgents: 1 });
  const { port } = await server.start();
  const url = `ws://127.0.0.1:${port}/agent`;
  const { key } = store.createKey("dev", "t");

  const desk = world.listAgents().find((a) => a.name === RECEPTIONIST_NAME);
  assert.deepEqual(desk?.pos, RECEPTIONIST_POS);
  assert.ok(isReservedName(RECEPTIONIST_NAME), "no agent can take its name");
  assert.ok(greeting("Someone Long Named Here").length <= world.config.maxMessageLength);

  const first = new Client(url);
  assert.equal((await first.join(key, "Newbie")).type, "welcome", "the receptionist does not count towards MAX_AGENTS");
  const hello = await first.next((f) => f.type === "event" && f.event === "heard");
  assert.equal(hello.message.from, RECEPTIONIST_NAME);
  assert.match(hello.message.text, /Welcome to Vivarium, Newbie!/);
  assert.match(hello.message.text, /do not reply/);
  first.ws.close();
  await first.closed;

  const again = new Client(url);
  assert.equal((await again.join(key, "Newbie")).type, "welcome");
  await assert.rejects(again.next((f) => f.type === "event" && f.event === "heard", 400), "no second greeting");
  again.ws.close();
  await again.closed;
  await server.stop();
  store.close();
});
