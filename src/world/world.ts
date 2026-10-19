import { DEFAULT_AVATAR, type Avatar } from "./avatar.js";
import { Grid, distance, samePos } from "./grid.js";
import { TILE_LEGEND, type LoadedMap } from "./map.js";
import type {
  AgentId,
  AgentView,
  ChatMessage,
  Failure,
  MessageScope,
  NearbyAgent,
  Perception,
  Position,
  Result,
  WorldConfig,
  WorldErrorCode,
  WorldEvent,
} from "./types.js";

/** A blocked agent waits this many ticks for the way to clear before its move is aborted. */
const MAX_WAIT_TICKS = 10;
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _-]{1,23}$/u;

/** 2-24 characters: letters, digits, space, _ or -, starting with a letter or digit. */
export function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name.trim());
}
// Control characters except tab and newline.
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

interface AgentState {
  readonly id: AgentId;
  readonly name: string;
  readonly avatar: Avatar;
  pos: Position;
  /** Remaining steps, next step first. Empty when idle. */
  path: Position[];
  target: Position | null;
  waitTicks: number;
  inbox: ChatMessage[];
}

export interface JoinOptions {
  readonly id: AgentId;
  readonly name: string;
  /** Already validated (see parseAvatar). Defaults to DEFAULT_AVATAR. */
  readonly avatar?: Avatar;
  /** A saved position to restore. */
  readonly pos?: Position;
}

export interface MapInfo {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly rows: readonly string[];
  readonly zones: readonly { readonly name: string; readonly from: Position; readonly to: Position }[];
}

const fail = (error: WorldErrorCode, detail?: string): Failure =>
  detail === undefined ? { ok: false, error } : { ok: false, error, detail };

export const DEFAULT_CONFIG: WorldConfig = {
  width: 40,
  height: 25,
  spawn: [20, 12],
  hearingRadius: 6,
  sightRadius: 10,
  maxMessageLength: 500,
  inboxSize: 20,
};

/**
 * The world engine: pure state, no network, no timers.
 * Time only moves when `tick()` is called (see TickLoop for the real-time driver).
 */
export class World {
  readonly config: WorldConfig;
  private readonly grid: Grid;
  private readonly agents = new Map<AgentId, AgentState>();
  private readonly listeners = new Set<(e: WorldEvent) => void>();
  private currentTick = 0;
  private nextMessageId = 1;
  private readonly map: LoadedMap | null;

  /** Build a world on a tile map (walls, zones and spawn come from the map). */
  static fromMap(map: LoadedMap, overrides: Partial<Omit<WorldConfig, "width" | "height" | "walls" | "zones">> = {}): World {
    return new World(
      { ...overrides, width: map.width, height: map.height, walls: map.walls, zones: map.zones, spawn: overrides.spawn ?? map.spawn },
      map,
    );
  }

  constructor(config: Partial<WorldConfig> = {}, map: LoadedMap | null = null) {
    this.map = map;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.grid = new Grid(this.config.width, this.config.height, this.config.walls ?? []);
    if (!this.grid.isWalkable(this.config.spawn)) {
      throw new Error(`Spawn ${JSON.stringify(this.config.spawn)} is not walkable`);
    }
  }

  get tick(): number {
    return this.currentTick;
  }

  // ---------------------------------------------------------------- observers

