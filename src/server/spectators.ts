import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { CLOTHES_COLORS, SKIN_TONES } from "../world/avatar.js";
import type { World } from "../world/world.js";
import type { WorldEvent } from "../world/types.js";

/**
 * The human side: a read-only stream of the world, plus a chat between humans.
 * Nothing here ever reaches an agent — the hub only reads the world, it has no way to write to it.
 */

export const SPECTATOR_LIMITS = {
  maxFrameBytes: 2 * 1024,
  maxSpectators: 500,
  nickMin: 2,
  nickMax: 20,
  textMax: 300,
  /** Token bucket: a burst of 5 messages, then one every 3 s. */
  burst: 5,
  refillMs: 3000,
  historySize: 50,
} as const;

const NICK_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g;

export interface HumanMessage {
  readonly nick: string;
  readonly text: string;
  readonly at: string;
}

interface AgentChatEntry {
  readonly id: number;
  readonly tick: number;
  readonly from: string;
  readonly scope: string;
  readonly text: string;
  readonly zone: string | null;
  /** Public id of the speaker. */
  readonly speaker: string;
  /** Public ids of every agent that heard it, speaker included: lets a spectator follow one agent's ears. */
  readonly heard_by: string[];
}

interface Viewer {
  readonly socket: WebSocket;
  tokens: number;
  lastRefill: number;
  lastText: string;
}

export interface SpectatorHubOptions {
  readonly world: World;
  readonly tickMs: number;
  readonly log?: (line: string) => void;
  /** Injected for tests. */
  readonly now?: () => number;
}

