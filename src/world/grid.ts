import type { Position } from "./types.js";

const key = (x: number, y: number): number => y * 100_000 + x;

/** 4-directional moves: no diagonal, so a step always costs 1. */
const DIRECTIONS: readonly Position[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export class Grid {
  private readonly walls = new Set<number>();

  constructor(
    readonly width: number,
    readonly height: number,
    walls: readonly Position[] = [],
  ) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error(`Invalid grid size ${width}x${height}`);
    }
    if (width >= 100_000) throw new Error("Grid width must be below 100000");
    for (const [x, y] of walls) this.walls.add(key(x, y));
  }

  inBounds([x, y]: Position): boolean {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  isWall([x, y]: Position): boolean {
    return this.walls.has(key(x, y));
  }

  isWalkable(p: Position): boolean {
    return this.inBounds(p) && !this.isWall(p);
  }

  neighbors([x, y]: Position): Position[] {
    const out: Position[] = [];
    for (const [dx, dy] of DIRECTIONS) {
      const n: Position = [x + dx, y + dy];
      if (this.isWalkable(n)) out.push(n);
    }
    return out;
  }

  /**
   * Shortest walkable path from `from` to `to` (breadth-first search).
   * Returns the steps after `from`, ending with `to`; [] if already there; null if unreachable.
   * `isBlocked` lets the caller treat extra cells (other agents) as walls; the target itself is never blocked.
   */
  findPath(from: Position, to: Position, isBlocked: (p: Position) => boolean = () => false): Position[] | null {
    if (!this.isWalkable(to)) return null;
    if (from[0] === to[0] && from[1] === to[1]) return [];

    const cameFrom = new Map<number, Position>();
    const startKey = key(from[0], from[1]);
    const targetKey = key(to[0], to[1]);
    cameFrom.set(startKey, from);
    const queue: Position[] = [from];

    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]!;
      for (const n of this.neighbors(current)) {
        const k = key(n[0], n[1]);
        if (cameFrom.has(k)) continue;
        if (k !== targetKey && isBlocked(n)) continue;
        cameFrom.set(k, current);
        if (k === targetKey) return this.rebuild(cameFrom, startKey, to);
        queue.push(n);
      }
    }
    return null;
  }

  /** Nearest walkable cell to `p` (including `p`) that passes `isFree`, by BFS ring. */
  nearestFree(p: Position, isFree: (q: Position) => boolean): Position | null {
    if (this.isWalkable(p) && isFree(p)) return p;
    const seen = new Set<number>([key(p[0], p[1])]);
    const queue: Position[] = this.inBounds(p) ? [p] : [];
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]!;
      for (const n of this.neighbors(current)) {
        const k = key(n[0], n[1]);
        if (seen.has(k)) continue;
        seen.add(k);
        if (isFree(n)) return n;
        queue.push(n);
      }
    }
    return null;
  }

  private rebuild(cameFrom: Map<number, Position>, startKey: number, to: Position): Position[] {
    const path: Position[] = [];
    let current: Position = to;
    while (key(current[0], current[1]) !== startKey) {
      path.push(current);
      current = cameFrom.get(key(current[0], current[1]))!;
    }
    return path.reverse();
  }
}

export function distance(a: Position, b: Position): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function samePos(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}
