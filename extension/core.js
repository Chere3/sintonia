// Pure logic shared by the service worker and the tests. No chrome.* here.

export const CONFIG_VERSION = 2;

export const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  enabled: true,
  backend: "jev", // "jev" | "laya" | "none"
  jevKey: "",
  layaUrl: "http://localhost:8000",
  transcripts: { activo: true, chars: 1800 },
  umbral: 0.7, // min classifier confidence to act on a topic
  feedback: {
    modo: "simulado", // "apagado" | "simulado" | "activo"
    umbral: 0.9, // min confidence to send "Not interested"
    maxPorHora: 10,
  },
  temas: {
    programacion: "programación, software, IA, ingeniería, tutoriales técnicos",
    ciencia: "ciencia, divulgación, documentales, matemáticas, biología",
    negocios: "startups, emprendimiento, finanzas personales, productividad",
    musica: "música, conciertos, álbumes, análisis musical",
    gaming: "videojuegos, gameplays, streams de juegos",
    drama: "drama de youtubers, chismes, reacciones, polémicas",
    humor: "comedia, sketches, memes, entretenimiento ligero",
    tecnologia: "tecnología de consumo, gadgets, reseñas de productos, noticias de empresas tech e IA",
    noticias: "noticias, política, actualidad, economía, análisis de eventos nacionales e internacionales",
    cine: "películas, series, tráilers, escenas de TV, análisis de cine",
    vlogs: "vlogs, viajes, comida, estilo de vida, retos",
  },
  perfiles: [
    {
      id: "manana",
      nombre: "Mañana",
      desde: "06:00",
      hasta: "14:00",
      estricto: true,
      quiero: ["programacion", "ciencia", "negocios", "tecnologia"],
      evitar: ["drama", "gaming", "humor"],
      canales: { permitir: [], bloquear: [] },
      palabras: { permitir: [], bloquear: [] },
    },
    {
      id: "tarde",
      nombre: "Tarde",
      desde: "14:00",
      hasta: "20:00",
      estricto: false,
      quiero: ["programacion", "ciencia", "musica", "tecnologia", "noticias"],
      evitar: ["drama"],
      canales: { permitir: [], bloquear: [] },
      palabras: { permitir: [], bloquear: [] },
    },
    {
      id: "noche",
      nombre: "Noche",
      desde: "20:00",
      hasta: "06:00",
      estricto: false,
      quiero: ["musica", "humor", "gaming", "ciencia", "cine", "vlogs"],
      evitar: ["drama"],
      canales: { permitir: [], bloquear: [] },
      palabras: { permitir: [], bloquear: [] },
    },
  ],
  // Applied in every profile, before the profile's own rules.
  global: {
    canales: { permitir: [], bloquear: [] },
    palabras: { permitir: [], bloquear: [] },
  },
};

// Topics added in v2, with the default profiles that want them. Stored
// configs get them merged in once; user-edited descriptions are kept.
const V2_TOPICS = {
  tecnologia: ["manana", "tarde"],
  noticias: ["tarde"],
  cine: ["noche"],
  vlogs: ["noche"],
};

export function migrateConfig(config) {
  if ((config.version || 1) >= CONFIG_VERSION) return config;
  const temas = { ...config.temas };
  const perfiles = (config.perfiles || []).map((p) => ({ ...p, quiero: [...(p.quiero || [])] }));
  for (const [topic, profileIds] of Object.entries(V2_TOPICS)) {
    if (topic in temas) continue;
    temas[topic] = DEFAULT_CONFIG.temas[topic];
    for (const p of perfiles) if (profileIds.includes(p.id) && !p.quiero.includes(topic)) p.quiero.push(topic);
  }
  return { ...config, temas, perfiles, version: CONFIG_VERSION };
}

