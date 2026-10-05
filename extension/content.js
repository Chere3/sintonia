// Runs on youtube.com at document_start. Touches the home feed and the
// watch-page sidebar. YouTube recycles renderer nodes on scroll, so every
// decision is keyed by video id and re-checked against the node's current id.
//
// Fail-closed: content.css veils every yt-lockup-view-model that lacks
// data-sintonia-decided (invisible, unclickable) on pages flagged by
// html[data-sintonia-page]. The mark lives on the lockup, not on the card:
// YouTube reuses ytd-rich-item-renderer across feeds but always creates a
// fresh lockup for a new video, so a recycled card starts veiled by itself.
// It becomes visible once it has a decision, or after WATCHDOG_MS as a last
// resort so a dead service worker never blanks YouTube.

const ITEMS = {
  "/": "ytd-rich-item-renderer",
  "/watch": "#related yt-lockup-view-model",
};
const PAGE_KIND = { "/": "home", "/watch": "watch" };
const WATCHDOG_MS = 4000;
const RECHECK_MS = 8000;

const decisions = new Map(); // videoId -> { action, reason, feedback, ... }
const details = new Map(); // videoId -> { category, keywords, description } | null (fetch failed)
const recheckNow = new Set(); // provisional decisions to ask about again
let profileId = null;
let profileName = "";
let scanTimer = null;
let retryTimer = null;
let inFlight = false;
let enabled = true;
// YouTube renders the next page's cards before it updates location (that
// happens around yt-navigate-finish), so the target path is tracked from
// yt-navigate-start; with location.pathname the home cards waited for
// navigation to finish before being scanned.
let pagePath = location.pathname;

const MENU_TEXT = {
  video: /^(not interested|no me interesa)$/i,
  channel: /^(don't recommend channel|no recomendar (este )?canal)$/i,
};

// The veil only applies where Sintonía filters; elsewhere (subscriptions,
// search) and when disabled, the attribute is absent and YouTube is untouched.
function setPage(path = pagePath) {
  const kind = enabled ? PAGE_KIND[path] : null;
  if (kind) document.documentElement.dataset.sintoniaPage = kind;
  else delete document.documentElement.dataset.sintoniaPage;
}

function videoIdOf(el) {
  const host = el.querySelector(".ytLockupViewModelHost");
  const m = host?.className.match(/content-id-([\w-]{11})/);
  if (m) return m[1];
  const href = el.querySelector('a[href*="/watch?v="]')?.getAttribute("href");
  return href?.match(/v=([\w-]{11})/)?.[1] || null;
}

function extract(el, id) {
  const titleLink = el.querySelector("a.ytLockupMetadataViewModelTitle");
  // Another extension injects a rewritten title span (.cbCustomTitle); skip it.
  const span = titleLink?.querySelector(".ytAttributedStringHost:not(.cbCustomTitle)");
  const title = (span || titleLink)?.textContent.trim() || "";
  const chLink = el.querySelector('a[href^="/@"], a[href^="/channel/"]');
  const channel =
    chLink?.textContent.trim() ||
    el.querySelector(".ytContentMetadataViewModelMetadataText")?.textContent.trim() ||
    "";
  const handle = chLink?.getAttribute("href")?.replace(/^\//, "") || "";
  const duration = el.querySelector(".ytBadgeShapeText")?.textContent.trim() || "";
  const v = { id, title, channel, handle, duration };
  if (details.has(id)) v.details = details.get(id);
  return v;
}

function lockupOf(el) {
  return el.matches("yt-lockup-view-model") ? el : el.querySelector("yt-lockup-view-model");
}

function clearMarks(el) {
  el.classList.remove("sintonia-oculto", "sintonia-revelado");
  el.querySelector(":scope > .sintonia-badge")?.remove();
  el.removeAttribute("title");
  const lock = lockupOf(el);
  if (lock) delete lock.dataset.sintoniaDecided;
}

function apply(el, d) {
  clearMarks(el);
  if (!d || d.action === "pending") return; // stays veiled
  const lock = lockupOf(el);
  if (lock) lock.dataset.sintoniaDecided = el.dataset.sintoniaId;
  if (d.action === "hide") {
    el.classList.add("sintonia-oculto");
    const badge = document.createElement("div");
    badge.className = "sintonia-badge";
    const text = document.createElement("span");
    text.textContent = `Oculto · ${d.reason} · ${profileName}`;
    const btn = document.createElement("button");
    btn.textContent = "Ver";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      el.classList.toggle("sintonia-revelado");
      btn.textContent = el.classList.contains("sintonia-revelado") ? "Ocultar" : "Ver";
    });
    badge.append(text, btn);
    el.prepend(badge);
  } else if (d.reason) {
    el.title = `Sintonía: ${d.reason}`;
  }
}

