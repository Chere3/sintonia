import {
  DEFAULT_CONFIG,
  activeProfile,
  applyRules,
  buildRequest,
  parseAnswer,
  temasKey,
  decideFromTopic,
  feedbackAllowed,
  needsTranscript,
  needsDetails,
  migrateConfig,
} from "./core.js";

const CACHE_MAX = 5000;
const LOG_MAX = 300;
const CONCURRENCY = 8;
// Bump when the shape of cached classifications changes (v2: probabilities).
const CLS_VERSION = 2;

async function getConfig() {
  let { config } = await chrome.storage.local.get("config");
  if (config) {
    const migrated = migrateConfig(config);
    if (migrated !== config) await chrome.storage.local.set({ config: (config = migrated) });
  }
  return {
    ...DEFAULT_CONFIG,
    ...config,
    feedback: { ...DEFAULT_CONFIG.feedback, ...config?.feedback },
    transcripts: { ...DEFAULT_CONFIG.transcripts, ...config?.transcripts },
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  const { config } = await chrome.storage.local.get("config");
  if (!config) await chrome.storage.local.set({ config: DEFAULT_CONFIG });
});

async function callClassifier(config, video) {
  const body = buildRequest(config, video);
  let url, headers = { "Content-Type": "application/json" };
  if (config.backend === "jev") {
    if (!config.jevKey) throw new Error("falta la key de Jev");
    url = "https://api.typesafe.ai/v1/systemone";
    headers.Authorization = `Bearer ${config.jevKey}`;
    body.model = "jev-latest";
  } else if (config.backend === "laya") {
    url = `${config.layaUrl.replace(/\/$/, "")}/v1/systemone`;
    body.model = "typed-decisions";
  } else {
    return null;
  }
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${config.backend} HTTP ${res.status}`);
  return parseAnswer(await res.json());
}

// Asks the local server for transcripts. Returns { blocked, items } or null
// when the server is unreachable. Cached items are valid even while blocked.
async function getTranscripts(config, ids) {
  if (!ids.length) return null;
  try {
    const res = await fetch(`${config.transcripts.url.replace(/\/$/, "")}/transcripts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json();
    return { blocked: data.status !== "ok", items: data.items || {} };
  } catch {
    return null;
  }
}

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift());
    })
  );
}

async function appendLog(entries) {
  if (!entries.length) return;
  const { feedbackLog = [] } = await chrome.storage.local.get("feedbackLog");
  feedbackLog.push(...entries);
  await chrome.storage.local.set({ feedbackLog: feedbackLog.slice(-LOG_MAX) });
}

// Decides which hide decisions may become real YouTube feedback, honoring
// the mode, the hourly cap, and never sending twice for the same video.
async function gateFeedback(config, profile, videos, decisions) {
  const { feedbackSent = [], feedbackDone = {} } = await chrome.storage.local.get(["feedbackSent", "feedbackDone"]);
  let { recent } = feedbackAllowed(feedbackSent, config.feedback.maxPorHora);
  const log = [];
  for (const v of videos) {
    const d = decisions[v.id];
    if (d.action !== "hide" || !d.feedback || feedbackDone[v.id]) {
      d.feedback = null;
      continue;
    }
    const entry = { ts: Date.now(), id: v.id, title: v.title, channel: v.channel, kind: d.feedback, reason: d.reason, perfil: profile.id };
    if (config.feedback.modo === "simulado") {
      log.push({ ...entry, estado: "simulado" });
      feedbackDone[v.id] = "simulado";
      d.feedback = null;
    } else if (config.feedback.modo === "activo" && recent.length < config.feedback.maxPorHora) {
      recent.push(Date.now());
      feedbackDone[v.id] = "pendiente";
      log.push({ ...entry, estado: "pendiente" });
    } else {
      d.feedback = null;
    }
  }
  await chrome.storage.local.set({ feedbackSent: recent, feedbackDone });
  await appendLog(log);
}