export class SpectatorHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: SPECTATOR_LIMITS.maxFrameBytes });
  private readonly viewers = new Set<Viewer>();
  private readonly agentChat: AgentChatEntry[] = [];
  private readonly humanChat: HumanMessage[] = [];
  private readonly moderation: { action: string; name: string; reason: string; until: string; at: string }[] = [];
  private readonly unsubscribe: () => void;
  private readonly now: () => number;
  private readonly publicIds = new Map<string, string>();
  private nextPublicId = 1;

  constructor(private readonly opts: SpectatorHubOptions) {
    this.now = opts.now ?? Date.now;
    this.unsubscribe = opts.world.onEvent((e) => this.onWorldEvent(e));
    this.wss.on("connection", (socket) => this.onConnection(socket));
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    if (this.viewers.size >= SPECTATOR_LIMITS.maxSpectators) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }

  async stop(): Promise<void> {
    this.unsubscribe();
    for (const v of this.viewers) v.socket.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  // ------------------------------------------------------------- connection

  private onConnection(socket: WebSocket): void {
    const viewer: Viewer = { socket, tokens: SPECTATOR_LIMITS.burst, lastRefill: this.now(), lastText: "" };
    this.viewers.add(viewer);
    const world = this.opts.world;
    send(socket, {
      type: "snapshot",
      tick: world.tick,
      tick_ms: this.opts.tickMs,
      map: world.mapInfo(),
      sight_radius: world.config.sightRadius,
      hearing_radius: world.config.hearingRadius,
      palette: { skin: SKIN_TONES, clothes: CLOTHES_COLORS },
      agents: world.listAgents().map((a) => this.publicAgent(a)),
      agent_chat: this.agentChat,
      human_chat: this.humanChat,
      moderation: this.moderation,
      viewers: this.viewers.size,
    });
    this.broadcast({ type: "viewers", count: this.viewers.size });

    socket.on("message", (data, isBinary) => {
      if (isBinary) return socket.close(1003, "text only");
      this.onFrame(viewer, rawToString(data));
    });
    socket.on("close", () => {
      this.viewers.delete(viewer);
      this.broadcast({ type: "viewers", count: this.viewers.size });
    });
    socket.on("error", () => socket.terminate());
  }

  private onFrame(viewer: Viewer, raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return send(viewer.socket, { type: "chat_error", error: "invalid_json" });
    }
    if (typeof frame !== "object" || frame === null || (frame as Record<string, unknown>)["type"] !== "chat") {
      return send(viewer.socket, { type: "chat_error", error: "unknown_frame" });
    }
    const f = frame as Record<string, unknown>;
    const checked = checkHumanMessage(f["nick"], f["text"]);
    if (!checked.ok) return send(viewer.socket, { type: "chat_error", error: checked.error });

    if (!this.takeToken(viewer)) return send(viewer.socket, { type: "chat_error", error: "slow_down" });
    if (checked.text === viewer.lastText) return send(viewer.socket, { type: "chat_error", error: "duplicate" });
    viewer.lastText = checked.text;

    const message: HumanMessage = { nick: checked.nick, text: checked.text, at: new Date(this.now()).toISOString() };
    pushCapped(this.humanChat, message);
    this.broadcast({ type: "human_chat", message });
  }

  private takeToken(v: Viewer): boolean {
    const now = this.now();
    const refills = Math.floor((now - v.lastRefill) / SPECTATOR_LIMITS.refillMs);
    if (refills > 0) {
      v.tokens = Math.min(SPECTATOR_LIMITS.burst, v.tokens + refills);
      v.lastRefill += refills * SPECTATOR_LIMITS.refillMs;
    }
    if (v.tokens <= 0) return false;
    v.tokens--;
    return true;
  }

  // ------------------------------------------------------------ world events

  private onWorldEvent(e: WorldEvent): void {
    switch (e.type) {
      case "agent_joined":
        return this.broadcast({ type: "agent_joined", tick: e.tick, agent: this.publicAgent(e.agent) });
      case "agent_left":
        return this.broadcast({ type: "agent_left", tick: e.tick, id: this.publicId(e.id) });
      case "agent_moved":
        return this.broadcast({ type: "agent_moved", tick: e.tick, id: this.publicId(e.id), pos: e.pos });
      case "message": {
        const m = e.message;
        const entry: AgentChatEntry = {
          id: m.id,
          tick: m.tick,
          from: m.from,
          scope: m.scope,
          text: m.text,
          zone: this.opts.world.zoneAt(m.pos),
          speaker: this.publicId(m.fromId),
          heard_by: [m.fromId, ...e.recipients].map((id) => this.publicId(id)),
        };
        pushCapped(this.agentChat, entry);
        return this.broadcast({ type: "agent_chat", message: entry });
      }
      default:
        return;
    }
  }

  /**
   * Agent ids are tied to developer keys; spectators get an opaque handle instead,
   * so an id never leaks to the public page.
   */
  private publicId(agentId: string): string {
    let id = this.publicIds.get(agentId);
    if (!id) {
      id = `a${this.nextPublicId++}`;
      this.publicIds.set(agentId, id);
    }
    return id;
  }

  private publicAgent(a: { id: string; name: string; avatar: unknown; pos: readonly number[] }) {
    return { id: this.publicId(a.id), name: a.name, avatar: a.avatar, pos: a.pos };
  }

  /** A sanction, shown on the page so moderation is visible. */
  notice(n: { action: "muted" | "kicked"; name: string; reason: string; until: string }): void {
    const entry = { ...n, at: new Date(this.now()).toISOString() };
    pushCapped(this.moderation, entry);
    this.broadcast({ type: "moderation", notice: entry });
  }

  private broadcast(payload: unknown): void {
    if (this.viewers.size === 0) return;
    const data = JSON.stringify(payload);
    for (const v of this.viewers) if (v.socket.readyState === WebSocket.OPEN) v.socket.send(data);
  }
}

// ------------------------------------------------------------------ helpers

export function checkHumanMessage(
  nick: unknown,
  text: unknown,
): { ok: true; nick: string; text: string } | { ok: false; error: string } {
  if (typeof nick !== "string" || typeof text !== "string") return { ok: false, error: "invalid_message" };
  const n = nick.replace(CONTROL_CHARS, "").trim();
  const t = text.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  if (n.length < SPECTATOR_LIMITS.nickMin || n.length > SPECTATOR_LIMITS.nickMax || !NICK_PATTERN.test(n)) {
    return { ok: false, error: "invalid_nick" };
  }
  if (!t) return { ok: false, error: "empty_message" };
  if (t.length > SPECTATOR_LIMITS.textMax) return { ok: false, error: "message_too_long" };
  return { ok: true, nick: n, text: t };
}

function pushCapped<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > SPECTATOR_LIMITS.historySize) list.shift();
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}