function itemSelector() {
  return ITEMS[pagePath] || null;
}

async function scan() {
  const selector = itemSelector();
  if (!selector) {
    // Other feeds (subscriptions, channels) reuse the same renderer nodes.
    for (const el of document.querySelectorAll("[data-sintonia-id]")) {
      clearMarks(el);
      delete el.dataset.sintoniaId;
    }
    return;
  }
  const now = Date.now();
  const items = [...document.querySelectorAll(selector)];
  const ask = [];
  for (const el of items) {
    const id = videoIdOf(el);
    if (!id) continue; // ads, shelves: no lockup, never veiled
    const lock = lockupOf(el);
    // A replaced lockup carries no mark: force a re-apply for this card.
    if (el.dataset.sintoniaId !== id || !lock?.dataset.sintoniaDecided) el.dataset.sintoniaApplied = "";
    if (el.dataset.sintoniaId !== id) {
      clearMarks(el);
      el.dataset.sintoniaId = id;
      el.dataset.sintoniaApplied = "";
      el.dataset.sintoniaSeen = now;
    }
    const d = decisions.get(id);
    if (d) {
      // The badge names the profile, so a profile switch must re-render it.
      const marker = `${d.action}|${d.reason}|${profileName}`;
      if (el.dataset.sintoniaApplied !== marker) {
        apply(el, d);
        el.dataset.sintoniaApplied = marker;
      }
      if (recheckNow.has(id)) {
        recheckNow.delete(id);
        ask.push(extract(el, id));
      }
    } else if (now - el.dataset.sintoniaSeen > WATCHDOG_MS && !lock?.dataset.sintoniaDecided) {
      apply(el, { action: "show", reason: "sin respuesta" }); // last resort, see header
    }
    if (!d && !ask.some((v) => v.id === id)) ask.push(extract(el, id));
  }
  if (!ask.length || inFlight) return;

  inFlight = true;
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "classify", videos: ask });
  } catch {
    res = null; // extension reloaded underneath us
  } finally {
    inFlight = false;
  }
  if (!res?.ok) return;
  if (res.disabled) {
    enabled = false;
    setPage();
    decisions.clear();
    for (const el of items) clearMarks(el);
    return;
  }
  receive(res);
}

// Handles both the immediate reply and results pushed later by the service
// worker as each classification finishes.
function receive({ profile, decisions: incoming }) {
  if (profileId && profileId !== profile.id) decisions.clear();
  profileId = profile.id;
  profileName = profile.nombre;
  let anyPending = false;
  for (const [id, d] of Object.entries(incoming)) {
    decisions.set(id, d);
    if (d.feedback) enqueueFeedback(id, d.feedback);
    if (d.needDetails) enqueueDetails(id);
    if (d.action === "pending") anyPending = true;
    if (d.retry) setTimeout(() => (recheckNow.add(id), scheduleScan(0)), RECHECK_MS);
  }
  scheduleScan(0);
  if (anyPending) scheduleRetry();
}

// Safety net if a pushed result never arrives (service worker evicted
// mid-job): forget pending entries so the next scan asks again.
function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    for (const [id, d] of decisions) if (d.action === "pending") decisions.delete(id);
    scheduleScan(0);
  }, 5000);
}