async function classify(videos) {
  const config = await getConfig();
  const { override = null, cls = {}, stats = { ocultos: 0, mostrados: 0, errores: 0 } } =
    await chrome.storage.local.get(["override", "cls", "stats"]);
  const profile = activeProfile(config, new Date(), override);
  if (!config.enabled) return { disabled: true, profile: { id: profile.id, nombre: profile.nombre }, decisions: {} };
  const key = `${temasKey(config.temas)}.${CLS_VERSION}`;
  const decisions = {};
  const open = []; // not decided by a rule
  let lastError = null;

  for (const v of videos) {
    const ruled = applyRules(config, profile, v);
    if (ruled) decisions[v.id] = ruled;
    else open.push(v);
  }
  if (config.backend === "none") {
    for (const v of open) decisions[v.id] = { action: "show", reason: "sin clasificador" };
    open.length = 0;
  }

  const run = async (v, src) => {
    try {
      const c = await callClassifier(config, v);
      cls[v.id] = { ...c, k: key, src, ts: Date.now() };
    } catch (e) {
      lastError = String(e.message || e);
      stats.errores++;
      decisions[v.id] = { action: "show", reason: `error: ${lastError}` };
    }
  };

  // 1. Title first, for anything not cached under the current topic catalogue.
  const fresh = open.filter((v) => cls[v.id]?.k !== key);
  await pool(fresh, CONCURRENCY, (v) => run(v, "titulo"));

  // 2. Doubtful title → description/category/keywords, fetched by the content
  // script (same-origin) and sent back on its next request.
  const withDetails = [];
  for (const v of open) {
    if (decisions[v.id] || !needsDetails(config, profile, cls[v.id])) continue;
    if (v.details === undefined) decisions[v.id] = { action: "pending", reason: "buscando descripción", needDetails: true };
    else if (v.details) withDetails.push(v);
    else cls[v.id].src = "detalles"; // fetch failed: move on to the transcript
  }
  await pool(withDetails, CONCURRENCY, (v) => run(v, "detalles"));

  // 3. Still doubtful → transcript from the local server.
  const doubtful = open.filter((v) => !decisions[v.id] && needsTranscript(config, profile, cls[v.id]));
  const tr = await getTranscripts(config, doubtful.map((v) => v.id));
  const withTranscript = [];
  for (const v of doubtful) {
    const t = tr?.items[v.id];
    if (t && typeof t === "object") withTranscript.push({ ...v, transcript: t.text });
    else if (t === null) cls[v.id].src = "sin-transcripcion"; // final: the title is all there is
    else if (t === "pending" && !tr.blocked) decisions[v.id] = { action: "pending", reason: "esperando transcripción" };
    // Server down or blocked: keep the title result; it is retried next time.
  }
  await pool(withTranscript, CONCURRENCY, (v) => run(v, "transcripcion"));

  for (const v of open) if (!decisions[v.id]) decisions[v.id] = decideFromTopic(config, profile, cls[v.id]);

  if (fresh.length) {
    const ids = Object.keys(cls);
    if (ids.length > CACHE_MAX) {
      ids.sort((a, b) => cls[a].ts - cls[b].ts);
      for (const id of ids.slice(0, ids.length - CACHE_MAX)) delete cls[id];
    }
  }

  for (const v of videos) {
    const a = decisions[v.id].action;
    if (a === "hide") stats.ocultos++;
    else if (a === "show") stats.mostrados++;
  }
  await gateFeedback(config, profile, videos, decisions);
  await chrome.storage.local.set({ cls, stats, lastError });
  return { profile: { id: profile.id, nombre: profile.nombre }, decisions };
}

async function feedbackResult({ id, ok, error }) {
  const { feedbackDone = {} } = await chrome.storage.local.get("feedbackDone");
  feedbackDone[id] = ok ? "enviado" : "fallido";
  await chrome.storage.local.set({ feedbackDone });
  await appendLog([{ ts: Date.now(), id, estado: ok ? "enviado" : "fallido", error }]);
}

async function status() {
  const config = await getConfig();
  const { override = null, stats = {}, lastError = null } = await chrome.storage.local.get(["override", "stats", "lastError"]);
  const profile = activeProfile(config, new Date(), override);
  return {
    enabled: config.enabled,
    backend: config.backend,
    feedbackModo: config.feedback.modo,
    profile: { id: profile.id, nombre: profile.nombre },
    override,
    perfiles: config.perfiles.map((p) => ({ id: p.id, nombre: p.nombre, desde: p.desde, hasta: p.hasta })),
    stats,
    lastError,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const handlers = {
    classify: () => classify(msg.videos),
    "feedback-result": () => feedbackResult(msg),
    status,
    "set-override": () => chrome.storage.local.set({ override: msg.id || null }),
    "set-enabled": async () => {
      const config = await getConfig();
      await chrome.storage.local.set({ config: { ...config, enabled: !!msg.enabled } });
    },
  };
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve(h())
    .then((r) => reply({ ok: true, ...(r || {}) }))
    .catch((e) => reply({ ok: false, error: String(e.message || e) }));
  return true;
});
