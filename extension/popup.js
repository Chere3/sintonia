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

  const t = s.transcripts || {};
  if (!t.activo) {
    $("tr").textContent = "apagadas (solo título y descripción)";
    $("trDot").className = "dot";
  } else if (t.blockedUntil) {
    const until = new Date(t.blockedUntil).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
    $("tr").textContent = `YouTube las bloquea hasta las ${until}`;
    $("trDot").className = "dot bad";
  } else {
    $("tr").textContent = t.queue ? `activas (cola ${t.queue})` : "activas";
    $("trDot").className = "dot ok";
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