const FALLBACK_PROFILE = {
  id: "general",
  nombre: "General",
  estricto: false,
  quiero: [],
  evitar: [],
  canales: { permitir: [], bloquear: [] },
  palabras: { permitir: [], bloquear: [] },
};

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Ranges are [desde, hasta) and may wrap past midnight (22:00 → 06:00).
export function inRange(minutes, desde, hasta) {
  const a = toMinutes(desde);
  const b = toMinutes(hasta);
  if (a === b) return true;
  return a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

export function activeProfile(config, date = new Date(), overrideId = null) {
  const perfiles = config.perfiles || [];
  if (overrideId) {
    const forced = perfiles.find((p) => p.id === overrideId);
    if (forced) return forced;
  }
  const minutes = date.getHours() * 60 + date.getMinutes();
  return perfiles.find((p) => inRange(minutes, p.desde, p.hasta)) || FALLBACK_PROFILE;
}

const norm = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();

function channelMatches(list, video) {
  const names = [norm(video.channel), norm(video.handle)];
  return (list || []).some((c) => {
    const n = norm(c);
    return n && names.includes(n);
  });
}

function keywordMatch(list, video) {
  const title = norm(video.title);
  return (list || []).find((k) => norm(k) && title.includes(norm(k))) || null;
}

// Rules short-circuit the classifier. Returns a decision or null.
// YouTube feedback is account-wide and not time-scoped, so only global
// rules may produce it; a profile rule just hides for that time slot.
export function applyRules(config, profile, video) {
  for (const scope of [config.global || {}, profile]) {
    const isGlobal = scope === config.global;
    if (channelMatches(scope.canales?.bloquear, video))
      return { action: "hide", reason: "canal bloqueado", feedback: isGlobal ? "channel" : null };
    if (channelMatches(scope.canales?.permitir, video)) return { action: "show", reason: "canal permitido" };
    const blocked = keywordMatch(scope.palabras?.bloquear, video);
    if (blocked) return { action: "hide", reason: `palabra «${blocked}»`, feedback: isGlobal ? "video" : null };
    const allowed = keywordMatch(scope.palabras?.permitir, video);
    if (allowed) return { action: "show", reason: `palabra «${allowed}»` };
  }
  return null;
}

export const OTHER_TOPIC = "otro";

// One choice question over the global topic catalogue, so a classification
// is profile-independent and can be cached by video id alone.
export function buildRequest(config, video) {
  const criteria = { ...config.temas, [OTHER_TOPIC]: "ninguno de los temas anteriores" };
  const lines = [`Título: ${video.title}`, `Canal: ${video.channel}`];
  if (video.duration) lines.push(`Duración: ${video.duration}`);
  const d = video.details;
  if (d?.category) lines.push(`Categoría de YouTube: ${d.category}`);
  if (d?.keywords?.length) lines.push(`Etiquetas: ${d.keywords.slice(0, 12).join(", ")}`);
  if (d?.description) lines.push(`Descripción: ${d.description.slice(0, 700)}`);
  // Head of the transcript: intros usually state the topic, and it keeps
  // Laya inside its context window.
  if (video.transcript) lines.push(`Transcripción (inicio): ${video.transcript.slice(0, config.transcripts?.chars ?? 1800)}`);
  return {
    state: `Video recomendado en YouTube\n${lines.join("\n")}`,
    questions: {
      tema: { type: "choice", instructions: "¿De qué tema trata principalmente este video?", criteria },
    },
  };
}

export function parseAnswer(response) {
  const a = response?.answers?.tema;
  if (!a || typeof a.choice !== "string") throw new Error("respuesta sin answers.tema");
  return { topic: a.choice, confidence: Number(a.confidence) || 0, probabilities: a.probabilities || null };
}

// Cheapest signal first. A confident title result is final; a doubtful one
// asks the content script for description/category/keywords (one light
// same-origin request); still doubtful asks the server for a transcript,
// which is the expensive step that can get the IP blocked.
// Entries without `src` predate this pipeline and are final.
// "Doubtful" is judged for the active profile: if the probability mass
// already settles it, more signals would not change the outcome.
const doubtful = (config, profile, entry) => !!entry && !!decideFromTopic(config, profile, entry).doubtful;

export function needsDetails(config, profile, entry) {
  return entry?.src === "titulo" && doubtful(config, profile, entry);
}

export function needsTranscript(config, profile, entry) {
  return !!config.transcripts?.activo && entry?.src === "detalles" && doubtful(config, profile, entry);
}

// Topic catalogue fingerprint: cached classifications are void when it changes.
export function temasKey(temas) {
  const s = JSON.stringify(Object.entries(temas || {}).sort());
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Decides on probability mass, not just the top topic: "programacion 46 /
// ciencia 39 / tecnologia 15" is a confident yes for a profile wanting all
// three, even though no single topic reaches the threshold.
export function decideFromTopic(config, profile, cls) {
  const probs = cls.probabilities || { [cls.topic]: cls.confidence, [OTHER_TOPIC]: 1 - cls.confidence };
  const mass = (topics) => (topics || []).reduce((sum, t) => sum + (probs[t] || 0), 0);
  const pct = (x) => `${Math.round(x * 100)}%`;
  const u = config.umbral;
  const top = `${cls.topic} ${pct(cls.confidence)}`;
  const wanted = mass(profile.quiero);
  const avoided = mass(profile.evitar);

  // Same reasoning as applyRules: only tell YouTube about topics unwanted at
  // every hour, never about a strict-mode miss.
  const everywhere = Object.keys(probs).filter((t) => (config.perfiles || []).every((p) => p.evitar?.includes(t)));
  const feedback = mass(everywhere) >= config.feedback.umbral ? "video" : null;

  if (avoided >= u) return { action: "hide", reason: `${top} · evitar ${pct(avoided)}`, feedback };
  if (profile.estricto) {
    if (wanted >= u) return { action: "show", reason: `${top} · quiero ${pct(wanted)}` };
    if (1 - wanted >= u) return { action: "hide", reason: `fuera de perfil: ${top}`, feedback: null };
  } else if (1 - avoided >= u) {
    return { action: "show", reason: wanted >= u ? `${top} · quiero ${pct(wanted)}` : top };
  }
  return { action: "show", reason: `dudoso: ${top}`, doubtful: true };
}

// Sliding one-hour window over the timestamps of sent feedback.
export function feedbackAllowed(sentTimestamps, maxPorHora, now = Date.now()) {
  const recent = sentTimestamps.filter((t) => now - t < 3600_000);
  return { ok: recent.length < maxPorHora, recent };
}
