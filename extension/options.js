import { DEFAULT_CONFIG, migrateConfig } from "./core.js";

const $ = (id) => document.getElementById(id);
let current;

function fill(c) {
  current = c;
  $("backend").value = c.backend;
  $("jevKey").value = c.jevKey || "";
  $("layaUrl").value = c.layaUrl;
  $("umbral").value = c.umbral;
  $("tActivo").value = String(c.transcripts.activo);
  $("tChars").value = c.transcripts.chars;
  $("fModo").value = c.feedback.modo;
  $("fUmbral").value = c.feedback.umbral;
  $("fMax").value = c.feedback.maxPorHora;
  $("json").value = JSON.stringify({ temas: c.temas, perfiles: c.perfiles, global: c.global }, null, 2);
}

function validate({ temas, perfiles, global }) {
  if (!temas || typeof temas !== "object" || !Object.keys(temas).length) throw new Error("«temas» debe tener al menos un tema");
  if (!Array.isArray(perfiles)) throw new Error("«perfiles» debe ser una lista");
  const ids = new Set();
  for (const p of perfiles) {
    if (!p.id || ids.has(p.id)) throw new Error(`perfil sin id o repetido: ${p.id}`);
    ids.add(p.id);
    for (const f of ["desde", "hasta"])
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(p[f] || "")) throw new Error(`perfil ${p.id}: «${f}» debe ser HH:MM`);
    for (const t of [...(p.quiero || []), ...(p.evitar || [])])
      if (!(t in temas)) throw new Error(`perfil ${p.id}: el tema «${t}» no existe`);
  }
  return { temas, perfiles, global: global || DEFAULT_CONFIG.global };
}

async function load() {
  const { config } = await chrome.storage.local.get("config");
  fill({
    ...DEFAULT_CONFIG,
    ...(config && migrateConfig(config)),
    feedback: { ...DEFAULT_CONFIG.feedback, ...config?.feedback },
    transcripts: { ...DEFAULT_CONFIG.transcripts, ...config?.transcripts },
  });
  renderLog();
}

function say(text, ok) {
  $("msg").textContent = text;
  $("msg").className = ok ? "ok" : "bad";
}

$("save").addEventListener("click", async () => {
  try {
    const rules = validate(JSON.parse($("json").value));
    const config = {
      ...current,
      ...rules,
      backend: $("backend").value,
      jevKey: $("jevKey").value.trim(),
      layaUrl: $("layaUrl").value.trim(),
      umbral: Number($("umbral").value),
      transcripts: { activo: $("tActivo").value === "true", chars: Number($("tChars").value) },
      feedback: { modo: $("fModo").value, umbral: Number($("fUmbral").value), maxPorHora: Number($("fMax").value) },
    };
    await chrome.storage.local.set({ config });
    current = config;
    say("Guardado. YouTube se re-evalúa solo.", true);
  } catch (e) {
    say(e.message, false);
  }
});

$("reset").addEventListener("click", () => {
  fill({ ...DEFAULT_CONFIG, jevKey: $("jevKey").value });
  say("Valores por defecto cargados; pulsa Guardar para aplicarlos.", true);
});

$("clearCache").addEventListener("click", async () => {
  const keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("cls:")); // transcripts (tr:*) are kept: they are rate-limited
  await chrome.storage.local.remove([...keys, "cls", "feedbackDone", "stats"]);
  say("Caché borrada.", true);
});

async function renderLog() {
  const { feedbackLog = [] } = await chrome.storage.local.get("feedbackLog");
  const rows = feedbackLog.slice().reverse().map((e) => {
    const tr = document.createElement("tr");
    const video = e.title ? `${e.title} — ${e.channel}` : e.id;
    const tipo = e.kind === "channel" ? "No recomendar canal" : e.kind ? "No me interesa" : "";
    for (const v of [new Date(e.ts).toLocaleString("es-MX"), e.estado, tipo, video, e.reason || e.error || ""]) {
      const td = document.createElement("td");
      td.textContent = v;
      tr.append(td);
    }
    return tr;
  });
  $("log").replaceChildren(...rows);
}

chrome.storage.onChanged.addListener((c) => c.feedbackLog && renderLog());
load();
