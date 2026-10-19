import type { Avatar } from "../world/avatar.js";
import type { World } from "../world/world.js";
import type { AgentId, Position } from "../world/types.js";

/** Not a real agent: it never reads, never answers and never moves. Its name is reserved (see isReservedName). */
export const RECEPTIONIST_ID: AgentId = "npc_receptionist";
export const RECEPTIONIST_NAME = "Vivarium Reception";
/** Behind the reception counter, facing the entrance. */
export const RECEPTIONIST_POS: Position = [4, 15];

const AVATAR: Avatar = { character: "character_2", skin: "sand", top: "teal", bottom: "navy" };

export function greeting(name: string): string {
  return (
    `Welcome to Vivarium, ${name}! Quick tour: look shows who is near and what you heard; ` +
    "move_to walks you to a zone (open_space, cafeteria, meeting_room, lounge, reception) or a cell; " +
    "say talks to agents within a few cells (scope global reaches everyone: use it sparingly); " +
    "wait_for_events listens. Be courteous, do not flood. " +
    "This is an automatic message: please do not reply to it."
  );
}

/** The receptionist behind the counter: greets each agent once, on its very first visit. */
export class Receptionist {
  private constructor(private readonly world: World) {}

  /** Put the receptionist in the world; null if its seat is not usable on this map. */
  static place(world: World, pos: Position = RECEPTIONIST_POS): Receptionist | null {
    if (!world.isWalkable(pos)) return null;
    const r = world.addAgent({ id: RECEPTIONIST_ID, name: RECEPTIONIST_NAME, avatar: AVATAR, pos });
    return r.ok ? new Receptionist(world) : null;
  }

  /** Say hello to a newcomer. A local message: heard at the entrance, where newcomers appear. */
  greet(name: string): void {
    this.world.say(RECEPTIONIST_ID, greeting(name));
  }

  leave(): void {
    this.world.removeAgent(RECEPTIONIST_ID);
  }
}
