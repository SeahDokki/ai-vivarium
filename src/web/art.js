// Placeholder 8-bit art, drawn in code: 16x16 tiles and recolourable characters.
// Replace with real sprite sheets once the art exists; the renderer only calls drawTile() and drawCharacter().

export const TILE = 16;

// ------------------------------------------------------------------ floors by zone

const FLOORS = {
  open_space: ["#5b6a8a", "#56648a"], // blue-grey carpet
  cafeteria: ["#e8dcc0", "#d8c8a4"], // cream tiles, checkered
  meeting_room: ["#a0703c", "#94663a"], // wood
  lounge: ["#5f8a5a", "#5a8456"], // green carpet
  reception: ["#c8c8d0", "#bcbcc6"], // stone
  corridor: ["#8c8c96", "#868690"],
  default: ["#8c8c96", "#868690"],
};

function floor(ctx, x, y, zone, gx, gy) {
  const [a, b] = FLOORS[zone] ?? FLOORS.default;
  const checker = zone === "cafeteria" || zone === "reception";
  ctx.fillStyle = checker && (gx + gy) % 2 ? b : a;
  ctx.fillRect(x, y, TILE, TILE);
  if (!checker) {
    // carpet / wood grain specks
    ctx.fillStyle = b;
    if (zone === "meeting_room") {
      ctx.fillRect(x, y + 5, TILE, 1);
      ctx.fillRect(x, y + 11, TILE, 1);
    } else {
      ctx.fillRect(x + ((gx * 7 + gy * 3) % 13), y + ((gx * 5 + gy * 11) % 13), 2, 1);
    }
  }
}

// ------------------------------------------------------------------ tiles

const C = {
  outline: "#1a1020",
  wallTop: "#2c2f45",
  wallFace: "#4a4f72",
  wallLine: "#3d4263",
  wood: "#8a5a2b",
  woodLight: "#a8743c",
  woodDark: "#5e3b1a",
  table: "#b9864e",
  screen: "#5ad1e8",
  screenOff: "#1e2a3a",
  chair: "#2f3a68",
  counter: "#d8d8de",
  counterTop: "#f4f4f8",
  steel: "#8a8f9c",
  leaf: "#3fa34d",
  leafDark: "#2b7a37",
  pot: "#a0522d",
  sofa: "#8e3b5e",
  sofaLight: "#b0507a",
  board: "#f8f8f8",
  door: "#6b4a2a",
};

