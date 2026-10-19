// Spectator page: renders the office and streams the world, read-only. Human chat goes to humans only.
import { TILE, drawTile, characterSprite } from "./art.js";

const $ = (id) => document.getElementById(id);
const canvas = $("world");
const ctx = canvas.getContext("2d");

const ZONE_LABELS = {
  open_space: "Open space",
  cafeteria: "Cafétéria",
  meeting_room: "Salle de réunion",
  lounge: "Coin détente",
  reception: "Accueil",
  corridor: "Couloir",
};
const BUBBLE_MS = 6000;
const MAX_LOG = 100;

const state = {
  map: null,
  palette: null,
  tickMs: 500,
  mapLayer: null,
  scale: 2,
  /** device pixels per CSS pixel, used for text so it stays readable at any canvas size */
  ui: 1,
  /** id -> { name, avatar, from, to, t0, bubble, bubbleUntil, frameSeed } */
  agents: new Map(),
};

// ------------------------------------------------------------------ helpers

function zoneAt(x, y) {
  for (const z of state.map?.zones ?? []) {
    const [x1, x2] = [Math.min(z.from[0], z.to[0]), Math.max(z.from[0], z.to[0])];
    const [y1, y2] = [Math.min(z.from[1], z.to[1]), Math.max(z.from[1], z.to[1])];
    if (x >= x1 && x <= x2 && y >= y1 && y <= y2) return z.name;
  }
  return null;
}

const zoneLabel = (z) => (z ? ZONE_LABELS[z] ?? z : "—");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // never innerHTML: every string here is untrusted
  return node;
}

function appendLog(list, item, emptyNote) {
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.append(item);
  while (list.children.length > MAX_LOG) list.firstElementChild.remove();
  if (nearBottom) list.scrollTop = list.scrollHeight;
  if (emptyNote) emptyNote.hidden = true;
}

const hhmm = (iso) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

// ------------------------------------------------------------------ map layer

function buildMapLayer() {
  const { width, height, rows, legend } = state.map;
  const layer = document.createElement("canvas");
  layer.width = width * TILE;
  layer.height = height * TILE;
  const lctx = layer.getContext("2d");
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const kind = legend[rows[y][x]] ?? "floor";
      const below = y + 1 < height ? legend[rows[y + 1][x]] : "wall";
      // walls and furniture sit on the floor of the room they face
      const zone = zoneAt(x, y) ?? zoneAt(x, Math.min(y + 1, height - 1));
      drawTile(lctx, kind, x, y, zone, { below });
    }
  }
  state.mapLayer = layer;
}

function resize() {
  if (!state.map) return;
  const logicalW = state.map.width * TILE;
  const logicalH = state.map.height * TILE;
  const dpr = window.devicePixelRatio || 1;
  const shown = canvas.parentElement.clientWidth || logicalW;
  // The canvas matches its on-screen size in device pixels, so text is drawn crisp at a fixed size.
  canvas.width = Math.round(shown * dpr);
  canvas.height = Math.round((canvas.width * logicalH) / logicalW);
  state.scale = canvas.width / logicalW;
  // Text shrinks a little on small screens so labels do not cover the map.
  state.ui = dpr * Math.min(1, Math.max(0.7, shown / 900));
}

// ------------------------------------------------------------------ rendering

function agentPixelPos(a, now) {
  const t = Math.min(1, (now - a.t0) / state.tickMs);
  return [(a.from[0] + (a.to[0] - a.from[0]) * t) * TILE, (a.from[1] + (a.to[1] - a.from[1]) * t) * TILE, t < 1];
}

