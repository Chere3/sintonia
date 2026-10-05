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
import * as transcripts from "./transcripts.js";

const LOG_MAX = 300;
const CONCURRENCY = 20; // Jev allows 40 rps; a page is rarely more than 50 cards
// Bump when the shape of cached classifications changes (v2: probabilities).
const CLS_VERSION = 2;
// One storage key per video: every request costs O(batch), not O(cache).
const clsKey = (id) => `cls:${id}`;

// Hot-path state lives in memory; storage is only the backing copy. The
// service worker can be evicted at any time, so everything here is a cache.
let configCache = null;
let overrideCache; // undefined = not loaded
chrome.storage.onChanged.addListener((changes) => {
  if (changes.config) configCache = null;
  if (changes.override) overrideCache = undefined;
});

async function getConfig() {
  if (configCache) return configCache;
  let { config } = await chrome.storage.local.get("config");
  if (config) {
    const migrated = migrateConfig(config);
    if (migrated !== config) await chrome.storage.local.set({ config: (config = migrated) });
  }
  return (configCache = {
    ...DEFAULT_CONFIG,
    ...config,
    feedback: { ...DEFAULT_CONFIG.feedback, ...config?.feedback },
    transcripts: { ...DEFAULT_CONFIG.transcripts, ...config?.transcripts },
  });
}

async function getOverride() {
  if (overrideCache === undefined) overrideCache = (await chrome.storage.local.get("override")).override || null;
  return overrideCache;
}

chrome.runtime.onInstalled.addListener(async () => {
  const { config } = await chrome.storage.local.get("config");
  if (!config) await chrome.storage.local.set({ config: DEFAULT_CONFIG });
  await chrome.storage.local.remove("cls"); // pre-0.2 single-blob cache
});

