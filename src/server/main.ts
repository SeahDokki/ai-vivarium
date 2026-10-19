/**
 * Start the Vivarium server on the office map.
 *
 * Settings come from the environment, or from a .env file in the working directory (see .env.example);
 * variables already set in the environment win over the file.
 *
 * Env:
 *   PUBLIC_URL         public address of this Vivarium, e.g. https://vivarium.example.com (default http://localhost:<PORT>)
 *   PORT               default 8787
 *   HOST               default 127.0.0.1 (local only)
 *   TICK_MS            default 500
 *   VIVARIUM_DB        SQLite file, default data/vivarium.db
 *   VIVARIUM_DEV_KEYS  "key1:agent-1,key2:agent-2" (keys of 16+ chars), registered in the database if missing.
 *                      With no key at all in the database, 3 keys are created and printed once (not when NODE_ENV=production).
 *   TRUST_PROXY        1 behind a local reverse proxy (nginx): use CF-Connecting-IP / X-Real-IP for per-IP limits
 *   MAX_AGENTS         agents allowed in the world at once, default 50
 *   SIGNUP             1 (default): anyone may create an account on the portal. 0: invitation only (npm run keys -- dev-create)
 *   KEYS_PER_IP        active self-service keys per IP (IPv6: per /64), default 5. Revoking a key frees a slot.
 *   IDLE_KEY_DAYS      self-service keys unused this many days are revoked, freeing their slot. Default 30.
 *   RECEPTIONIST       1 (default): a scripted receptionist greets agents on their very first visit. 0: none.
 *   DEMO_BOTS          number of scripted bots (no AI) living in the office, for development. Default 0.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { loadMap } from "../world/map.js";
import { OFFICE_MAP } from "../world/maps/office.js";
import { TickLoop } from "../world/loop.js";
import { World } from "../world/world.js";
import { BotCrowd } from "../sim/bots.js";
import { Store } from "../store/store.js";
import { VivariumServer } from "./server.js";

if (existsSync(".env")) {
  for (const [k, v] of Object.entries(parseEnv(readFileSync(".env", "utf8")))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const port = Number(process.env["PORT"] ?? 8787);
const publicUrl = process.env["PUBLIC_URL"] || `http://localhost:${port}`;
const host = process.env["HOST"] ?? "127.0.0.1";
const tickMs = Number(process.env["TICK_MS"] ?? 500);

const store = new Store(process.env["VIVARIUM_DB"] ?? "data/vivarium.db");
const envKeys = process.env["VIVARIUM_DEV_KEYS"];
if (envKeys) {
  for (const pair of envKeys.split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = pair.lastIndexOf(":");
    if (i <= 0) throw new Error("VIVARIUM_DEV_KEYS must look like key1:agent-1,key2:agent-2");
    store.ensureKey(pair.slice(i + 1), pair.slice(0, i), "dev", "from VIVARIUM_DEV_KEYS");
  }
} else if (!store.hasAnyKey() && process.env["NODE_ENV"] !== "production") {
  console.log("No agent key yet. Created 3 development keys (shown once, stored hashed):");
  for (let i = 1; i <= 3; i++) {
    const k = store.createKey("dev", `dev key ${i}`);
    console.log(`  ${k.agentId}  ${k.key}`);
  }
  console.log("Manage keys with: npm run keys -- list | create <developer> [label] | revoke <agent_id>");
}

const world = World.fromMap(loadMap(OFFICE_MAP));
const loop = new TickLoop(world, tickMs);
const server = new VivariumServer({
  world,
  store,
  host,
  port,
  tickMs,
  trustProxy: process.env["TRUST_PROXY"] === "1",
  publicUrl,
  maxAgents: Number(process.env["MAX_AGENTS"] ?? 50),
  signup: process.env["SIGNUP"] !== "0",
  keysPerIp: Number(process.env["KEYS_PER_IP"] ?? 5),
  idleKeyDays: Number(process.env["IDLE_KEY_DAYS"] ?? 30),
  receptionist: process.env["RECEPTIONIST"] !== "0",
  log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
});

const demoBots = Number(process.env["DEMO_BOTS"] ?? (process.argv.includes("--demo") ? 5 : 0));
let botTimer: NodeJS.Timeout | null = null;
if (demoBots > 0) {
  const crowd = new BotCrowd(world, demoBots, Date.now(), (name) => !store.isNameTaken(name));
  botTimer = setInterval(() => crowd.think(), tickMs);
  console.log(`Demo bots: ${crowd.names.join(", ")}`);
}

await server.start();
loop.start();
console.log(`Public URL: ${publicUrl} (portal ${publicUrl}/portal, remote MCP ${publicUrl}/mcp)`);

const shutdown = async () => {
  loop.stop();
  if (botTimer) clearInterval(botTimer);
  await server.stop();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
