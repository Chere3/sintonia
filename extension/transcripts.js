// Transcripts fetched by the service worker, replacing the old Python server.
// Mirrors youtube-transcript-api 1.2.4: the ANDROID innertube client returns
// caption tracks without a PO token (the WEB client used by the page does
// not), then the track's baseUrl serves timedtext XML.
//
// YouTube rate-limits this per IP (~45 videos in a burst got us blocked), so
// it is the last resort of the pipeline: one video at a time, 2–4 s apart,
// and a 30 min backoff that doubles on repeated blocks. The backoff lives in
// storage because the service worker can be evicted at any moment.

export const LANGS = ["es", "en"];
export const MAX_CHARS = 4000; // only the head is ever sent to the classifier
const PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const CLIENT = { clientName: "ANDROID", clientVersion: "20.10.38" };
const DELAY_MS = [2000, 4000];
export const BACKOFF_START_MS = 30 * 60 * 1000;
export const BACKOFF_MAX_MS = 8 * 3600 * 1000;
const MAX_FAILS = 3; // transient failures before giving up on a video

// --- Pure helpers (tested in tests/transcripts.test.js) ---

// Same order as find_transcript(): for each language, manual before
// generated (kind "asr"); otherwise any track beats nothing.
export function pickTrack(tracks, langs = LANGS) {
  if (!tracks?.length) return null;
  for (const lang of langs) {
    const manual = tracks.find((t) => t.languageCode === lang && t.kind !== "asr");
    if (manual) return manual;
    const generated = tracks.find((t) => t.languageCode === lang);
    if (generated) return generated;
  }
  return tracks[0];
}

// What a player response means for us: a track list, "none" (the video has
// no usable transcript, cache it), or "blocked" (back off).
export function readPlayer(data) {
  const ps = data?.playabilityStatus;
  if (ps?.status && ps.status !== "OK") {
    if (ps.status === "LOGIN_REQUIRED" && /bot/i.test(ps.reason || "")) return { kind: "blocked" };
    return { kind: "none" }; // age-restricted, unavailable, unplayable
  }
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return tracks?.length ? { kind: "tracks", tracks } : { kind: "none" };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Service workers have no DOMParser, so the timedtext XML is read with a
// regex: <text start=".." dur="..">escaped text</text>. Like the library,
// entities are decoded first and any HTML tag inside is stripped.
export function parseTimedText(xml, maxChars = MAX_CHARS) {
  const parts = [];
  let length = 0;
  for (const m of xml.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)) {
    const text = decodeEntities(decodeEntities(m[1])).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    parts.push(text);
    length += text.length + 1;
    if (length >= maxChars) break;
  }
  return parts.join(" ").slice(0, maxChars);
}

export function nextBackoff(current) {
  return Math.min((current || BACKOFF_START_MS / 2) * 2, BACKOFF_MAX_MS);
}

// --- Fetching ---

const cacheKey = (id) => `tr:${id}`;
const STATE_KEY = "tr:state"; // { blockedUntil, backoff }

// No cookies: like the library, and so nothing here is tied to the account.
async function fetchTranscript(id) {
  const res = await fetch(PLAYER_URL, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId: id, context: { client: CLIENT } }),
  });
  if (res.status === 429) return { kind: "blocked" };
  if (!res.ok) throw new Error(`player HTTP ${res.status}`);
  const player = readPlayer(await res.json());
  if (player.kind !== "tracks") return player;

  const track = pickTrack(player.tracks);
  const tt = await fetch(track.baseUrl.replace("&fmt=srv3", ""), { credentials: "omit" });
  if (tt.status === 429) return { kind: "blocked" };
  if (!tt.ok) throw new Error(`timedtext HTTP ${tt.status}`);
  const text = parseTimedText(await tt.text());
  return text ? { kind: "text", text, lang: track.languageCode } : { kind: "none" };
}

// --- Queue: one slow worker per service-worker lifetime ---

const queue = [];
const queued = new Set();
const fails = new Map();
let running = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getState() {
  return (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || { blockedUntil: 0, backoff: 0 };
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const state = await getState();
      if (Date.now() < state.blockedUntil) break; // jobs are re-queued by later lookups
      const id = queue.shift();
      queued.delete(id);
      try {
        const r = await fetchTranscript(id);
        if (r.kind === "blocked") {
          const backoff = nextBackoff(state.backoff);
          await chrome.storage.local.set({ [STATE_KEY]: { blockedUntil: Date.now() + backoff, backoff } });
          queue.length = 0;
          queued.clear();
          break;
        }
        const entry = r.kind === "text" ? { text: r.text, lang: r.lang } : { none: true };
        await chrome.storage.local.set({ [cacheKey(id)]: entry, [STATE_KEY]: { blockedUntil: 0, backoff: 0 } });
      } catch {
        const n = (fails.get(id) || 0) + 1;
        fails.set(id, n);
        if (n >= MAX_FAILS) await chrome.storage.local.set({ [cacheKey(id)]: { none: true } });
      }
      await sleep(DELAY_MS[0] + Math.random() * (DELAY_MS[1] - DELAY_MS[0]));
    }
  } finally {
    running = false;
  }
}

// Same contract the Python server had. Returns, per id: { text, lang } when
// cached, null when the video has no transcript, "pending" when it is queued.
// `blocked` means YouTube is refusing us; cached items are still valid.
export async function lookup(ids) {
  if (!ids.length) return { blocked: false, items: {} };
  const [stored, state] = await Promise.all([chrome.storage.local.get(ids.map(cacheKey)), getState()]);
  const blocked = Date.now() < state.blockedUntil;
  const items = {};
  for (const id of ids) {
    const entry = stored[cacheKey(id)];
    if (entry) items[id] = entry.none ? null : entry;
    else {
      items[id] = "pending";
      if (!blocked && !queued.has(id)) {
        queued.add(id);
        queue.push(id);
      }
    }
  }
  if (!blocked) drain();
  return { blocked, items };
}

export async function status() {
  const state = await getState();
  return { blockedUntil: state.blockedUntil > Date.now() ? state.blockedUntil : 0, queue: queue.length };
}
