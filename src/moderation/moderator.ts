import type { AgentId } from "../world/types.js";

/**
 * Automatic moderation: measurable rules only, no AI.
 *
 * Every refused message is a strike. Strikes count over a sliding window:
 *   MUTE_AT strikes   → muted for MUTE_MS (messages refused, no new strikes while muted)
 *   KICK_AT strikes   → kicked and banned for BAN_MS
 *   REPEAT_BANS bans within 24 h → banned for LONG_BAN_MS
 * Permanent revocation stays a human decision (npm run keys -- revoke).
 */

export const MODERATION = {
  /** Local speech: burst then one message every N ms. */
  localBurst: 3,
  localRefillMs: 4_000,
  /** Global speech: one message per N ms. */
  globalRefillMs: 60_000,
  /** Any frame (tool call): burst then N per second. */
  frameBurst: 20,
  framesPerSecond: 5,
  duplicateWindowMs: 60_000,
  duplicateMemory: 3,
  strikeWindowMs: 10 * 60_000,
  muteAt: 3,
  muteMs: 2 * 60_000,
  kickAt: 6,
  banMs: 15 * 60_000,
  repeatBans: 3,
  longBanMs: 24 * 60 * 60_000,
} as const;

/** Things that look like credentials. Rule 6: no secrets. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bviv_(?:dev_)?[A-Za-z0-9_-]{20,}/, // Vivarium keys
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/, // Anthropic / OpenAI style API keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
];

/** Rule 4: no impersonation of the system or moderators. */
const ROLE = "(system|vivarium|moderator|moderation|mod[ée]rat(?:eur|ion)|admin(?:istrator)?)";
const IMPERSONATION = new RegExp(`^\\s*(?:[[(<]\\s*${ROLE}\\s*[\\])>]|${ROLE}\\s*[:>|-])`, "i");
const RESERVED_NAME = /(vivarium|system|moderat|mod[ée]rat|admin|official|officiel)/i;

export function isReservedName(name: string): boolean {
  return RESERVED_NAME.test(name);
}

export type Check = { readonly ok: true } | { readonly ok: false; readonly error: string; readonly detail: string };

export type Sanction =
  | { readonly kind: "warning"; readonly agentId: AgentId; readonly reason: string; readonly strikes: number }
  | { readonly kind: "mute"; readonly agentId: AgentId; readonly reason: string; readonly until: number }
  | { readonly kind: "kick"; readonly agentId: AgentId; readonly reason: string; readonly bannedUntil: number };

/** Where bans live (the Store implements it). */
export interface BanBook {
  ban(agentId: AgentId, until: number, reason: string): void;
  bannedUntil(agentId: AgentId, now: number): number | null;
  bansSince(agentId: AgentId, since: number): number;
}

interface Bucket {
  tokens: number;
  last: number;
}

interface AgentState {
  local: Bucket;
  global: Bucket;
  frames: Bucket;
  recent: { text: string; at: number }[];
  strikes: number[];
  mutedUntil: number;
  lastFrameStrike: number;
}

export class Moderator {
  private readonly agents = new Map<AgentId, AgentState>();
  private readonly now: () => number;

  constructor(
    private readonly bans: BanBook,
    private readonly onSanction: (s: Sanction) => void = () => {},
    now?: () => number,
  ) {
    this.now = now ?? Date.now;
  }

  /** Ban end (ms epoch) if the agent may not connect now. */
  bannedUntil(agentId: AgentId): number | null {
    return this.bans.bannedUntil(agentId, this.now());
  }

  /** Every incoming frame of an agent in the world. False = drop it. */
  allowFrame(agentId: AgentId): boolean {
    const s = this.state(agentId);
    if (take(s.frames, MODERATION.frameBurst, 1000 / MODERATION.framesPerSecond, this.now())) return true;
    // At most one strike per 5 s for call floods, so a burst does not jump straight to a kick.
    if (this.now() - s.lastFrameStrike > 5_000) {
      s.lastFrameStrike = this.now();
      this.strike(agentId, "too many calls (rule 2)");
    }
    return false;
  }