// Throttle, not debounce: while YouTube renders a feed it mutates the DOM
// continuously, and a debounce kept postponing the scan (~160 ms on a cache
// hit). An already scheduled scan is never pushed back; delay 0 pulls it in.
function scheduleScan(delay = 50) {
  if (scanTimer && delay > 0) return;
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    scanTimer = null;
    scan();
  }, delay);
}

// Marks stay until the new decision arrives, so nothing flickers.
function resetAll() {
  decisions.clear();
  scheduleScan(0);
}

// --- Video details (description, category, keywords) ---
// Same-origin call to YouTube's own player endpoint, only for videos whose
// title alone was doubtful. Cheap (~10–15 KB) and needs no transcript server.

let clientVersion = null;
const detailsQueue = [];
const detailsAsked = new Set();
let detailsBusy = 0;

function innertubeVersion() {
  if (clientVersion) return clientVersion;
  for (const s of document.scripts) {
    const m = s.textContent.match(/"INNERTUBE_CLIENT_VERSION":"([\d.]+)"/);
    if (m) return (clientVersion = m[1]);
  }
  return "2.20261002.10.00";
}

async function fetchDetails(id) {
  try {
    const res = await fetch("/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId: id, context: { client: { clientName: "WEB", clientVersion: innertubeVersion(), hl: "es" } } }),
    });
    const j = await res.json();
    const vd = j.videoDetails;
    if (!vd) return null;
    return {
      category: j.microformat?.playerMicroformatRenderer?.category || "",
      keywords: (vd.keywords || []).slice(0, 12),
      description: (vd.shortDescription || "").slice(0, 700),
    };
  } catch {
    return null;
  }
}

function enqueueDetails(id) {
  if (detailsAsked.has(id)) return;
  detailsAsked.add(id);
  detailsQueue.push(id);
  while (detailsBusy < 2 && detailsQueue.length) {
    detailsBusy++;
    (async () => {
      while (detailsQueue.length) {
        const next = detailsQueue.shift();
        details.set(next, await fetchDetails(next));
        decisions.delete(next); // re-ask the background with details attached
        scheduleScan(100);
      }
      detailsBusy--;
    })();
  }
}

// --- Feedback to YouTube ("Not interested" / "Don't recommend channel") ---
// Sent one at a time through the item's own menu. The background has already
// applied the mode and the hourly cap; this only performs the clicks.

const feedbackQueue = [];
let feedbackBusy = false;

function enqueueFeedback(id, kind) {
  feedbackQueue.push({ id, kind });
  if (!feedbackBusy) drainFeedback();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 2500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = fn();
    if (v) return v;
    await sleep(100);
  }
  return null;
}

async function sendFeedback({ id, kind }) {
  const el = [...document.querySelectorAll(`[data-sintonia-id="${id}"]`)].find((e) => videoIdOf(e) === id);
  if (!el) throw new Error("el video ya no está en el feed");
  const menuBtn = el.querySelector('button[aria-label="More actions"], button[aria-label="Más acciones"]');
  if (!menuBtn) throw new Error("no encontré el botón de menú");
  el.classList.add("sintonia-enviando");
  document.documentElement.classList.add("sintonia-enviando");
  try {
    menuBtn.click();
    const option = await waitFor(() =>
      [...document.querySelectorAll("yt-list-item-view-model")].find(
        (i) => i.getClientRects().length && MENU_TEXT[kind].test(i.textContent.trim())
      )
    );
    if (!option) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
      throw new Error("no apareció la opción del menú");
    }
    option.click();
    await sleep(500);
  } finally {
    el.classList.remove("sintonia-enviando");
    document.documentElement.classList.remove("sintonia-enviando");
  }
}

async function drainFeedback() {
  feedbackBusy = true;
  while (feedbackQueue.length) {
    const job = feedbackQueue.shift();
    let ok = true;
    let error = null;
    try {
      await sendFeedback(job);
    } catch (e) {
      ok = false;
      error = String(e.message || e);
    }
    chrome.runtime.sendMessage({ type: "feedback-result", id: job.id, ok, error }).catch(() => {});
    await sleep(3000 + Math.random() * 3000);
  }
  feedbackBusy = false;
}

