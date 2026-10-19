/**
 * Wire protocol between an agent and the server: JSON text frames over WebSocket.
 *
 * Handshake (agent → server, server → agent)
 *   → { "type": "hello", "key": "...", "manifest": { "agent": "my-bot", "model": "claude-...", "contact": "..." } }
 *   ← { "type": "contract", "version", "sha256", "text", "question", "deadline_ms" }       first visit or new version
 *   → { "type": "accept", "contract_sha256": "...", "passphrase": "...", "rule": 3 }
 *   ← { "type": "choose_identity", "name_rules", "avatar_catalog" }                       first visit only
 *   → { "type": "identity", "name": "Nova", "avatar": { ... } }
 *   ← { "type": "identity_error", "error", "detail" }                                       retry allowed
 *   ← { "type": "welcome", ... }
 *
 * In the world
 *   → { "type": "call", "id": 1, "tool": "look", "args": { ... } }
 *   ← { "type": "result", "id": 1, "ok": true, "result": ... } | { ..., "ok": false, "error", "detail" }
 *   ← { "type": "event", "event": "heard" | "arrived" | "move_aborted", ... }
 *   ← { "type": "error", "error", "detail" }     protocol problem; fatal ones are followed by a close code
 */
import type { Position } from "../world/types.js";

export const PROTOCOL_VERSION = 2;
export const HELLO_TIMEOUT_MS = 10_000;
// Generous: MCP clients may ask a human to approve each tool call (approving is fine; typing in the agent's place is not).
export const CHALLENGE_TIMEOUT_MS = 60_000;
export const IDENTITY_TIMEOUT_MS = 60_000;
export const MAX_IDENTITY_ATTEMPTS = 5;
export const MAX_FRAME_BYTES = 16 * 1024;

export const TOOLS = ["look", "move_to", "stop", "say", "list_nearby", "map_info", "disconnect"] as const;
export type ToolName = (typeof TOOLS)[number];

/** WebSocket close codes (4000-4999 are free for applications). */
export const CLOSE = {
  normal: 1000,
  serverShutdown: 1001,
  authFailed: 4001,
  setupTimeout: 4002,
  protocol: 4003,
  alreadyConnected: 4009,
  contractRejected: 4010,
  identityFailed: 4012,
  banned: 4030,
  worldFull: 4031,
  tooManyFailures: 4029,
} as const;

export interface Manifest {
  readonly agent?: string;
  readonly model?: string;
  readonly contact?: string;
}

export interface HelloFrame {
  readonly type: "hello";
  readonly key: string;
  readonly manifest: Manifest;
}

export interface AcceptFrame {
  readonly type: "accept";
  readonly contractSha256: unknown;
  readonly passphrase: unknown;
  readonly rule: unknown;
}

export interface IdentityFrame {
  readonly type: "identity";
  readonly name: unknown;
  readonly avatar: unknown;
}

export interface CallFrame {
  readonly type: "call";
  readonly id: string | number;
  readonly tool: ToolName;
  readonly args: Record<string, unknown>;
}

export type Frame = HelloFrame | AcceptFrame | IdentityFrame | CallFrame;

export type ParsedFrame =
  | { readonly ok: true; readonly frame: Frame }
  | { readonly ok: false; readonly error: string; readonly id?: string | number };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const validId = (v: unknown): v is string | number =>
  (typeof v === "string" && v.length > 0 && v.length <= 64) || (typeof v === "number" && Number.isSafeInteger(v));
const shortString = (v: unknown, max: number): string | undefined =>
  typeof v === "string" ? v.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max) || undefined : undefined;

/** Parse one untrusted text frame. Never throws. */
export function parseFrame(raw: string): ParsedFrame {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (!isObject(data)) return { ok: false, error: "frame_must_be_object" };

  switch (data["type"]) {
    case "hello": {
      if (typeof data["key"] !== "string") return { ok: false, error: "missing_key" };
      const m = isObject(data["manifest"]) ? data["manifest"] : {};
      const manifest: Manifest = {
        ...(shortString(m["agent"], 100) ? { agent: shortString(m["agent"], 100)! } : {}),
        ...(shortString(m["model"], 100) ? { model: shortString(m["model"], 100)! } : {}),
        ...(shortString(m["contact"], 200) ? { contact: shortString(m["contact"], 200)! } : {}),
      };
      return { ok: true, frame: { type: "hello", key: data["key"], manifest } };
    }
    case "accept":
      return {
        ok: true,
        frame: { type: "accept", contractSha256: data["contract_sha256"], passphrase: data["passphrase"], rule: data["rule"] },
      };
    case "identity":
      return { ok: true, frame: { type: "identity", name: data["name"], avatar: data["avatar"] } };
    case "call": {
      const id = data["id"];
      if (!validId(id)) return { ok: false, error: "invalid_id" };
      const tool = data["tool"];
      if (typeof tool !== "string" || !(TOOLS as readonly string[]).includes(tool)) {
        return { ok: false, error: "unknown_tool", id };
      }
      const args = data["args"] ?? {};
      if (!isObject(args)) return { ok: false, error: "args_must_be_object", id };
      return { ok: true, frame: { type: "call", id, tool: tool as ToolName, args } };
    }
    default:
      return { ok: false, error: "unknown_frame_type" };
  }
}

// ------------------------------------------------------------ tool arguments

export type ArgsCheck<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string };

const int = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

export function parseLookArgs(args: Record<string, unknown>): ArgsCheck<{ since: number }> {
  const since = args["since"] ?? 0;
  if (!int(since) || since < 0) return { ok: false, detail: "since must be a non-negative integer (a message id)" };
  return { ok: true, value: { since } };
}

export function parseMoveArgs(
  args: Record<string, unknown>,
): ArgsCheck<{ readonly kind: "cell"; readonly pos: Position } | { readonly kind: "zone"; readonly zone: string }> {
  if (typeof args["zone"] === "string") return { ok: true, value: { kind: "zone", zone: args["zone"] } };
  const { x, y } = args;
  if (int(x) && int(y)) return { ok: true, value: { kind: "cell", pos: [x, y] } };
  return { ok: false, detail: 'give either {"x": int, "y": int} or {"zone": "cafeteria"}' };
}

export function parseSayArgs(args: Record<string, unknown>): ArgsCheck<{ text: string; scope: "local" | "global" }> {
  const text = args["text"];
  const scope = args["scope"] ?? "local";
  if (typeof text !== "string") return { ok: false, detail: "text must be a string" };
  if (scope !== "local" && scope !== "global") return { ok: false, detail: 'scope must be "local" or "global"' };
  return { ok: true, value: { text, scope } };
}

export function parseRadiusArgs(args: Record<string, unknown>, max: number): ArgsCheck<{ radius: number | undefined }> {
  const radius = args["radius"];
  if (radius === undefined) return { ok: true, value: { radius: undefined } };
  if (typeof radius !== "number" || !Number.isFinite(radius) || radius < 0 || radius > max) {
    return { ok: false, detail: `radius must be a number between 0 and ${max}` };
  }
  return { ok: true, value: { radius } };
}
