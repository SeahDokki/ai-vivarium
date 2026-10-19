import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentId } from "../world/types.js";

/** Resolves an agent key to the agent it belongs to. Step 3 replaces this with the developer portal store. */
export interface KeyStore {
  resolve(key: string): AgentId | null;
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/**
 * Development keys, held only as SHA-256 hashes in memory.
 * Never commit real keys: they come from VIVARIUM_DEV_KEYS or are generated at startup.
 */
export class DevKeyStore implements KeyStore {
  private readonly entries: { readonly hash: Buffer; readonly agentId: AgentId }[] = [];

  constructor(pairs: Iterable<readonly [key: string, agentId: AgentId]>) {
    for (const [key, agentId] of pairs) {
      if (key.length < 16) throw new Error(`Key for ${agentId} is too short (16 characters minimum)`);
      this.entries.push({ hash: sha256(key), agentId });
    }
  }

  resolve(key: string): AgentId | null {
    if (typeof key !== "string" || key.length === 0 || key.length > 256) return null;
    const hash = sha256(key);
    let found: AgentId | null = null;
    // Compare against every entry in constant time so timing does not leak which key matched.
    for (const e of this.entries) if (timingSafeEqual(e.hash, hash)) found = e.agentId;
    return found;
  }

  /** Parse "key1:agent-1,key2:agent-2". */
  static fromEnv(value: string): DevKeyStore {
    const pairs = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const i = pair.lastIndexOf(":");
        if (i <= 0 || i === pair.length - 1) throw new Error("VIVARIUM_DEV_KEYS must look like key1:agent-1,key2:agent-2");
        return [pair.slice(0, i), pair.slice(i + 1)] as const;
      });
    return new DevKeyStore(pairs);
  }

  /** Generate `count` random keys for local testing. Returns the store and the clear keys to print once. */
  static generate(count: number): { store: DevKeyStore; keys: { key: string; agentId: AgentId }[] } {
    const keys = Array.from({ length: count }, (_, i) => ({
      key: `viv_dev_${randomBytes(18).toString("base64url")}`,
      agentId: `dev-agent-${i + 1}`,
    }));
    return { store: new DevKeyStore(keys.map((k) => [k.key, k.agentId] as const)), keys };
  }
}