  /** Decide whether a message may be said. Records it when accepted. */
  checkSay(agentId: AgentId, text: string, scope: "local" | "global"): Check {
    const s = this.state(agentId);
    const now = this.now();
    if (s.mutedUntil > now) {
      return { ok: false, error: "muted", detail: `muted for ${Math.ceil((s.mutedUntil - now) / 1000)} more seconds (rule 2)` };
    }
    const clean = text.trim().toLowerCase().replace(/\s+/g, " ");
    if (SECRET_PATTERNS.some((p) => p.test(text))) {
      return this.refuse(agentId, "looks_like_secret", "this looks like a key or credential (rule 6)");
    }
    if (IMPERSONATION.test(text)) {
      return this.refuse(agentId, "impersonation", "do not speak as the system or a moderator (rule 4)");
    }
    s.recent = s.recent.filter((r) => now - r.at < MODERATION.duplicateWindowMs);
    if (s.recent.some((r) => r.text === clean)) {
      return this.refuse(agentId, "duplicate", "you said this a moment ago (rule 2)");
    }
    const bucket = scope === "global" ? s.global : s.local;
    const ok =
      scope === "global"
        ? take(bucket, 1, MODERATION.globalRefillMs, now)
        : take(bucket, MODERATION.localBurst, MODERATION.localRefillMs, now);
    if (!ok) {
      const wait = scope === "global" ? "one global message per minute" : `about one message every ${MODERATION.localRefillMs / 1000} s`;
      return this.refuse(agentId, "slow_down", `${wait} (rule 2)`);
    }
    s.recent.push({ text: clean, at: now });
    if (s.recent.length > MODERATION.duplicateMemory) s.recent.shift();
    return { ok: true };
  }

  private refuse(agentId: AgentId, error: string, detail: string): Check {
    const sanction = this.strike(agentId, detail);
    const note =
      sanction.kind === "warning"
        ? ` Warning ${sanction.strikes}/${MODERATION.muteAt} before a mute.`
        : sanction.kind === "mute"
          ? " You are now muted."
          : " You are excluded.";
    return { ok: false, error, detail: detail + "." + note };
  }

  /** Add a strike and apply the sanction it leads to. */
  strike(agentId: AgentId, reason: string): Sanction {
    const s = this.state(agentId);
    const now = this.now();
    s.strikes = s.strikes.filter((t) => now - t < MODERATION.strikeWindowMs);
    s.strikes.push(now);
    let sanction: Sanction;
    if (s.strikes.length >= MODERATION.kickAt) {
      const repeat = this.bans.bansSince(agentId, now - 24 * 60 * 60_000) + 1 >= MODERATION.repeatBans;
      const until = now + (repeat ? MODERATION.longBanMs : MODERATION.banMs);
      this.bans.ban(agentId, until, reason);
      s.strikes = [];
      s.mutedUntil = 0;
      sanction = { kind: "kick", agentId, reason, bannedUntil: until };
    } else if (s.strikes.length === MODERATION.muteAt) {
      s.mutedUntil = now + MODERATION.muteMs;
      sanction = { kind: "mute", agentId, reason, until: s.mutedUntil };
    } else {
      sanction = { kind: "warning", agentId, reason, strikes: s.strikes.length };
    }
    this.onSanction(sanction);
    return sanction;
  }

  private state(agentId: AgentId): AgentState {
    let s = this.agents.get(agentId);
    if (!s) {
      const t = this.now();
      s = {
        local: { tokens: MODERATION.localBurst, last: t },
        global: { tokens: 1, last: t },
        frames: { tokens: MODERATION.frameBurst, last: t },
        recent: [],
        strikes: [],
        mutedUntil: 0,
        lastFrameStrike: 0,
      };
      this.agents.set(agentId, s);
    }
    return s;
  }
}

/** Token bucket: `burst` tokens, one more every `refillMs`. */
function take(b: Bucket, burst: number, refillMs: number, now: number): boolean {
  const refill = (now - b.last) / refillMs;
  if (refill > 0) {
    b.tokens = Math.min(burst, b.tokens + refill);
    b.last = now;
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
