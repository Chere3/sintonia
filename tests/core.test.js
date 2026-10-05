import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  inRange,
  activeProfile,
  applyRules,
  buildRequest,
  decideFromTopic,
  temasKey,
  feedbackAllowed,
  needsTranscript,
  needsDetails,
  migrateConfig,
  CONFIG_VERSION,
} from "../extension/core.js";

const at = (hh, mm = 0) => new Date(2026, 9, 5, hh, mm);
const profile = (over = {}) => ({ ...DEFAULT_CONFIG.perfiles[0], ...over });
const video = { id: "abc", title: "Cómo hacer un parser en Rust", channel: "Señor Código", handle: "@senorcodigo", duration: "12:00" };

describe("franjas horarias", () => {
  test("rango normal es [desde, hasta)", () => {
    expect(inRange(6 * 60, "06:00", "14:00")).toBe(true);
    expect(inRange(14 * 60, "06:00", "14:00")).toBe(false);
  });
  test("rango que cruza medianoche", () => {
    expect(inRange(23 * 60, "20:00", "06:00")).toBe(true);
    expect(inRange(3 * 60, "20:00", "06:00")).toBe(true);
    expect(inRange(6 * 60, "20:00", "06:00")).toBe(false);
    expect(inRange(12 * 60, "20:00", "06:00")).toBe(false);
  });
  test("perfiles por defecto cubren el día", () => {
    expect(activeProfile(DEFAULT_CONFIG, at(9)).id).toBe("manana");
    expect(activeProfile(DEFAULT_CONFIG, at(15, 30)).id).toBe("tarde");
    expect(activeProfile(DEFAULT_CONFIG, at(2)).id).toBe("noche");
    expect(activeProfile(DEFAULT_CONFIG, at(20)).id).toBe("noche");
  });
  test("override gana y uno inexistente se ignora", () => {
    expect(activeProfile(DEFAULT_CONFIG, at(9), "noche").id).toBe("noche");
    expect(activeProfile(DEFAULT_CONFIG, at(9), "nope").id).toBe("manana");
  });
  test("sin perfil que cubra la hora cae en general", () => {
    expect(activeProfile({ perfiles: [] }, at(9)).id).toBe("general");
  });
});

describe("reglas", () => {
  const cfg = { ...DEFAULT_CONFIG, global: { canales: { bloquear: ["@SenorCodigo"] }, palabras: {} } };
  test("canal bloqueado por handle, sin acentos ni mayúsculas", () => {
    expect(applyRules(cfg, profile(), video)).toMatchObject({ action: "hide", feedback: "channel" });
  });
  test("palabra bloqueada ignora acentos; en el perfil oculta sin feedback", () => {
    const p = profile({ palabras: { bloquear: ["como hacer"] } });
    expect(applyRules(DEFAULT_CONFIG, p, video)).toMatchObject({ action: "hide", feedback: null });
  });
  test("solo las reglas globales generan feedback", () => {
    const g = { ...DEFAULT_CONFIG, global: { canales: {}, palabras: { bloquear: ["parser"] } } };
    expect(applyRules(g, profile(), video)).toMatchObject({ action: "hide", feedback: "video" });
    const p = profile({ canales: { bloquear: ["@senorcodigo"] } });
    expect(applyRules(DEFAULT_CONFIG, p, video)).toMatchObject({ action: "hide", feedback: null });
  });
  test("global se evalúa antes que el perfil", () => {
    const p = profile({ canales: { permitir: ["Señor Código"] } });
    expect(applyRules(cfg, p, video).action).toBe("hide");
  });
  test("sin coincidencias devuelve null", () => {
    expect(applyRules(DEFAULT_CONFIG, profile(), video)).toBeNull();
  });
  test("listas vacías o con strings vacíos no coinciden con todo", () => {
    expect(applyRules(DEFAULT_CONFIG, profile({ palabras: { bloquear: [""] } }), video)).toBeNull();
  });
});