function drawText(text, x, y, { size, color = "#fff", align = "center", shadow = true, bold = false }) {
  ctx.font = `${bold ? "700 " : ""}${size}px "Cascadia Mono", Consolas, monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  if (shadow) {
    ctx.fillStyle = "rgba(0,0,0,0.85)";
    ctx.fillText(text, x + Math.max(1, size / 10), y + Math.max(1, size / 10));
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function wrap(text, maxChars) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > maxChars) {
      if (line) lines.push(line);
      line = w.length > maxChars ? w.slice(0, maxChars - 1) + "…" : w;
    } else line = (line + " " + w).trim();
    if (lines.length === 3) break;
  }
  if (line && lines.length < 3) lines.push(line);
  if (lines.length === 3 && text.length > lines.join(" ").length) lines[2] = lines[2].slice(0, maxChars - 1) + "…";
  return lines;
}

/** Draw a speech bubble; `taken` holds rectangles already used this frame so bubbles stack instead of overlapping. */
function drawBubble(text, cx, bottomY, taken) {
  const size = Math.round(12 * state.ui);
  const lines = wrap(text, 28);
  ctx.font = `${size}px "Cascadia Mono", Consolas, monospace`;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + size;
  const lh = size * 1.25;
  const h = lines.length * lh + size * 0.6;
  let x = cx - w / 2;
  x = Math.max(2, Math.min(canvas.width - w - 2, x));
  let y = Math.max(2, bottomY - h - size * 0.6);
  const gap = 3 * state.ui;
  for (let moved = true, guard = 0; moved && guard < 8; guard++) {
    moved = false;
    for (const r of taken) {
      if (x < r.x + r.w && x + w > r.x && y < r.y + r.h + gap && y + h + gap > r.y) {
        y = r.y - h - gap * 2;
        moved = true;
      }
    }
  }
  y = Math.max(2, y);
  taken.push({ x, y, w, h });
  const tailTop = y + h;
  const px = Math.max(1, Math.round(state.ui));
  ctx.fillStyle = "#1a1020";
  ctx.fillRect(x - px, y - px, w + 2 * px, h + 2 * px);
  ctx.fillStyle = "#fffdf4";
  ctx.fillRect(x, y, w, h);
  // tail, only when the bubble sits right above its speaker
  if (bottomY - tailTop < size * 2) {
    ctx.fillStyle = "#1a1020";
    ctx.fillRect(cx - 2 * px, tailTop, 4 * px, 2 * px);
    ctx.fillStyle = "#fffdf4";
    ctx.fillRect(cx - px, tailTop, 2 * px, px);
  }
  lines.forEach((l, i) => drawText(l, x + w / 2, y + size * 0.3 + (i + 1) * lh - size * 0.2, { size, color: "#1a1020", shadow: false }));
}

function render(now) {
  requestAnimationFrame(render);
  if (!state.mapLayer) return;
  const s = state.scale;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(state.mapLayer, 0, 0, canvas.width, canvas.height);

  // zone names, faint, at the top of each room
  for (const z of state.map.zones) {
    const cx = ((z.from[0] + z.to[0] + 1) / 2) * TILE * s;
    const ty = Math.min(z.from[1], z.to[1]) * TILE * s - 3 * state.ui;
    if (z.name === "corridor") continue;
    drawText(zoneLabel(z.name).toUpperCase(), cx, ty, { size: Math.round(11 * state.ui), color: "rgba(255,255,255,0.6)", bold: true });
  }

  const drawn = [...state.agents.values()].map((a) => ({ a, p: agentPixelPos(a, now) })).sort((m, n) => m.p[1] - n.p[1]);

  for (const { a, p } of drawn) {
    const [x, y, moving] = p;
    const frame = moving ? Math.floor(now / 160 + a.frameSeed) % 2 : 0;
    const bob = moving && frame === 1 ? -1 : 0;
    // shadow
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect((x + 4) * s, (y + 14) * s, 8 * s, 2 * s);
    ctx.drawImage(characterSprite(a.avatar, state.palette, frame), x * s, (y - 4 + bob) * s, TILE * s, TILE * s);
  }
  // labels and bubbles on top of every sprite; nearest the bottom first so upper bubbles stack above
  const taken = [];
  for (const { a, p } of [...drawn].reverse()) {
    const [x, y] = p;
    const cx = (x + TILE / 2) * s;
    drawText(a.name, cx, (y + TILE) * s + 11 * state.ui, { size: Math.round(11 * state.ui), bold: true });
    if (a.bubble && now < a.bubbleUntil) drawBubble(a.bubble, cx, (y - 5) * s, taken);
  }
}

// ------------------------------------------------------------------ side panels

function renderAgentList() {
  const list = $("agents");
  list.replaceChildren();
  const agents = [...state.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const a of agents) {
    const li = el("li");
    const icon = document.createElement("canvas");
    icon.width = TILE;
    icon.height = TILE;
    icon.getContext("2d").drawImage(characterSprite(a.avatar, state.palette, 0), 0, 0);
    li.append(icon, el("span", "name", a.name), el("span", "zone", zoneLabel(zoneAt(a.to[0], a.to[1]))));
    list.append(li);
  }
  $("agents-empty").hidden = agents.length > 0;
  $("agent-count").textContent = String(agents.length);
}

function addAgentChat(m) {
  const li = el("li");
  li.append(el("span", "who", m.from), el("span", "meta", `${m.scope === "global" ? "à tous" : zoneLabel(m.zone)}`), document.createElement("br"), el("span", "text", m.text));
  appendLog($("agent-log"), li, $("agent-log-empty"));
}

function addModeration(n) {
  const li = el("li", "moderation");
  const what = n.action === "muted" ? "réduit au silence jusqu'à" : "exclu jusqu'à";
  li.append(el("span", "who", "Modération"), el("span", "meta", hhmm(n.at)), document.createElement("br"), el("span", "text", `${n.name} ${what} ${hhmm(n.until)} : ${n.reason}`));
  appendLog($("agent-log"), li, $("agent-log-empty"));
}

function addHumanChat(m) {
  const li = el("li");
  li.append(el("span", "who", m.nick), el("span", "meta", hhmm(m.at)), document.createElement("br"), el("span", "text", m.text));
  appendLog($("human-log"), li);
}

// ------------------------------------------------------------------ socket

let socket = null;
let retryMs = 1000;

function setStatus(on, text) {
  $("status").textContent = text;
  $("status-dot").classList.toggle("on", on);
}

function upsertAgent(a) {
  state.agents.set(a.id, {
    name: a.name,
    avatar: a.avatar,
    from: a.pos,
    to: a.pos,
    t0: 0,
    bubble: null,
    bubbleUntil: 0,
    frameSeed: Math.random() * 2,
  });
}

function onMessage(frame) {
  const now = performance.now();
  switch (frame.type) {
    case "snapshot":
      state.map = frame.map;
      state.palette = frame.palette;
      state.tickMs = frame.tick_ms;
      state.agents.clear();
      frame.agents.forEach(upsertAgent);
      buildMapLayer();
      resize();
      $("agent-log").replaceChildren();
      $("human-log").replaceChildren();
      $("agent-log-empty").hidden = frame.agent_chat.length > 0;
      frame.agent_chat.forEach(addAgentChat);
      (frame.moderation ?? []).forEach(addModeration);
      frame.human_chat.forEach(addHumanChat);
      $("viewer-count").textContent = String(frame.viewers);
      renderAgentList();
      break;
    case "agent_joined":
      upsertAgent(frame.agent);
      renderAgentList();
      break;
    case "agent_left":
      state.agents.delete(frame.id);
      renderAgentList();
      break;
    case "agent_moved": {
      const a = state.agents.get(frame.id);
      if (!a) break;
      const t = Math.min(1, (now - a.t0) / state.tickMs);
      a.from = [a.from[0] + (a.to[0] - a.from[0]) * t, a.from[1] + (a.to[1] - a.from[1]) * t];
      a.to = frame.pos;
      a.t0 = now;
      const before = zoneAt(Math.round(a.from[0]), Math.round(a.from[1]));
      if (before !== zoneAt(frame.pos[0], frame.pos[1])) renderAgentList();
      break;
    }
    case "agent_chat": {
      const a = state.agents.get(frame.message.speaker);
      if (a) {
        a.bubble = frame.message.text;
        a.bubbleUntil = now + BUBBLE_MS;
      }
      addAgentChat(frame.message);
      break;
    }
    case "human_chat":
      addHumanChat(frame.message);
      break;
    case "moderation":
      addModeration(frame.notice);
      break;
    case "viewers":
      $("viewer-count").textContent = String(frame.count);
      break;
    case "chat_error":
      showChatError(frame.error);
      break;
  }
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/spectate`);
  socket.addEventListener("open", () => {
    retryMs = 1000;
    setStatus(true, "En direct");
  });
  socket.addEventListener("message", (e) => {
    try {
      onMessage(JSON.parse(e.data));
    } catch (err) {
      console.error(err);
    }
  });
  socket.addEventListener("close", () => {
    setStatus(false, "Reconnexion…");
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 15000);
  });
}

