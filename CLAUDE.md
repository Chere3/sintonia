# CLAUDE.md

Sintonía: extensión Chrome MV3 + servidor Python local. Lee `README.md` para el flujo completo.

## Estructura

| Ruta | Qué es |
|---|---|
| `extension/core.js` | Lógica pura (perfiles, reglas, petición al clasificador, decisión). Sin `chrome.*`; la importan el SW, las opciones y los tests |
| `extension/background.js` | Service worker **ESM** (`"type": "module"`). Dueño de la caché `cls`, stats, registro de feedback y llamadas a Jev/Laya/servidor |
| `extension/content.js` | Inicio (`/`, `ytd-rich-item-renderer`) y barra lateral de `/watch` (`#related yt-lockup-view-model`). Extrae, marca y ejecuta clics de feedback. Script clásico, no puede importar |
| `extension/popup.*`, `options.*` | UI en español |
| `server/server.py` | `uv run server.py`. `POST /transcripts {ids}` → `{status, items: {id: {text,lang} | null | "pending"}}`, cache SQLite `transcripts.db` |
| `tests/` | `bun test` sobre `core.js` |

Sin paso de build: los cambios se ven al recargar la extensión en `chrome://extensions` (Dia).

## Invariantes

- **YouTube recicla nodos al hacer scroll.** Todo se indexa por video id (clase `content-id-XXXXXXXXXXX` en `.ytLockupViewModelHost`). `scan()` compara `dataset.sintoniaId` con el id actual y limpia las marcas si cambió. Nunca guardes estado en el nodo sin esa comprobación.
- **Hay otra extensión de Diego que inyecta `.cbCustomTitle` dentro del título.** `extract()` la ignora; si no, el título sale duplicado.
- **La clasificación no depende del perfil.** Hay una sola pregunta `choice` sobre todos los temas, cacheada como `cls[id] = {topic, confidence, k}`, donde `k = temasKey(temas)`. Al cambiar los temas se invalida sola. El perfil solo se aplica en `decideFromTopic`.
- **Primero la señal más barata:** título → detalles → transcripción. Todo video nuevo se clasifica por título (`src: "titulo"`). Si queda dudoso, el background responde `pending` + `needDetails` y el content script pide a `/youtubei/v1/player` (mismo origen, ~10–15 KB, sin PO token) la categoría de YouTube, las etiquetas y la descripción. Las devuelve en `video.details` y se reclasifica (`src: "detalles"`). Si sigue dudoso, se pide la transcripción al servidor (`src: "transcripcion"`, o `"sin-transcripcion"` si no hay). Si el servidor está caído o bloqueado, se conserva el resultado anterior y se reintenta en la siguiente visita. El motivo: unos 45 transcripts en ráfaga bastaron para que YouTube bloqueara la IP (`IpBlocked`).
- **«Dudoso» depende del perfil activo y la decisión usa masa de probabilidad.** `decideFromTopic` suma las `probabilities` de Jev de los temas en `quiero` y en `evitar`; no mira solo el tema ganador. Por ejemplo, «programación 46 / ciencia 39 / tecnología 15» es un sí claro para la mañana. `needsDetails` y `needsTranscript` solo piden más información si esa suma no alcanza el `umbral` en ninguna dirección; si el perfil ya decidió, no se gasta nada. `CLS_VERSION` en `background.js` invalida la caché cuando cambia la forma de las entradas (v2 añadió `probabilities`).
- **Migraciones de config:** `migrateConfig` (`CONFIG_VERSION`) agrega temas nuevos a configuraciones guardadas sin pisar descripciones editadas. Al agregar temas por defecto, súbele la versión y extiende `V2_TOPICS` (o crea un `V3_TOPICS`).
- **El servidor usa un solo worker a propósito**, con pausas de 2 a 4 s y backoff de 30 min que se duplica en cada bloqueo seguido (tope de 8 h). Los transcripts en caché se devuelven aunque haya bloqueo. No subas la concurrencia.
- **El feedback es de toda la cuenta y no depende de la hora.** Solo lo generan reglas de `global` (`applyRules`) y temas en `evitar` de todos los perfiles (`decideFromTopic`). Nunca lo generan reglas de perfil ni ocultados por `estricto`.
- **El feedback modifica la cuenta real de YouTube.** `gateFeedback` es el único lugar que lo autoriza: aplica el modo (`apagado|simulado|activo`), el tope por hora (`feedbackSent`) y evita duplicados (`feedbackDone`). El content script solo ejecuta.
- **Guardián de autoplay** (`onVideoEnded` en `content.js`). Al terminar un video en `/watch`, sin `list=` y con `.ytp-autonav-toggle-button[aria-checked="true"]`, lee el siguiente video de `a.ytp-next-button`. Si ese video no está en `show`, hace clic en el primer video permitido de la barra lateral, prefiriendo los no dudosos; si no hay ninguno, cancela el autoplay. `checkAutoplayLanding` cubre la carrera en que YouTube navega primero: si se llega al video bloqueado sin input real del usuario (`isTrusted`), redirige con `location.replace`. Para probarlo sin tocar el ajuste real de autoplay, cambia el `aria-checked` en el DOM y dispara `new Event("ended")` en el `<video>`.
- **Los textos del menú dependen del idioma de YouTube.** `MENU_TEXT` en `content.js` cubre en/es; el botón se busca por `aria-label` «More actions» o «Más acciones».
- **Jev y Laya comparten protocolo** (`POST /v1/systemone`, `state` + `questions`). La única diferencia es el campo `model`: `jev-latest` o `typed-decisions`. Laya multilingual tiene 1024 tokens de contexto, por eso `transcripts.chars` es 1800 por defecto.

## Claves de storage

`config`, `override`, `cls`, `stats`, `lastError`, `feedbackLog`, `feedbackSent`, `feedbackDone`.

## Convenciones

Textos para el usuario y prompts en español. Identificadores, comentarios y logs en inglés.