// --- Autoplay guard ---
// When a video ends with autoplay on, YouTube plays the video behind the
// player's "next" button. If that one is hidden (or never classified) we jump
// to the first wanted video in the sidebar instead, or cancel autoplay when
// there is none. Playlists are left alone: the user picked their order.

let lastUserInput = 0;
let autoplayRedirect = null; // { blocked, pick, ts } while a redirect is in flight

function idFromHref(href) {
  return href?.match(/[?&]v=([\w-]{11})/)?.[1] || null;
}

function autoplayOn() {
  return document.querySelector(".ytp-autonav-toggle-button")?.getAttribute("aria-checked") === "true";
}

function pickAllowed(excludeIds) {
  const items = [...document.querySelectorAll(ITEMS["/watch"])];
  const allowed = (strict) =>
    items.find((el) => {
      const id = el.dataset.sintoniaId;
      const d = id && decisions.get(id);
      return d && !excludeIds.includes(id) && d.action === "show" && (!strict || !d.doubtful);
    });
  return allowed(true) || allowed(false) || null; // prefer confident picks
}

function onVideoEnded(e) {
  if (!(e.target instanceof HTMLVideoElement) || location.pathname !== "/watch") return;
  const params = new URLSearchParams(location.search);
  if (params.has("list") || !autoplayOn()) return;
  const current = params.get("v");
  const next = idFromHref(document.querySelector("a.ytp-next-button")?.getAttribute("href"));
  const d = next && decisions.get(next);
  if (d && d.action === "show") return; // YouTube's choice is fine

  const pickEl = pickAllowed([current, next]);
  if (!pickEl) {
    document.querySelector(".ytp-autonav-endscreen-upnext-cancel-button")?.click();
    return;
  }
  const pick = pickEl.dataset.sintoniaId;
  autoplayRedirect = { blocked: next, pick, ts: Date.now() };
  // Clicking the sidebar link keeps YouTube's SPA navigation (no reload).
  (pickEl.querySelector("a.ytLockupMetadataViewModelTitle") || pickEl.querySelector('a[href*="/watch?v="]'))?.click();
}

// Safety net for the race where YouTube's autoplay navigates first.
function checkAutoplayLanding() {
  const r = autoplayRedirect;
  if (!r || Date.now() - r.ts > 15000) return (autoplayRedirect = null);
  const now = new URLSearchParams(location.search).get("v");
  if (now === r.pick) return (autoplayRedirect = null);
  if (now === r.blocked && lastUserInput < r.ts) {
    autoplayRedirect = null;
    location.replace(`/watch?v=${r.pick}`);
  }
}

// --- Wiring ---

new MutationObserver(() => scheduleScan()).observe(document.documentElement, { childList: true, subtree: true });
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "decisions") receive(msg);
});
// Flag the next page before YouTube renders it, so its cards start veiled.
document.addEventListener("yt-navigate-start", (e) => {
  const url = e.detail?.url;
  if (!url) return;
  pagePath = new URL(url, location.origin).pathname;
  setPage();
  scheduleScan(0);
});
document.addEventListener("yt-navigate-finish", () => {
  pagePath = location.pathname;
  setPage();
  checkAutoplayLanding();
  scheduleScan(0);
});
// Media events do not bubble, but they do reach a capturing listener.
document.addEventListener("ended", onVideoEnded, true);
for (const type of ["pointerdown", "keydown"])
  document.addEventListener(type, (e) => e.isTrusted && (lastUserInput = Date.now()), true);
chrome.storage.onChanged.addListener((changes) => {
  if (changes.config) {
    enabled = changes.config.newValue?.enabled !== false;
    setPage();
  }
  if (changes.config || changes.override) resetAll();
});
setPage();
chrome.runtime.sendMessage({ type: "warmup" }).catch(() => {});
chrome.storage.local.get("config").then(({ config }) => {
  enabled = config?.enabled !== false;
  setPage();
});
// The watchdog needs a tick even when the page is quiet.
setInterval(() => scheduleScan(0), 1000);
// Profiles switch by clock; re-evaluate every few minutes.
setInterval(resetAll, 5 * 60 * 1000);
scheduleScan(0);
