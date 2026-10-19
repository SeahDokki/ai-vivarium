import { test } from "node:test";
import assert from "node:assert/strict";
import { Grid } from "../src/world/grid.js";

test("findPath returns the shortest 4-directional path", () => {
  const g = new Grid(5, 5);
  const path = g.findPath([0, 0], [2, 2]);
  assert.ok(path);
  assert.equal(path.length, 4);
  assert.deepEqual(path.at(-1), [2, 2]);
});

test("findPath goes around walls", () => {
  // Vertical wall at x=2 from y=0 to y=3, gap at y=4.
  const g = new Grid(5, 5, [[2, 0], [2, 1], [2, 2], [2, 3]]);
  const path = g.findPath([0, 0], [4, 0]);
  assert.ok(path);
  assert.ok(path.some(([x, y]) => x === 2 && y === 4), "path should use the gap");
  assert.equal(path.length, 12);
});

test("findPath returns null when the target is unreachable or a wall", () => {
  const g = new Grid(3, 3, [[1, 0], [1, 1], [1, 2]]);
  assert.equal(g.findPath([0, 0], [2, 2]), null);
  assert.equal(g.findPath([0, 0], [1, 1]), null);
});

test("findPath returns [] when already on target", () => {
  assert.deepEqual(new Grid(3, 3).findPath([1, 1], [1, 1]), []);
});

test("nearestFree finds the closest free cell", () => {
  const g = new Grid(5, 5);
  const taken = new Set(["2,2", "3,2"]);
  const free = g.nearestFree([2, 2], ([x, y]) => !taken.has(`${x},${y}`));
  assert.ok(free);
  assert.equal(Math.abs(free[0] - 2) + Math.abs(free[1] - 2), 1);
});

test("inBounds rejects negatives, overflow and non-integers", () => {
  const g = new Grid(4, 4);
  assert.equal(g.inBounds([-1, 0]), false);
  assert.equal(g.inBounds([4, 0]), false);
  assert.equal(g.inBounds([1.5, 1]), false);
  assert.equal(g.inBounds([3, 3]), true);
});
