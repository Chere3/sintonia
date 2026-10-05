<div align="center">

# Sintonía

**Tu feed de YouTube, filtrado según lo que de verdad quieres ver a esta hora.**

*Mañanas para aprender, noches para música y comedia. Una extensión de Chrome que oculta todo lo demás y le puede enseñar al propio algoritmo de YouTube a dejar de sugerirlo.*

[![CI](https://github.com/Chere3/sintonia/actions/workflows/ci.yml/badge.svg)](https://github.com/Chere3/sintonia/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)

[English](README.md) · [Cómo funciona](#cómo-funciona) · [Instalación](#instalación) · [Privacidad](#qué-sale-de-tu-computadora) · [Limitaciones](#limitaciones-honestas)

![Sintonía ocultando videos fuera de perfil en el inicio de YouTube](docs/img/feed.png)

<sub>Perfil Mañana: se quedan programación y tecnología; cine, música, noticias y gaming se colapsan con el motivo. Miniaturas difuminadas para la captura.</sub>

</div>

## Por qué existe

Las recomendaciones de YouTube optimizan una sola cosa: que sigas viendo. No saben que a las 9 de
la mañana querías una charla sobre compiladores y no el video de drama que te desveló anoche.

Los controles que trae YouTube son toscos. «No me interesa» va de video en video y es permanente:
no distingue «ahora no» de «nunca». Sintonía agrega la pieza que falta, **la hora**:

- Defines **temas** en lenguaje natural («programación, software, tutoriales de IA»).
- Defines **perfiles por franja horaria**: qué quieres, qué evitas y qué tan estricto ser.
- Cada recomendación se clasifica y se muestra, o se colapsa con el motivo
  (`Oculto · gaming 84% · evitar 87% · Mañana`, con un botón *Ver*).

## Qué hace

- Filtra **el inicio y la barra lateral** del video que estás viendo, en vivo y con scroll infinito.
- **Protege el autoplay.** Al terminar un video, si YouTube iba a reproducir algo que habrías
  ocultado, salta al primer video que sí quieres.
- **Perfiles por hora** (`06:00–14:00`, `20:00–06:00`…, pueden cruzar medianoche), con un
  selector en el popup para forzar uno.
- **Reglas antes que IA:** listas de canales y palabras permitidas o bloqueadas, globales o por perfil.
- **Reentrenamiento (opcional):** puede pulsar por ti «No me interesa» / «No recomendar canal».
  Viene en **modo simulado** y solo actúa con lo que evitas en *todos* los perfiles, para que un
  filtro de la mañana no arruine tu feed de la noche.

## Cómo funciona

Va **de la señal más barata a la más cara**. Primero clasifica por título, canal y duración. Si el
perfil activo aún no puede decidir, le pide a YouTube la categoría, las etiquetas y la descripción
del video (mismo origen, ~10–15 KB). Solo si sigue dudoso usa el inicio de la transcripción, que
saca un servidor local con `youtube-transcript-api`. En un inicio real quedaron **0 videos dudosos
de 24**, sin pedir ni una transcripción.

**Decide por suma de probabilidades, no por el tema ganador.** El clasificador contesta una sola
pregunta de opción múltiple sobre todos tus temas y devuelve una probabilidad por tema. Un video de
Kurzgesagt sobre agentes de IA salió *programación 46 % · ciencia 39 % · tecnología 15 %*. Ninguno
pasa el umbral de 70 %, pero los tres son de la mañana, así que se **muestra con seguridad (100 %)**.

**Una clasificación sirve para todos los perfiles.** La pregunta no depende del perfil, así que se
guarda por video. Cambiar de *Mañana* a *Noche* re-decide todo el feed al instante, sin llamadas nuevas.

El clasificador es [Jev](https://docs.typesafe.ai) (TypeSafe AI), una API rápida de decisiones
tipadas (~0.2 s por llamada). [Laya](https://huggingface.co/convaiinnovations/laya), un modelo de
pesos abiertos con el mismo protocolo, puede usarse como backend local.

## Instalación

Necesitas un navegador Chromium (Chrome, Arc, Brave, Dia…), [uv](https://docs.astral.sh/uv/) y una
key de Jev (o un servidor Laya local).

```bash
git clone https://github.com/Chere3/sintonia.git
cd sintonia/server && uv run server.py      # transcripts en 127.0.0.1:8765 (opcional)
```

1. Abre `chrome://extensions`, activa el **modo desarrollador**, pulsa **Cargar descomprimida** y
   elige la carpeta `extension/`.
2. En las opciones de la extensión pega tu key de Jev y ajusta temas y perfiles.
3. Abre YouTube.

Sin el servidor, Sintonía clasifica solo con título, descripción y categoría.

## Qué sale de tu computadora

| Dato | A dónde va | Cuándo |
|---|---|---|
| Título, canal, duración | API de Jev (`api.typesafe.ai`) | Una vez por video nuevo |
| Descripción, categoría, etiquetas | API de Jev | Solo si el título era dudoso |
| Primeros ~1,800 caracteres de la transcripción | API de Jev | Solo si sigue dudoso |
| Todo | Ningún lado | Con el backend Laya, todo queda local |

Sintonía no lee tu historial ni tus cookies, y no envía nada de tu cuenta a terceros. El servidor
de transcripts solo habla con YouTube.

## Limitaciones honestas

- **YouTube limita la descarga de transcripts.** Unos 45 transcripts en ráfaga bastaron para que
  bloqueara una IP residencial (`IpBlocked`). Por eso la transcripción es el último recurso, el
  servidor usa un solo worker con pausas de 2–4 s y, ante un bloqueo, espera 30 min (y duplica). Los
  transcripts en caché siguen funcionando durante el bloqueo.
- **El backend Laya no está probado de punta a punta.** Usa el mismo protocolo que Jev, pero el
  modelo base acierta casi al azar sin entrenar; usa el checkpoint `typed-decisions`.
- **Depende del DOM de YouTube.** Los selectores salen de la página real en octubre de 2026. YouTube
  los va a cambiar.
- **El clickbait aún puede ganar.** Un título engañoso clasificado con confianza queda en caché.
  «Borrar caché» o una regla de canal lo corrigen.
- **Solo inicio, barra lateral y autoplay.** Shorts, búsqueda y suscripciones no se tocan.
- **El autoplay se verificó con un fin de video simulado**, todavía no con muchas cuentas regresivas
  reales.

## Desarrollo

```bash
bun test                 # lógica pura: perfiles, reglas, decisiones, pipeline, migraciones
```

No hay paso de build: edita y pulsa ↻ en la tarjeta de la extensión. [`CLAUDE.md`](CLAUDE.md)
documenta las invariantes.

## Licencia

[MIT](LICENSE)