describe("decisión por tema", () => {
  const cfg = DEFAULT_CONFIG;
  const manana = profile(); // estricto, quiere programacion/ciencia/negocios/tecnologia
  const noche = { ...DEFAULT_CONFIG.perfiles[2] }; // no estricto
  const cls = (topic, confidence, probabilities) => ({ topic, confidence, probabilities });

  test("quiero → mostrar", () => {
    expect(decideFromTopic(cfg, manana, cls("programacion", 0.95)).action).toBe("show");
  });
  test("suma la masa de varios temas que quiere", () => {
    const c = cls("programacion", 0.46, { programacion: 0.46, ciencia: 0.39, tecnologia: 0.15 });
    expect(decideFromTopic(cfg, manana, c)).toMatchObject({ action: "show" });
    expect(decideFromTopic(cfg, manana, c).doubtful).toBeUndefined();
  });
  test("evitado en todos los perfiles y confianza alta → ocultar con feedback", () => {
    expect(decideFromTopic(cfg, manana, cls("drama", 0.95))).toMatchObject({ action: "hide", feedback: "video" });
  });
  test("evitado solo en este perfil → ocultar sin feedback", () => {
    expect(decideFromTopic(cfg, manana, cls("gaming", 0.99))).toMatchObject({ action: "hide", feedback: null });
  });
  test("estricto oculta lo que claramente no quiere, aunque el tema sea dudoso", () => {
    const c = cls("cine", 0.61, { cine: 0.61, negocios: 0.2, drama: 0.13, otro: 0.06 });
    expect(decideFromTopic(cfg, manana, c)).toMatchObject({ action: "hide", feedback: null });
  });
  test("estricto con masa repartida entre quiero y no quiero → dudoso", () => {
    const c = cls("ciencia", 0.5, { ciencia: 0.5, drama: 0.3, otro: 0.2 });
    expect(decideFromTopic(cfg, manana, c)).toMatchObject({ action: "show", doubtful: true });
  });
  test("no estricto muestra lo neutro y solo duda si hay bastante masa evitada", () => {
    expect(decideFromTopic(cfg, noche, cls("noticias", 0.9)).action).toBe("show");
    const mezcla = cls("drama", 0.5, { drama: 0.5, cine: 0.5 });
    expect(decideFromTopic(cfg, noche, mezcla)).toMatchObject({ action: "show", doubtful: true });
  });
  test("resultado sin probabilidades (caché antigua) sigue funcionando", () => {
    expect(decideFromTopic(cfg, noche, { topic: "drama", confidence: 0.4 })).toMatchObject({ action: "show" });
  });
});

describe("petición al clasificador", () => {
  test("incluye «otro» y recorta la transcripción", () => {
    const cfg = { ...DEFAULT_CONFIG, transcripts: { ...DEFAULT_CONFIG.transcripts, chars: 10 } };
    const req = buildRequest(cfg, { ...video, transcript: "0123456789ABCDEF" });
    expect(Object.keys(req.questions.tema.criteria)).toContain("otro");
    expect(req.state).toContain("0123456789");
    expect(req.state).not.toContain("ABC");
  });
  test("sin transcripción no agrega la línea", () => {
    expect(buildRequest(DEFAULT_CONFIG, video).state).not.toContain("Transcripción");
  });
  test("temasKey cambia al cambiar temas y no depende del orden", () => {
    expect(temasKey({ a: "1", b: "2" })).toBe(temasKey({ b: "2", a: "1" }));
    expect(temasKey({ a: "1" })).not.toBe(temasKey({ a: "2" }));
  });
});

test("límite por hora con ventana deslizante", () => {
  const now = 10_000_000;
  const ts = [now - 4000_000, now - 100, now - 200];
  expect(feedbackAllowed(ts, 2, now)).toMatchObject({ ok: false, recent: [now - 100, now - 200] });
  expect(feedbackAllowed(ts, 3, now).ok).toBe(true);
});