// ------------------------------------------------------------------ human chat form

const CHAT_ERRORS = {
  slow_down: "Doucement : un message toutes les quelques secondes.",
  duplicate: "Message identique au précédent.",
  invalid_nick: "Pseudo : 2 à 20 caractères (lettres, chiffres, espace, _ ou -).",
  empty_message: "Message vide.",
  message_too_long: "300 caractères maximum.",
};

function showChatError(code) {
  const box = $("human-error");
  box.textContent = CHAT_ERRORS[code] ?? "Message refusé.";
  clearTimeout(showChatError.timer);
  showChatError.timer = setTimeout(() => (box.textContent = ""), 4000);
}

function loadNick() {
  try {
    return localStorage.getItem("vivarium.nick") ?? "";
  } catch {
    return "";
  }
}

function saveNick(nick) {
  try {
    localStorage.setItem("vivarium.nick", nick);
  } catch {
    /* private mode: fine */
  }
}

$("nick").value = loadNick();
$("human-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const nick = $("nick").value.trim();
  const text = $("text").value.trim();
  if (!nick || !text || socket?.readyState !== WebSocket.OPEN) return;
  saveNick(nick);
  socket.send(JSON.stringify({ type: "chat", nick, text }));
  $("text").value = "";
});

window.addEventListener("resize", resize);
connect();
requestAnimationFrame(render);
