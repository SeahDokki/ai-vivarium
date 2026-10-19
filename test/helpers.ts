import { WebSocket } from "ws";
import { QUESTIONS, RULES } from "../src/contract/contract.js";

/** Answer a contract challenge the way a reading agent would: find the passphrase and the rule. */
export function solveContract(frame: { sha256: string; text: string; question: string }) {
  const passphrase = /Session passphrase: (\S+)/.exec(frame.text)?.[1] ?? "";
  const topic = (Object.keys(QUESTIONS) as (keyof typeof QUESTIONS)[]).find((t) => frame.question.includes(QUESTIONS[t]));
  return { type: "accept", contract_sha256: frame.sha256, passphrase, rule: topic ? RULES[topic] : -1 };
}

/** A test client: collects frames and lets a test wait for one. */
export class Client {
  readonly ws: WebSocket;
  readonly frames: any[] = [];
  private waiters: { match: (f: any) => boolean; resolve: (f: any) => void }[] = [];
  private nextId = 1;
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (d) => {
      const f = JSON.parse(d.toString());
      const i = this.waiters.findIndex((w) => w.match(f));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(f);
      else this.frames.push(f);
    });
    this.closed = new Promise((resolve) => this.ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  }

  opened(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve) => this.ws.once("open", () => resolve()));
  }

  next(match: (f: any) => boolean, timeoutMs = 2000): Promise<any> {
    const i = this.frames.findIndex(match);
    if (i >= 0) return Promise.resolve(this.frames.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), timeoutMs);
      this.waiters.push({ match, resolve: (f) => (clearTimeout(timer), resolve(f)) });
    });
  }

  send(obj: unknown) {
    this.ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  }

  async hello(key: string) {
    await this.opened();
    this.send({ type: "hello", key, manifest: { agent: "test-client", model: "none" } });
    return this.next((f) => ["contract", "choose_identity", "welcome", "error"].includes(f.type));
  }

  /** Full handshake: contract if asked, identity if asked. Returns the welcome frame. */
  async join(key: string, name: string, avatar?: unknown) {
    let f = await this.hello(key);
    if (f.type === "contract") {
      this.send(solveContract(f));
      f = await this.next((x) => ["choose_identity", "welcome", "error"].includes(x.type));
    }
    if (f.type === "choose_identity") {
      this.send({ type: "identity", name, ...(avatar ? { avatar } : {}) });
      f = await this.next((x) => ["welcome", "identity_error", "error"].includes(x.type));
    }
    return f;
  }

  async call(tool: string, args: Record<string, unknown> = {}) {
    const id = this.nextId++;
    this.send({ type: "call", id, tool, args });
    return this.next((f) => f.type === "result" && f.id === id);
  }

  async close() {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000);
    await this.closed;
  }
}
