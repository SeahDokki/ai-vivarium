/**
 * Step 1 demo: scripted bots (no AI) wander, meet and talk.
 * Prints an ASCII map and the chat log. Usage: npm run sim [-- --ticks 60 --delay 150 --seed 7]
 */
import { CHARACTERS, CLOTHES_COLORS, SKIN_TONES } from "../world/avatar.js";
import { loadMap } from "../world/map.js";
import { OFFICE_MAP } from "../world/maps/office.js";
import { World } from "../world/world.js";
import type { WorldEvent } from "../world/types.js";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  const v = process.argv[i + 1];
  if (k?.startsWith("--") && v !== undefined) args.set(k.slice(2), v);
}
const TICKS = Number(args.get("ticks") ?? 60);
const DELAY_MS = Number(args.get("delay") ?? 150);
let seed = Number(args.get("seed") ?? 7);

// Small deterministic PRNG (mulberry32) so a run can be replayed with the same seed.
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;

const map = loadMap(OFFICE_MAP);
const world = World.fromMap(map, { hearingRadius: 5, sightRadius: 8 });

const BOTS = ["Nova", "Orbit", "Pixel", "Echo", "Lumen"];
const LINES = [
  "Hello there!",
  "Anyone up for a coffee?",
  "The meeting room is free, I think.",
  "I am mapping the desks, one cell at a time.",
  "Have you read the contract? Rule 2: no flood.",
  "I like this spot.",
];

const chatLog: string[] = [];
world.onEvent((e: WorldEvent) => {
  if (e.type === "message") chatLog.push(`[t${e.tick}] ${e.message.from}: ${e.message.text}`);
  if (e.type === "agent_joined") chatLog.push(`[t${e.tick}] * ${e.agent.name} joined at ${e.agent.pos.join(",")}`);
  if (e.type === "move_aborted") chatLog.push(`[t${e.tick}] * ${e.id} gave up its walk`);
});

BOTS.forEach((name, i) =>
  world.addAgent({
    id: `bot-${i}`,
    name,
    avatar: {
      character: CHARACTERS[i % CHARACTERS.length]!,
      skin: pick(Object.keys(SKIN_TONES)),
      top: pick(Object.keys(CLOTHES_COLORS)),
      bottom: pick(Object.keys(CLOTHES_COLORS)),
    },
  }),
);

/** One decision per bot per tick, the way a real agent would call the tools. */
function think(id: string): void {
  const look = world.look(id);
  if (!look.ok) return;
  const p = look.value;

  // Reply when someone nearby spoke last tick.
  const heard = p.recent_messages.filter((m) => m.tick === world.tick - 1 && m.from !== p.self.name);
  if (heard.length && random() < 0.5) {
    world.say(id, `${heard[0]!.from}, I hear you. ${pick(LINES)}`);
    return;
  }
  // Wander between rooms, the way an agent would call move_to with a zone.
  if (!p.self.moving_to && random() < 0.15) {
    const cell = world.freeCellInZone(pick(world.zoneNames()), id);
    if (cell.ok) world.moveTo(id, cell.value);
  }
  if (p.nearby_agents.length && random() < 0.08) world.say(id, pick(LINES));
}

function render(): string {
  const rows: string[] = [];
  const agents = world.listAgents();
  for (let y = 0; y < world.config.height; y++) {
    let row = "";
    for (let x = 0; x < world.config.width; x++) {
      const a = agents.find((g) => g.pos[0] === x && g.pos[1] === y);
      const tile = map.rows[y]![x]!;
      row += a ? String(BOTS.indexOf(a.name) + 1) : tile === "." ? " " : tile === "#" ? "█" : tile;
    }
    rows.push(row);
  }
  return rows.join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const interactive = process.stdout.isTTY && DELAY_MS > 0;

for (let t = 0; t < TICKS; t++) {
  for (let i = 0; i < BOTS.length; i++) think(`bot-${i}`);
  world.step();
  if (interactive) {
    process.stdout.write("\x1b[2J\x1b[H");
    console.log(`Vivarium — tick ${world.tick}/${TICKS}   (${BOTS.map((b, i) => `${i + 1}=${b}`).join(" ")})\n`);
    console.log(render());
    console.log("\n" + chatLog.slice(-10).join("\n"));
    await sleep(DELAY_MS);
  }
}

if (!interactive) {
  console.log(render());
  console.log("\n" + chatLog.join("\n"));
}
console.log(`\nDone: ${world.tick} ticks, ${chatLog.filter((l) => !l.includes("] *")).length} messages.`);
