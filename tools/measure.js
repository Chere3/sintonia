// Mide el velo fail-closed de Sintonía en vivo. Pégalo en la consola de
// DevTools en youtube.com (con la extensión cargada) y luego:
//
//   await sintoniaMeasure("ytd-rich-item-renderer", () => document.querySelector("a#logo").click())
//   await sintoniaMeasure("#related yt-lockup-view-model", () => /* clic en un video */ null)
//
// Para cada tarjeta registra cómo estaba la primera vez que apareció
// (decided / veiled / EXPOSED), si alguna vez quedó expuesta sin decisión
// y cuánto tardó en tener decisión. EXPOSED debe ser siempre 0.
// Si la pestaña está en segundo plano, Chrome frena los timers: mide con
// la pestaña visible.

window.sintoniaMeasure = async (selector, trigger, waitMs = 8000) => {
  const L = { seen: {}, done: {}, first: {}, exposedSince: {} };
  const lockOf = (el) => (el.matches("yt-lockup-view-model") ? el : el.querySelector("yt-lockup-view-model"));
  const idOf = (el) => el.querySelector(".ytLockupViewModelHost")?.className.match(/content-id-([\w-]{11})/)?.[1];
  const state = (el, id) => {
    const lock = lockOf(el);
    if (!lock) return "none";
    if (lock.dataset.sintoniaDecided === id) return "decided";
    const hidden = getComputedStyle(lock).visibility === "hidden" || el.classList.contains("sintonia-oculto");
    return hidden ? "veiled" : "EXPOSED";
  };
  const tick = () => {
    const now = performance.now();
    for (const el of document.querySelectorAll(selector)) {
      const id = idOf(el);
      if (!id) continue;
      const st = state(el, id);
      if (!(id in L.seen)) {
        L.seen[id] = now;
        L.first[id] = st;
      }
      if (st === "EXPOSED" && !(id in L.exposedSince)) L.exposedSince[id] = now;
      if (st === "decided" && !(id in L.done)) L.done[id] = now;
    }
  };
  const obs = new MutationObserver(tick);
  obs.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "data-sintonia-decided"],
  });
  trigger?.();
  await new Promise((r) => setTimeout(r, waitMs));
  obs.disconnect();

  const lat = Object.keys(L.seen)
    .filter((id) => id in L.done)
    .map((id) => Math.round(L.done[id] - L.seen[id]))
    .sort((a, b) => a - b);
  const first = Object.values(L.first);
  const count = (k) => first.filter((x) => x === k).length;
  const veil = lat.filter((x) => x > 0);
  return {
    cards: first.length,
    firstSight: { decided: count("decided"), veiled: count("veiled"), EXPOSED: count("EXPOSED") },
    everExposed: Object.keys(L.exposedSince).length,
    veilP50ms: veil.length ? veil[Math.floor(veil.length / 2)] : 0,
    veilMaxMs: veil.at(-1) ?? 0,
    sortedMs: lat.join(" "),
  };
};
