import type { World } from "./world.js";

/** Drives a World in real time: one `world.step()` every `intervalMs`. */
export class TickLoop {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly world: World,
    readonly intervalMs = 500,
  ) {
    if (!(intervalMs > 0)) throw new Error("intervalMs must be positive");
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.world.step(), this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
