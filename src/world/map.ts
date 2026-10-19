import type { Position, Zone } from "./types.js";

/** Tile kinds. Furniture blocks movement, except chairs and doors. */
export type TileKind =
  | "wall"
  | "floor"
  | "door"
  | "desk"
  | "chair"
  | "table"
  | "counter"
  | "plant"
  | "sofa"
  | "whiteboard";

export const TILE_LEGEND: Readonly<Record<string, TileKind>> = {
  "#": "wall",
  ".": "floor",
  "=": "door",
  D: "desk",
  c: "chair",
  T: "table",
  K: "counter",
  P: "plant",
  S: "sofa",
  B: "whiteboard",
};

const BLOCKING: ReadonlySet<TileKind> = new Set(["wall", "desk", "table", "counter", "plant", "sofa", "whiteboard"]);

export interface MapDefinition {
  readonly id: string;
  /** One string per row, one character per tile (see TILE_LEGEND). All rows must have the same length. */
  readonly rows: readonly string[];
  readonly spawn: Position;
  /** Checked in order: the first zone containing a cell names it. */
  readonly zones: readonly Zone[];
}

export interface LoadedMap {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly spawn: Position;
  readonly zones: readonly Zone[];
  readonly walls: readonly Position[];
  /** tiles[y][x] */
  readonly tiles: readonly (readonly TileKind[])[];
  /** The rows as given, for agents that want the ASCII map. */
  readonly rows: readonly string[];
}

export function loadMap(def: MapDefinition): LoadedMap {
  const height = def.rows.length;
  const width = def.rows[0]?.length ?? 0;
  if (!height || !width) throw new Error(`Map ${def.id} is empty`);

  const walls: Position[] = [];
  const tiles = def.rows.map((row, y) => {
    if (row.length !== width) throw new Error(`Map ${def.id}: row ${y} has ${row.length} tiles, expected ${width}`);
    return [...row].map((ch, x) => {
      const kind = TILE_LEGEND[ch];
      if (!kind) throw new Error(`Map ${def.id}: unknown tile '${ch}' at ${x},${y}`);
      if (BLOCKING.has(kind)) walls.push([x, y]);
      return kind;
    });
  });

  const spawnTile = tiles[def.spawn[1]]?.[def.spawn[0]];
  if (!spawnTile || BLOCKING.has(spawnTile)) throw new Error(`Map ${def.id}: spawn is not walkable`);

  return { id: def.id, width, height, spawn: def.spawn, zones: def.zones, walls, tiles, rows: def.rows };
}

export function isBlocking(kind: TileKind): boolean {
  return BLOCKING.has(kind);
}