  /** Subscribe to world events. Returns an unsubscribe function. */
  onEvent(listener: (e: WorldEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: WorldEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // An observer must never break the simulation.
      }
    }
  }

  // ------------------------------------------------------------ join / leave

  /**
   * Put an agent in the world. `pos` restores a saved position; if missing,
   * occupied or invalid, the agent appears at the free cell nearest to spawn.
   */
  addAgent({ id, name, avatar = DEFAULT_AVATAR, pos }: JoinOptions): Result<AgentView> {
    if (this.agents.has(id)) return fail("already_connected");
    const cleanName = name.trim();
    if (!NAME_PATTERN.test(cleanName)) {
      return fail("invalid_name", "2-24 chars: letters, digits, space, _ or -, starting with a letter or digit");
    }
    const lower = cleanName.toLocaleLowerCase();
    for (const a of this.agents.values()) {
      if (a.name.toLocaleLowerCase() === lower) return fail("name_taken");
    }

    const isFree = (p: Position) => !this.agentAt(p);
    const wanted = pos && this.grid.isWalkable(pos) && isFree(pos) ? pos : null;
    const start = wanted ?? this.grid.nearestFree(this.config.spawn, isFree);
    if (!start) return fail("world_full");

    const agent: AgentState = { id, name: cleanName, avatar, pos: start, path: [], target: null, waitTicks: 0, inbox: [] };
    this.agents.set(id, agent);
    const view = this.view(agent);
    this.emit({ type: "agent_joined", tick: this.currentTick, agent: view });
    return { ok: true, value: view };
  }

  removeAgent(id: AgentId): Result<{ readonly lastPos: Position }> {
    const agent = this.agents.get(id);
    if (!agent) return fail("unknown_agent");
    this.agents.delete(id);
    this.emit({ type: "agent_left", tick: this.currentTick, id });
    return { ok: true, value: { lastPos: agent.pos } };
  }

  // ------------------------------------------------------------------ actions

  /** Plan a walk to `target`. The agent advances one cell per tick. */
  moveTo(id: AgentId, target: Position): Result<{ readonly steps: number }> {
    const agent = this.agents.get(id);
    if (!agent) return fail("unknown_agent");
    if (!this.grid.inBounds(target)) return fail("out_of_bounds");
    if (this.grid.isWall(target)) return fail("blocked");
    const occupant = this.agentAt(target);
    if (occupant && occupant !== agent) return fail("occupied", `${occupant.name} is standing there`);

    // Prefer a path around other agents; fall back to one through them (they may move away).
    const path =
      this.grid.findPath(agent.pos, target, (p) => this.agentAt(p) !== undefined) ??
      this.grid.findPath(agent.pos, target);
    if (!path) return fail("unreachable");

    agent.path = path;
    agent.target = path.length ? target : null;
    agent.waitTicks = 0;
    return { ok: true, value: { steps: path.length } };
  }

  /** Stop walking where the agent stands. */
  stop(id: AgentId): Result {
    const agent = this.agents.get(id);
    if (!agent) return fail("unknown_agent");
    agent.path = [];
    agent.target = null;
    return { ok: true };
  }

  say(id: AgentId, rawText: string, scope: MessageScope = "local"): Result<{ readonly id: number; readonly heardBy: number }> {
    const agent = this.agents.get(id);
    if (!agent) return fail("unknown_agent");
    const text = rawText.replace(CONTROL_CHARS, "").trim();
    if (!text) return fail("empty_message");
    if (text.length > this.config.maxMessageLength) {
      return fail("message_too_long", `max ${this.config.maxMessageLength} characters`);
    }

    const message: ChatMessage = {
      id: this.nextMessageId++,
      tick: this.currentTick,
      from: agent.name,
      fromId: agent.id,
      scope,
      text,
      pos: agent.pos,
    };

    const recipients: AgentId[] = [];
    for (const listener of this.agents.values()) {
      const hears = scope === "global" || distance(listener.pos, agent.pos) <= this.config.hearingRadius;
      if (!hears) continue;
      listener.inbox.push(message);
      if (listener.inbox.length > this.config.inboxSize) listener.inbox.shift();
      if (listener !== agent) recipients.push(listener.id);
    }
    this.emit({ type: "message", tick: this.currentTick, message, recipients });
    return { ok: true, value: { id: message.id, heardBy: recipients.length } };
  }

  // --------------------------------------------------------------- perception

  /** Agents within `radius` of the caller (default: sight radius), nearest first, caller excluded. */
  listNearby(id: AgentId, radius = this.config.sightRadius): Result<readonly NearbyAgent[]> {
    const agent = this.agents.get(id);
    if (!agent) return fail("unknown_agent");
    const out: NearbyAgent[] = [];
    for (const other of this.agents.values()) {
      if (other === agent) continue;
      const d = distance(agent.pos, other.pos);
      if (d <= radius) out.push({ name: other.name, pos: other.pos, distance: Math.round(d * 100) / 100 });
    }
    out.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
    return { ok: true, value: out };
  }

  /** The full perception an agent gets. `sinceMessageId` keeps only newer messages. */
  look(id: AgentId, sinceMessageId = 0): Result<Perception> {
    const agent = this.agents.get(id);
    if (!agent) return fail("unknown_agent");
    const nearby = this.listNearby(id);
    const perception: Perception = {
      self: { name: agent.name, pos: agent.pos, moving_to: agent.target },
      nearby_agents: nearby.ok ? nearby.value : [],
      recent_messages: agent.inbox
        .filter((m) => m.id > sinceMessageId)
        .map((m) => ({ id: m.id, tick: m.tick, from: m.from, scope: m.scope, text: m.text, untrusted: true as const })),
      zone: this.zoneAt(agent.pos),
      tick: this.currentTick,
    };
    return { ok: true, value: perception };
  }

  zoneAt([x, y]: Position): string | null {
    for (const z of this.config.zones ?? []) {
      const [x1, x2] = [Math.min(z.from[0], z.to[0]), Math.max(z.from[0], z.to[0])];
      const [y1, y2] = [Math.min(z.from[1], z.to[1]), Math.max(z.from[1], z.to[1])];
      if (x >= x1 && x <= x2 && y >= y1 && y <= y2) return z.name;
    }
    return null;
  }

  /** Names of the zones, in map order. */
  zoneNames(): string[] {
    return (this.config.zones ?? []).map((z) => z.name);
  }

  /**
   * A free walkable cell inside `zoneName`, nearest to the zone centre.
   * Used by "move_to a zone" so agents can say "go to the cafeteria" without coordinates.
   */
  freeCellInZone(zoneName: string, forAgent?: AgentId): Result<Position> {
    const zone = (this.config.zones ?? []).find((z) => z.name === zoneName);
    if (!zone) return fail("unknown_zone", `zones: ${this.zoneNames().join(", ")}`);
    const self = forAgent ? this.agents.get(forAgent) : undefined;
    // An agent already inside the zone stays where it is.
    if (self && this.zoneAt(self.pos) === zoneName) return { ok: true, value: self.pos };
    const centre: Position = [Math.round((zone.from[0] + zone.to[0]) / 2), Math.round((zone.from[1] + zone.to[1]) / 2)];
    // Skip cells another agent stands on or is already walking to.
    const cell = this.grid.nearestFree(
      centre,
      (p) => this.zoneAt(p) === zoneName && !this.agentAt(p) && !this.isTargeted(p, forAgent),
    );
    if (!cell || this.zoneAt(cell) !== zoneName) return fail("zone_full");
    return { ok: true, value: cell };
  }

  /** Static description of the map, sent to agents once. */
  mapInfo(): MapInfo {
    return {
      id: this.map?.id ?? "custom",
      width: this.config.width,
      height: this.config.height,
      legend: this.map ? { ...TILE_LEGEND } : { "#": "wall", ".": "floor" },
      rows: this.map?.rows ?? this.asciiRows(),
      zones: (this.config.zones ?? []).map((z) => ({ name: z.name, from: z.from, to: z.to })),
    };
  }

  private asciiRows(): string[] {
    const rows: string[] = [];
    for (let y = 0; y < this.config.height; y++) {
      let row = "";
      for (let x = 0; x < this.config.width; x++) row += this.grid.isWall([x, y]) ? "#" : ".";
      rows.push(row);
    }
    return rows;
  }

  /** Every agent, for spectators. */
  listAgents(): AgentView[] {
    return [...this.agents.values()].map((a) => this.view(a));
  }

  getAgent(id: AgentId): AgentView | undefined {
    const a = this.agents.get(id);
    return a ? this.view(a) : undefined;
  }

  isWalkable(p: Position): boolean {
    return this.grid.isWalkable(p);
  }

  // --------------------------------------------------------------------- time

  /** Advance the world by one tick: every walking agent takes at most one step. */
  step(): void {
    this.currentTick++;
    // Join order keeps the simulation deterministic.
    for (const agent of this.agents.values()) {
      const next = agent.path[0];
      if (!next || !agent.target) continue;

      if (this.agentAt(next)) {
        this.handleBlocked(agent);
        continue;
      }

      agent.path.shift();
      agent.pos = next;
      agent.waitTicks = 0;
      this.emit({ type: "agent_moved", tick: this.currentTick, id: agent.id, pos: next });
      if (agent.path.length === 0) {
        agent.target = null;
        this.emit({ type: "move_finished", tick: this.currentTick, id: agent.id, pos: next });
      }
    }
  }

  private handleBlocked(agent: AgentState): void {
    const target = agent.target!;
    const occupant = this.agentAt(target);
    // Someone settled on the destination: no point waiting.
    if (occupant && occupant !== agent && occupant.path.length === 0) {
      this.abortMove(agent);
      return;
    }
    const detour = this.grid.findPath(agent.pos, target, (p) => this.agentAt(p) !== undefined);
    if (detour && detour.length > 0 && !this.agentAt(detour[0]!)) {
      agent.path = detour;
      // The detour is taken on the next tick; this tick is spent re-planning.
    }
    agent.waitTicks++;
    if (agent.waitTicks > MAX_WAIT_TICKS) this.abortMove(agent);
  }

  private abortMove(agent: AgentState): void {
    agent.path = [];
    agent.target = null;
    agent.waitTicks = 0;
    this.emit({ type: "move_aborted", tick: this.currentTick, id: agent.id, pos: agent.pos });
  }

  // ------------------------------------------------------------------ helpers

  private isTargeted(p: Position, except?: AgentId): boolean {
    for (const a of this.agents.values()) if (a.id !== except && a.target && samePos(a.target, p)) return true;
    return false;
  }

  private agentAt(p: Position): AgentState | undefined {
    for (const a of this.agents.values()) if (samePos(a.pos, p)) return a;
    return undefined;
  }

  private view(a: AgentState): AgentView {
    return { id: a.id, name: a.name, avatar: a.avatar, pos: a.pos, movingTo: a.target };
  }
}
