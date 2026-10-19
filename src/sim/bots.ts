import { CHARACTERS, CLOTHES_COLORS, SKIN_TONES } from "../world/avatar.js";
import type { World } from "../world/world.js";

/** Small deterministic PRNG (mulberry32), so a run can be replayed with the same seed. */
export function makeRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["Nova", "Orbit", "Pixel", "Echo", "Lumen", "Quartz", "Tango", "Zephyr", "Iris", "Bolt"];
const LINES = [
  "Hello there!",
  "Anyone up for a coffee?",
  "The meeting room is free, I think.",
  "I am mapping the desks, one cell at a time.",
  "Have you read the contract? Rule 2: no flood.",
  "I like this spot.",
  "Who left the whiteboard full of diagrams?",
  "The sofa in the lounge is surprisingly comfy.",
];

/**
 * Scripted agents with no AI, acting on the world directly (not over the network).
 * They exist so the spectator page has something to show during development.
 */
export class BotCrowd {
  private readonly random: () => number;
  private readonly ids: string[] = [];

  constructor(
    private readonly world: World,
    count: number,
    seed = 7,
    /** Lets the caller keep names that belong to registered agents free. */
    isNameFree: (name: string) => boolean = () => true,
  ) {
    this.random = makeRandom(seed);
    const names = NAMES.filter(isNameFree);
    for (let i = 0; i < Math.min(count, names.length); i++) {
      const id = `bot-${i}`;
      const r = world.addAgent({
        id,
        name: names[i]!,
        avatar: {
          character: CHARACTERS[i % CHARACTERS.length]!,
          skin: this.pick(Object.keys(SKIN_TONES)),
          top: this.pick(Object.keys(CLOTHES_COLORS)),
          bottom: this.pick(Object.keys(CLOTHES_COLORS)),
        },
      });
      if (r.ok) this.ids.push(id);
    }
  }

  get names(): string[] {
    return this.ids.map((id) => this.world.getAgent(id)?.name ?? id);
  }

  /** One decision per bot, the way a real agent would call the tools. Call once per tick. */
  think(chattiness = 1): void {
    for (const id of this.ids) {
      const look = this.world.look(id);
      if (!look.ok) continue;
      const p = look.value;

      const heard = p.recent_messages.filter((m) => m.tick === this.world.tick - 1 && m.from !== p.self.name);
      if (heard.length && this.random() < 0.35 * chattiness) {
        this.world.say(id, `${heard[0]!.from}, I hear you. ${this.pick(LINES)}`);
        continue;
      }
      if (!p.self.moving_to && this.random() < 0.06) {
        const cell = this.world.freeCellInZone(this.pick(this.world.zoneNames()), id);
        if (cell.ok) this.world.moveTo(id, cell.value);
      }
      if (p.nearby_agents.length && this.random() < 0.02 * chattiness) this.world.say(id, this.pick(LINES));
    }
  }

  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.random() * xs.length)]!;
  }
}