// Global limiter: classification jobs run detached from the request that
// started them, so concurrency is bounded here rather than per batch.
let active = 0;
const waiting = [];
async function limited(fn) {
  while (active >= CONCURRENCY) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

// Stats are lossy by design: counted in memory, flushed every 2 s.
let stats = null;
let lastError = null;
let flushTimer = null;
async function countDecision(d) {
  stats ??= (await chrome.storage.local.get("stats")).stats || { ocultos: 0, mostrados: 0, errores: 0 };
  if (d.action === "hide") stats.ocultos++;
  else if (d.action === "show" && !d.retry) stats.mostrados++;
  if (d.error) stats.errores++;
  flushTimer ??= setTimeout(() => {
    flushTimer = null;
    chrome.storage.local.set({ stats, lastError });
  }, 2000);
}

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

async function appendLog(entries) {
  if (!entries.length) return;
  const { feedbackLog = [] } = await chrome.storage.local.get("feedbackLog");
  feedbackLog.push(...entries);
  await chrome.storage.local.set({ feedbackLog: feedbackLog.slice(-LOG_MAX) });
}

// Decides which hide decisions may become real YouTube feedback, honoring
// the mode, the hourly cap, and never sending twice for the same video.
// Feedback bookkeeping is read-modify-write; streamed results arrive
// concurrently, so calls are serialized.
let feedbackChain = Promise.resolve();
function gateFeedbackSerial(...args) {
  return (feedbackChain = feedbackChain.then(() => gateFeedback(...args)).catch(() => {}));
}

async function gateFeedback(config, profile, videos, decisions) {
  if (config.feedback.modo === "apagado" || !videos.some((v) => decisions[v.id]?.action === "hide" && decisions[v.id].feedback)) {
    for (const v of videos) if (decisions[v.id]) decisions[v.id].feedback = null;
    return;
  }
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

const inflight = new Set();

async function classifyAndStore(config, key, video, src) {
  const c = await limited(() => callClassifier(config, video));
  const entry = { ...c, k: key, src, ts: Date.now() };
  await chrome.storage.local.set({ [clsKey(video.id)]: entry });
  return entry;
}

// Decision for a cached entry when no network work is needed, else null.
function decideCached(config, profile, video, entry) {
  if (needsDetails(config, profile, entry)) {
    // Details come from the content script (same-origin request).
    return video.details === undefined ? { action: "pending", reason: "buscando descripción", needDetails: true } : null;
  }
  if (needsTranscript(config, profile, entry)) return null;
  return decideFromTopic(config, profile, entry);
}

// Walks one video through title → details → transcript and pushes the result
// to the tab as soon as it exists. Never blocks the request that started it.
async function advance(config, profile, key, video, entry, push) {
  if (inflight.has(video.id)) return;
  inflight.add(video.id);
  try {
    entry ??= await classifyAndStore(config, key, video, "titulo");
    if (needsDetails(config, profile, entry)) {
      if (video.details === undefined) return push({ action: "pending", reason: "buscando descripción", needDetails: true });
      if (video.details) entry = await classifyAndStore(config, key, video, "detalles");
      else {
        entry = { ...entry, src: "detalles" }; // details fetch failed: go on to the transcript
        await chrome.storage.local.set({ [clsKey(video.id)]: entry });
      }
    }
    if (needsTranscript(config, profile, entry)) {
      const t = (await transcripts.lookup([video.id])).items[video.id];
      if (t && typeof t === "object") entry = await classifyAndStore(config, key, { ...video, transcript: t.text }, "transcripcion");
      else if (t === null) {
        entry = { ...entry, src: "sin-transcripcion" }; // final: no captions exist
        await chrome.storage.local.set({ [clsKey(video.id)]: entry });
      } else {
        // Queued or blocked: decide provisionally, ask again later.
        return push({ ...decideFromTopic(config, profile, entry), retry: true });
      }
    }
    push(decideFromTopic(config, profile, entry));
  } catch (e) {
    lastError = String(e.message || e);
    push({ action: "show", reason: `error: ${lastError}`, error: true });
  } finally {
    inflight.delete(video.id);
  }
}

async function classify(videos, tabId) {
  const config = await getConfig();
  const profile = activeProfile(config, new Date(), await getOverride());
  const profileInfo = { id: profile.id, nombre: profile.nombre };
  if (!config.enabled) return { disabled: true, profile: profileInfo, decisions: {} };
  const key = `${temasKey(config.temas)}.${CLS_VERSION}`;
  const decisions = {};
  const open = [];

  for (const v of videos) {
    const ruled = applyRules(config, profile, v);
    if (ruled) decisions[v.id] = ruled;
    else if (config.backend === "none") decisions[v.id] = { action: "show", reason: "sin clasificador" };
    else open.push(v);
  }

  const stored = open.length ? await chrome.storage.local.get(open.map((v) => clsKey(v.id))) : {};
  const work = [];
  for (const v of open) {
    let entry = stored[clsKey(v.id)];
    if (entry?.k !== key) entry = null;
    const d = entry && decideCached(config, profile, v, entry);
    if (d) decisions[v.id] = d;
    else {
      decisions[v.id] = { action: "pending", reason: "clasificando" };
      work.push([v, entry]);
    }
  }

  const final = videos.filter((v) => decisions[v.id].action !== "pending");
  await gateFeedbackSerial(config, profile, final, decisions);
  for (const v of final) countDecision(decisions[v.id]);

  const push = (v) => async (d) => {
    await gateFeedbackSerial(config, profile, [v], { [v.id]: d });
    if (d.action !== "pending") countDecision(d);
    if (tabId != null)
      chrome.tabs.sendMessage(tabId, { type: "decisions", profile: profileInfo, decisions: { [v.id]: d } }).catch(() => {});
  };
  for (const [v, entry] of work) advance(config, profile, key, v, entry, push(v));

  return { profile: profileInfo, decisions };
}

async function feedbackResult({ id, ok, error }) {
  const { feedbackDone = {} } = await chrome.storage.local.get("feedbackDone");
  feedbackDone[id] = ok ? "enviado" : "fallido";
  await chrome.storage.local.set({ feedbackDone });
  await appendLog([{ ts: Date.now(), id, estado: ok ? "enviado" : "fallido", error }]);
}

async function status() {
  const config = await getConfig();
  const override = await getOverride();
  const [stored, tr] = await Promise.all([chrome.storage.local.get(["stats", "lastError"]), transcripts.status()]);
  const profile = activeProfile(config, new Date(), override);
  return {
    enabled: config.enabled,
    backend: config.backend,
    feedbackModo: config.feedback.modo,
    profile: { id: profile.id, nombre: profile.nombre },
    override,
    perfiles: config.perfiles.map((p) => ({ id: p.id, nombre: p.nombre, desde: p.desde, hasta: p.hasta })),
    transcripts: { activo: config.transcripts.activo, ...tr },
    stats: stats || stored.stats || {},
    lastError: lastError || stored.lastError || null,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handlers = {
    classify: () => classify(msg.videos, sender.tab?.id),
    "feedback-result": () => feedbackResult(msg),
    status,
    // Sent at document_start: wakes the worker and loads config before any
    // card exists, so the first classify request skips the cold start.
    warmup: async () => {
      await Promise.all([getConfig(), getOverride()]);
    },
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
