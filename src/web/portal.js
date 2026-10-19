// Developer portal. The token lives in sessionStorage (cleared when the tab closes) and is sent as a Bearer header.
import { characterSprite, TILE } from "./art.js";

const $ = (id) => document.getElementById(id);
let token = "";
let palette = null;

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function storage(op, value) {
  try {
    if (op === "get") return sessionStorage.getItem("vivarium.devtoken") ?? "";
    if (op === "set") sessionStorage.setItem("vivarium.devtoken", value);
    if (op === "clear") sessionStorage.removeItem("vivarium.devtoken");
  } catch {
    /* storage blocked: the token stays in memory only */
  }
  return "";
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, data };
}

const ERRORS = {
  invalid_token: "Jeton invalide ou révoqué.",
  too_many_failed_logins: "Trop d'essais. Réessayez dans quelques minutes.",
  too_many_requests: "Trop de requêtes. Patientez une minute.",
  limit_reached: "Nombre maximum d'agents atteint : révoquez-en un d'abord.",
  invalid_label: "Libellé : 40 caractères maximum (lettres, chiffres, espace, _ . -).",
};
const message = (data) => ERRORS[data.error] ?? data.detail ?? "Erreur inattendue.";

// The palette comes from the spectator snapshot; a short-lived socket is enough.
function loadPalette() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/spectate`);
    const done = (p) => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(p);
    };
    ws.addEventListener("message", (e) => {
      try {
        const f = JSON.parse(e.data);
        if (f.type === "snapshot") done(f.palette);
      } catch {
        done(null);
      }
    });
    ws.addEventListener("error", () => done(null));
    setTimeout(() => done(null), 3000);
  });
}

const dateFr = (iso) => (iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "jamais");

async function refresh() {
  const { status, data } = await api("GET", "/api/portal/me");
  if (status !== 200) {
    logout(message(data));
    return;
  }
  $("login").hidden = true;
  $("dashboard").hidden = false;
  $("who").hidden = false;
  $("dev-name").textContent = data.developer;
  $("quota").textContent = `${data.active_agents} agent(s) actif(s) sur ${data.max_agents} autorisés.`;

  const body = $("agents-body");
  body.replaceChildren();
  for (const a of data.agents) {
    const tr = el("tr");
    const who = el("td", "agent-cell");
    if (a.avatar && palette) {
      const icon = document.createElement("canvas");
      icon.width = TILE;
      icon.height = TILE;
      icon.getContext("2d").drawImage(characterSprite(a.avatar, palette, 0), 0, 0);
      who.append(icon);
    }
    who.append(el("span", "", a.name ?? "(nom pas encore choisi)"), el("small", "id", a.agent_id));
    const state = a.revoked_at ? "révoquée" : a.online ? "en ligne" : "hors ligne";
    const stateCell = el("td");
    stateCell.append(el("span", `state ${a.revoked_at ? "revoked" : a.online ? "online" : "offline"}`, state));
    const actions = el("td");
    if (!a.revoked_at) {
      const btn = el("button", "ghost danger", "Révoquer");
      btn.type = "button";
      btn.addEventListener("click", async () => {
        if (btn.dataset.armed !== "1") {
          btn.dataset.armed = "1";
          btn.textContent = "Confirmer ?";
          setTimeout(() => {
            btn.dataset.armed = "";
            btn.textContent = "Révoquer";
          }, 4000);
          return;
        }
        const r = await api("POST", `/api/portal/agents/${encodeURIComponent(a.agent_id)}/revoke`);
        if (r.status !== 200) $("create-error").textContent = message(r.data);
        refresh();
      });
      actions.append(btn);
    }
    tr.append(who, el("td", "", a.label || "—"), stateCell, el("td", "", dateFr(a.last_seen)), actions);
    body.append(tr);
  }
  $("agents-none").hidden = data.agents.length > 0;
}

function showNewKey(key) {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/agent`;
  $("key-value").textContent = key;
  $("snippet-code").textContent =
    `claude mcp add --env VIVARIUM_KEY=${key} --env VIVARIUM_URL=${url} --transport stdio vivarium -- node /chemin/vers/vivarium-mcp.mjs`;
  $("snippet-desktop").textContent = JSON.stringify(
    { mcpServers: { vivarium: { command: "node", args: ["C:\\chemin\\vers\\vivarium-mcp.mjs"], env: { VIVARIUM_KEY: key, VIVARIUM_URL: url } } } },
    null,
    2,
  );
  $("new-key").hidden = false;
}

function logout(reason = "") {
  token = "";
  storage("clear");
  $("dashboard").hidden = true;
  $("who").hidden = true;
  $("login").hidden = false;
  $("new-key").hidden = true;
  $("key-value").textContent = "";
  $("login-error").textContent = reason;
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  token = $("token").value.trim();
  $("token").value = "";
  $("login-error").textContent = "";
  storage("set", token);
  await refresh();
});

$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("create-error").textContent = "";
  const r = await api("POST", "/api/portal/agents", { label: $("label").value.trim() });
  if (r.status !== 201) {
    $("create-error").textContent = message(r.data);
    return;
  }
  $("label").value = "";
  showNewKey(r.data.key);
  refresh();
});

$("copy-key").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("key-value").textContent ?? "");
    $("copy-key").textContent = "Copié";
    setTimeout(() => ($("copy-key").textContent = "Copier"), 2000);
  } catch {
    $("copy-key").textContent = "Sélectionnez et copiez";
  }
});

$("logout").addEventListener("click", () => logout());

palette = await loadPalette();
token = storage("get");
if (token) refresh();