describe("señal más barata primero", () => {
  const cfg = DEFAULT_CONFIG;
  const p = profile();
  const dudoso = { topic: "ciencia", confidence: 0.5, probabilities: { ciencia: 0.5, drama: 0.3, otro: 0.2 } };
  const claro = { topic: "ciencia", confidence: 0.9 };
  test("título dudoso pide detalles; título claro es final", () => {
    expect(needsDetails(cfg, p, { ...dudoso, src: "titulo" })).toBe(true);
    expect(needsDetails(cfg, p, { ...claro, src: "titulo" })).toBe(false);
    expect(needsTranscript(cfg, p, { ...dudoso, src: "titulo" })).toBe(false);
  });
  test("lo dudoso se juzga con el perfil activo", () => {
    const repartido = { topic: "programacion", confidence: 0.46, src: "titulo", probabilities: { programacion: 0.46, ciencia: 0.39, tecnologia: 0.15 } };
    expect(needsDetails(cfg, p, repartido)).toBe(false);
  });
  test("detalles dudosos piden transcripción", () => {
    expect(needsTranscript(cfg, p, { ...dudoso, src: "detalles" })).toBe(true);
    expect(needsTranscript(cfg, p, { ...claro, src: "detalles" })).toBe(false);
    expect(needsDetails(cfg, p, { ...dudoso, src: "detalles" })).toBe(false);
  });
  test("resultados finales o antiguos no piden nada", () => {
    for (const src of ["transcripcion", "sin-transcripcion", undefined]) {
      expect(needsDetails(cfg, p, { ...dudoso, src })).toBe(false);
      expect(needsTranscript(cfg, p, { ...dudoso, src })).toBe(false);
    }
  });
  test("con transcripciones apagadas nunca la pide", () => {
    const off = { ...cfg, transcripts: { ...cfg.transcripts, activo: false } };
    expect(needsTranscript(off, p, { ...dudoso, src: "detalles" })).toBe(false);
  });
  test("los detalles entran al estado del clasificador", () => {
    const req = buildRequest(cfg, { ...video, details: { category: "Music", keywords: ["indie"], description: "beat" } });
    expect(req.state).toContain("Categoría de YouTube: Music");
    expect(req.state).toContain("Etiquetas: indie");
    expect(req.state).toContain("Descripción: beat");
  });
});

describe("migración v1 → v2", () => {
  const v1 = {
    temas: { programacion: "mi descripción", drama: "x" },
    perfiles: [
      { id: "manana", quiero: ["programacion"], evitar: ["drama"] },
      { id: "noche", quiero: [], evitar: [] },
      { id: "mio", quiero: [], evitar: [] },
    ],
  };
  const m = migrateConfig(v1);
  test("agrega los temas nuevos sin tocar descripciones existentes", () => {
    expect(m.version).toBe(CONFIG_VERSION);
    expect(m.temas.programacion).toBe("mi descripción");
    for (const t of ["tecnologia", "noticias", "cine", "vlogs"]) expect(m.temas[t]).toBeTruthy();
  });
  test("los asigna solo a los perfiles por defecto que los quieren", () => {
    expect(m.perfiles[0].quiero).toEqual(["programacion", "tecnologia"]);
    expect(m.perfiles[1].quiero).toEqual(["cine", "vlogs"]);
    expect(m.perfiles[2].quiero).toEqual([]);
  });
  test("no muta el original y es idempotente", () => {
    expect(v1.temas.tecnologia).toBeUndefined();
    expect(migrateConfig(m)).toBe(m);
  });
  test("los perfiles por defecto solo usan temas que existen", () => {
    for (const p of DEFAULT_CONFIG.perfiles)
      for (const t of [...p.quiero, ...p.evitar]) expect(DEFAULT_CONFIG.temas[t]).toBeTruthy();
  });
});
