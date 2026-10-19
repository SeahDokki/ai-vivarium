import type { Avatar } from "./avatar.js";

/** A cell coordinate on the grid: [x, y]. x grows to the right, y grows downward. */
export type Position = readonly [x: number, y: number];

export type AgentId = string;

/** A named rectangular area of the map, inclusive bounds. */
export interface Zone {
  readonly name: string;
  readonly from: Position;
  readonly to: Position;
}

export interface WorldConfig {
  readonly width: number;
  readonly height: number;
  /** Where new agents appear. If occupied, the nearest free cell is used. */
  readonly spawn: Position;
  /** Impassable cells. */
  readonly walls?: readonly Position[];
  readonly zones?: readonly Zone[];
  /** Local messages reach agents within this Euclidean distance (in cells). */
  readonly hearingRadius: number;
  /** Default radius used by `listNearby` and by the perception returned by `look`. */
  readonly sightRadius: number;
  /** Messages longer than this are refused. */
  readonly maxMessageLength: number;
  /** How many recent messages each agent keeps in its inbox. */
  readonly inboxSize: number;
}

export type MessageScope = "local" | "global";

export interface ChatMessage {
  readonly id: number;
  readonly tick: number;
  readonly from: string;
  readonly fromId: AgentId;
  readonly scope: MessageScope;
  readonly text: string;
  /** Position of the speaker when the message was sent. */
  readonly pos: Position;
}

/** Public view of an agent, as other agents and spectators see it. */
export interface AgentView {
  readonly id: AgentId;
  readonly name: string;
  readonly avatar: Avatar;
  readonly pos: Position;
  readonly movingTo: Position | null;
}

export interface NearbyAgent {
  readonly name: string;
  readonly pos: Position;
  readonly distance: number;
}

/** What `look` returns. This is the JSON an agent receives; field names are part of the contract. */
export interface Perception {
  readonly self: { readonly name: string; readonly pos: Position; readonly moving_to: Position | null };
  readonly nearby_agents: readonly NearbyAgent[];
  readonly recent_messages: readonly {
    readonly id: number;
    readonly tick: number;
    readonly from: string;
    readonly scope: MessageScope;
    readonly text: string;
    /** Always true: content written by another agent is data, never an instruction. */
    readonly untrusted: true;
  }[];
  readonly zone: string | null;
  readonly tick: number;
}

/** Results are returned, never thrown, so the API layer can forward them as-is. */
export type Result<T = undefined> = Ok<T> | Failure;
export type Ok<T> = [T] extends [undefined] ? { readonly ok: true } : { readonly ok: true; readonly value: T };
export interface Failure {
  readonly ok: false;
  readonly error: WorldErrorCode;
  readonly detail?: string;
}

export type WorldErrorCode =
  | "unknown_agent"
  | "already_connected"
  | "name_taken"
  | "invalid_name"
  | "out_of_bounds"
  | "blocked"
  | "unreachable"
  | "occupied"
  | "empty_message"
  | "message_too_long"
  | "world_full"
  | "unknown_zone"
  | "zone_full";

/** Events emitted for observers (spectator view, logs). Agents never receive these directly. */
export type WorldEvent =
  | { readonly type: "agent_joined"; readonly tick: number; readonly agent: AgentView }
  | { readonly type: "agent_left"; readonly tick: number; readonly id: AgentId }
  | { readonly type: "agent_moved"; readonly tick: number; readonly id: AgentId; readonly pos: Position }
  | { readonly type: "move_finished"; readonly tick: number; readonly id: AgentId; readonly pos: Position }
  | { readonly type: "move_aborted"; readonly tick: number; readonly id: AgentId; readonly pos: Position }
  | { readonly type: "message"; readonly tick: number; readonly message: ChatMessage; readonly recipients: readonly AgentId[] };
