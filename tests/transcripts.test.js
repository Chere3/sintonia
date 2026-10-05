import { describe, expect, test } from "bun:test";
import {
  pickTrack,
  readPlayer,
  parseTimedText,
  decodeEntities,
  nextBackoff,
  BACKOFF_START_MS,
  BACKOFF_MAX_MS,
} from "../extension/transcripts.js";

const track = (languageCode, kind) => ({ languageCode, kind, baseUrl: `https://x/${languageCode}${kind || ""}` });

describe("elección de pista (como find_transcript)", () => {
  test("manual antes que automática en el mismo idioma", () => {
    expect(pickTrack([track("es", "asr"), track("es")])).toEqual(track("es"));
  });
  test("respeta el orden de idiomas antes que el tipo", () => {
    expect(pickTrack([track("en"), track("es", "asr")]).languageCode).toBe("es");
  });
  test("sin es/en usa la primera disponible", () => {
    expect(pickTrack([track("pt", "asr"), track("fr")]).languageCode).toBe("pt");
  });
  test("sin pistas devuelve null", () => {
    expect(pickTrack([])).toBeNull();
    expect(pickTrack(undefined)).toBeNull();
  });
});

describe("respuesta del player", () => {
  test("bot detectado → bloqueado, en cualquier idioma", () => {
    expect(readPlayer({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you’re not a bot" } }).kind).toBe("blocked");
    expect(readPlayer({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Inicia sesión para confirmar que no eres un bot" } }).kind).toBe("blocked");
  });
  test("restringido por edad, no disponible o injugable → sin transcript", () => {
    expect(readPlayer({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "This video may be inappropriate for some users." } }).kind).toBe("none");
    expect(readPlayer({ playabilityStatus: { status: "ERROR", reason: "This video is unavailable" } }).kind).toBe("none");
    expect(readPlayer({ playabilityStatus: { status: "UNPLAYABLE" } }).kind).toBe("none");
  });
  test("OK sin subtítulos → sin transcript; con pistas → pistas", () => {
    expect(readPlayer({ playabilityStatus: { status: "OK" } }).kind).toBe("none");
    const ok = readPlayer({ playabilityStatus: { status: "OK" }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [track("es")] } } });
    expect(ok).toEqual({ kind: "tracks", tracks: [track("es")] });
  });
});

describe("timedtext XML", () => {
  const xml = `<?xml version="1.0" encoding="utf-8" ?><transcript>
<text start="0.1" dur="2">July 2026. Thousands of AIs</text>
<text start="2.1" dur="2">are placed in &amp;#39;solitary&amp;#39; confinement</text>
<text start="4" dur="1">&lt;i&gt;music&lt;/i&gt;</text>
<text start="5" dur="1"></text>
<text start="6" dur="1">caf&amp;#233; &amp;amp; m&#225;s</text>
</transcript>`;
  test("decodifica entidades dobles y quita etiquetas", () => {
    expect(parseTimedText(xml)).toBe("July 2026. Thousands of AIs are placed in 'solitary' confinement music café & más");
  });
  test("corta en maxChars", () => {
    expect(parseTimedText(xml, 10).length).toBeLessThanOrEqual(10);
  });
  test("entidades numéricas y con nombre", () => {
    expect(decodeEntities("&#x1F600; &lt;b&gt; &quot;x&quot; &desconocida;")).toBe('😀 <b> "x" &desconocida;');
  });
});

test("backoff: 30 min, se duplica y tiene tope", () => {
  expect(nextBackoff(0)).toBe(BACKOFF_START_MS);
  expect(nextBackoff(BACKOFF_START_MS)).toBe(2 * BACKOFF_START_MS);
  expect(nextBackoff(BACKOFF_MAX_MS)).toBe(BACKOFF_MAX_MS);
});