/** Draw one tile at grid (gx, gy). `kind` comes from the map legend, `zone` picks the floor. */
export function drawTile(ctx, kind, gx, gy, zone, neighbours) {
  const x = gx * TILE;
  const y = gy * TILE;
  if (kind !== "wall") floor(ctx, x, y, zone, gx, gy);

  switch (kind) {
    case "wall": {
      const wallBelow = neighbours.below === "wall";
      ctx.fillStyle = C.wallTop;
      ctx.fillRect(x, y, TILE, TILE);
      if (!wallBelow) {
        // visible front face with bricks
        ctx.fillStyle = C.wallFace;
        ctx.fillRect(x, y + 6, TILE, 10);
        ctx.fillStyle = C.wallLine;
        ctx.fillRect(x, y + 10, TILE, 1);
        ctx.fillRect(x + ((gx % 2) ? 4 : 11), y + 6, 1, 4);
        ctx.fillRect(x + ((gx % 2) ? 11 : 4), y + 11, 1, 5);
      }
      break;
    }
    case "door":
      ctx.fillStyle = C.door;
      ctx.fillRect(x + 1, y + 1, TILE - 2, 2);
      ctx.fillRect(x + 1, y + TILE - 3, TILE - 2, 2);
      break;
    case "desk": {
      ctx.fillStyle = C.woodDark;
      ctx.fillRect(x, y + 1, TILE, TILE - 1);
      ctx.fillStyle = C.wood;
      ctx.fillRect(x, y + 1, TILE, TILE - 4);
      ctx.fillStyle = C.woodLight;
      ctx.fillRect(x, y + 1, TILE, 1);
      if ((gx + gy) % 2 === 0) {
        // monitor
        ctx.fillStyle = C.outline;
        ctx.fillRect(x + 3, y + 2, 10, 8);
        ctx.fillStyle = (gx * 3 + gy) % 5 === 0 ? C.screenOff : C.screen;
        ctx.fillRect(x + 4, y + 3, 8, 5);
        ctx.fillStyle = C.outline;
        ctx.fillRect(x + 7, y + 10, 2, 2);
      } else {
        // keyboard and papers
        ctx.fillStyle = "#e8e8e8";
        ctx.fillRect(x + 3, y + 5, 6, 4);
        ctx.fillStyle = "#30303a";
        ctx.fillRect(x + 10, y + 7, 4, 2);
      }
      break;
    }
    case "chair":
      ctx.fillStyle = C.outline;
      ctx.fillRect(x + 4, y + 4, 8, 8);
      ctx.fillStyle = C.chair;
      ctx.fillRect(x + 5, y + 5, 6, 6);
      ctx.fillStyle = "#46559a";
      ctx.fillRect(x + 5, y + 5, 6, 2);
      break;
    case "table":
      ctx.fillStyle = C.woodDark;
      ctx.fillRect(x, y, TILE, TILE);
      ctx.fillStyle = C.table;
      ctx.fillRect(x, y, TILE, TILE - 2);
      if ((gx * 7 + gy) % 3 === 0) {
        // a cup
        ctx.fillStyle = "#f4f4f4";
        ctx.fillRect(x + 6, y + 5, 4, 4);
        ctx.fillStyle = "#6b3e1e";
        ctx.fillRect(x + 7, y + 6, 2, 2);
      }
      break;
    case "counter":
      ctx.fillStyle = C.steel;
      ctx.fillRect(x, y, TILE, TILE);
      ctx.fillStyle = C.counter;
      ctx.fillRect(x, y, TILE, TILE - 3);
      ctx.fillStyle = C.counterTop;
      ctx.fillRect(x, y, TILE, 2);
      if (gx % 4 === 1) {
        // coffee machine
        ctx.fillStyle = C.outline;
        ctx.fillRect(x + 3, y + 2, 10, 10);
        ctx.fillStyle = "#c0392b";
        ctx.fillRect(x + 5, y + 4, 2, 2);
        ctx.fillStyle = "#7f8c8d";
        ctx.fillRect(x + 8, y + 7, 3, 4);
      }
      break;
    case "plant":
      ctx.fillStyle = C.pot;
      ctx.fillRect(x + 5, y + 10, 6, 5);
      ctx.fillStyle = C.leafDark;
      ctx.fillRect(x + 3, y + 3, 10, 8);
      ctx.fillStyle = C.leaf;
      ctx.fillRect(x + 4, y + 2, 4, 5);
      ctx.fillRect(x + 8, y + 4, 4, 5);
      ctx.fillRect(x + 6, y + 6, 3, 3);
      break;
    case "sofa":
      ctx.fillStyle = C.outline;
      ctx.fillRect(x + 1, y + 2, 14, 12);
      ctx.fillStyle = C.sofa;
      ctx.fillRect(x + 2, y + 3, 12, 10);
      ctx.fillStyle = C.sofaLight;
      ctx.fillRect(x + 3, y + 4, 10, 4);
      break;
    case "whiteboard":
      ctx.fillStyle = C.steel;
      ctx.fillRect(x, y + 2, TILE, 12);
      ctx.fillStyle = C.board;
      ctx.fillRect(x + 1, y + 3, TILE - 2, 10);
      ctx.fillStyle = ["#d82800", "#0058f8", "#00a800"][gx % 3];
      ctx.fillRect(x + 3, y + 5 + (gx % 3), 8, 1);
      ctx.fillRect(x + 3, y + 9, 5, 1);
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------ characters

// Base body, facing the viewer. O outline, S skin, E eye, T top, B bottom, F shoes, . transparent.
const BODY = [
  "................",
  "......OOOO......",
  ".....OSSSSO.....",
  "....OSSSSSSO....",
  "....OSSSSSSO....",
  "....OSESSESO....",
  "....OSSSSSSO....",
  ".....OSSSSO.....",
  "....OTTTTTTO....",
  "...OSTTTTTTSO...",
  "...OSTTTTTTSO...",
  "....OTTTTTTO....",
  "....OBBBBBBO....",
  "....OBBOOBBO....",
  "....OFFOOFFO....",
  "....OOO..OOO....",
];

// Second walking frame: legs swap.
const LEGS_B = ["....OBBBBBBO....", "....OBBOOFFO....", "....OFFO.OOO....", "....OOO........."];

// Hair or headwear per character, drawn over the body. "." keeps the body pixel. H = hair colour.
const CHARACTERS = {
  character_1: {
    // short brown hair
    hair: "#6b3e1e",
    overlay: ["................", "......OOOO......", ".....OHHHHO.....", "....OHHHHHHO....", "....OHSSSSHO...."],
  },
  character_2: {
    // long blonde hair over the shoulders
    hair: "#f0d060",
    overlay: [
      "................",
      "......OOOO......",
      ".....OHHHHO.....",
      "....OHHHHHHO....",
      "....OHHSSHHO....",
      "....OHESSEHO....",
      "....OHSSSSHO....",
      "....OHOSSOHO....",
      "....OHTTTTHO....",
    ],
  },
  character_3: {
    // red cap
    hair: "#d82800",
    overlay: ["................", "......OOOO......", ".....OHHHHO.....", "....OHHHHHHO....", "...OHHHHHHHHO..."],
  },
  character_4: {
    // big black curly hair
    hair: "#1e1a24",
    overlay: [
      ".....OOOOOO.....",
      "....OHHHHHHO....",
      "...OHHHHHHHHO...",
      "...OHHHHHHHHO...",
      "...OHHSSSSHHO...",
      "...OH......HO...",
      "....O......O....",
    ],
  },
  character_5: {
    // red ponytail
    hair: "#c8481c",
    overlay: [
      "................",
      "......OOOO......",
      ".....OHHHHO.....",
      "....OHHHHHHOO...",
      "....OHSSSSHOHO..",
      "...........OHO..",
      "............O...",
    ],
  },
};

const FIXED = { O: "#1a1020", E: "#1a1020", F: "#3a2a20" };

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `rgb(${r},${g},${b})`;
}

const spriteCache = new Map();

/** Build (and cache) the 16x16 sprite for an avatar and frame, as an offscreen canvas. */
export function characterSprite(avatar, palette, frame) {
  const key = `${avatar.character}|${avatar.skin}|${avatar.top}|${avatar.bottom}|${frame}`;
  const cached = spriteCache.get(key);
  if (cached) return cached;

  const def = CHARACTERS[avatar.character] ?? CHARACTERS.character_1;
  const colours = {
    ...FIXED,
    S: palette.skin[avatar.skin] ?? "#f5c99a",
    T: palette.clothes[avatar.top] ?? "#0058f8",
    B: palette.clothes[avatar.bottom] ?? "#00287c",
    H: def.hair,
  };
  const rows = BODY.slice();
  if (frame === 1) rows.splice(12, 4, ...LEGS_B);
  def.overlay.forEach((line, y) => {
    rows[y] = [...rows[y]].map((ch, x) => (line[x] && line[x] !== "." ? line[x] : ch)).join("");
  });

  const canvas = document.createElement("canvas");
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext("2d");
  rows.forEach((line, y) => {
    [...line].forEach((ch, x) => {
      if (ch === ".") return;
      ctx.fillStyle = colours[ch];
      ctx.fillRect(x, y, 1, 1);
    });
  });
  // a darker band at the bottom of the top for a bit of volume
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = shade(colours.T.startsWith("#") ? colours.T : "#000000", 0.75);
  ctx.fillRect(5, 11, 6, 1);
  ctx.globalCompositeOperation = "source-over";

  spriteCache.set(key, canvas);
  return canvas;
}
