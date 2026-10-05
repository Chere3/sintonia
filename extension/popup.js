const $ = (id) => document.getElementById(id);

async function render() {
  const s = await chrome.runtime.sendMessage({ type: "status" });
  if (!s?.ok) return;
  $("enabled").checked = s.enabled;
  $("profile").textContent = s.profile.nombre;
  $("profileLabel").textContent = s.override ? "Perfil forzado" : "Perfil activo";
  $("ocultos").textContent = s.stats.ocultos || 0;
  $("mostrados").textContent = s.stats.mostrados || 0;
  $("errores").textContent = s.stats.errores || 0;
  $("backend").textContent = s.backend;
  $("feedback").textContent = s.feedbackModo;
  $("error").textContent = s.lastError ? `Último error: ${s.lastError}` : "";

  const sel = $("override");
  sel.replaceChildren(new Option("Automático (por hora)", ""));
  for (const p of s.perfiles) sel.append(new Option(`${p.nombre} · ${p.desde}–${p.hasta}`, p.id));
  sel.value = s.override || "";

  try {
    const { config } = await chrome.storage.local.get("config");
    const url = (config?.transcripts?.url || "http://127.0.0.1:8765").replace(/\/$/, "");
    const h = await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) })).json();
    $("server").textContent = h.bloqueado ? "bloqueado por YouTube" : `en línea (cola ${h.cola})`;
    $("serverDot").className = `dot ${h.bloqueado ? "bad" : "ok"}`;
  } catch {
    $("server").textContent = "apagado (clasifica solo por título)";
    $("serverDot").className = "dot bad";
  }
}

$("enabled").addEventListener("change", async (e) => {
  await chrome.runtime.sendMessage({ type: "set-enabled", enabled: e.target.checked });
  render();
});
$("override").addEventListener("change", async (e) => {
  await chrome.runtime.sendMessage({ type: "set-override", id: e.target.value });
  render();
});
$("options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
render();
