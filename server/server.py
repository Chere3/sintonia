"""Local transcript server for the Sintonía extension.

POST /transcripts {"ids": [...]} answers immediately with whatever is cached
and queues the rest for a small background worker pool:

    {"status": "ok" | "bloqueado",
     "items": {id: {"text", "lang"} | null | "pending"}}

null means "definitively no transcript" and is cached like a hit, so
caption-less videos (music, etc.) are never refetched.
"""

import json
import logging
import os
import queue
import random
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from youtube_transcript_api import (
    AgeRestricted,
    InvalidVideoId,
    IpBlocked,
    NoTranscriptFound,
    PoTokenRequired,
    RequestBlocked,
    TranscriptsDisabled,
    VideoUnavailable,
    VideoUnplayable,
    YouTubeTranscriptApi,
)

HOST = os.environ.get("SINTONIA_HOST", "127.0.0.1")
PORT = int(os.environ.get("SINTONIA_PORT", "8765"))
DB_PATH = Path(os.environ.get("SINTONIA_DB", Path(__file__).with_name("transcripts.db")))
# One slow worker: a burst of ~45 videos with 2 workers got the IP blocked.
DELAY_S = (2.0, 4.0)  # jittered pause between videos
BACKOFF_START_S = 30 * 60  # first pause after an IP block; doubles on repeats
BACKOFF_MAX_S = 8 * 3600
MAX_CHARS = 4000  # the extension only sends the head of the transcript
MAX_FAILS = 3  # transient failures before giving up on a video
LANGS = ["es", "en"]

# Errors that mean "this video has no usable transcript": cache as null.
PERMANENT = (TranscriptsDisabled, NoTranscriptFound, VideoUnavailable, VideoUnplayable, AgeRestricted, InvalidVideoId)
BLOCKED = (IpBlocked, RequestBlocked, PoTokenRequired)

log = logging.getLogger("sintonia")

db_lock = threading.Lock()
db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.execute("CREATE TABLE IF NOT EXISTS transcripts (id TEXT PRIMARY KEY, text TEXT, lang TEXT, ts REAL)")
db.commit()

jobs: queue.Queue[str] = queue.Queue()
in_flight: set[str] = set()
fails: dict[str, int] = {}
state_lock = threading.Lock()
blocked_until = 0.0
backoff_s = BACKOFF_START_S
api = YouTubeTranscriptApi()


def cached(ids):
    with db_lock:
        marks = ",".join("?" * len(ids))
        rows = db.execute(f"SELECT id, text, lang FROM transcripts WHERE id IN ({marks})", ids).fetchall()
    return {i: (None if t is None else {"text": t, "lang": l}) for i, t, l in rows}


def store(video_id, text, lang):
    with db_lock:
        db.execute("INSERT OR REPLACE INTO transcripts VALUES (?, ?, ?, ?)", (video_id, text, lang, time.time()))
        db.commit()


def fetch_transcript(video_id):
    transcripts = api.list(video_id)
    try:
        t = transcripts.find_transcript(LANGS)
    except NoTranscriptFound:
        t = next(iter(transcripts))  # any language beats nothing
    text = " ".join(s.text.replace("\n", " ") for s in t.fetch())
    return text[:MAX_CHARS], t.language_code


def worker():
    # After a pause the next job is effectively a single probe: if it is still
    # blocked the pause doubles before anything else is tried.
    global blocked_until, backoff_s
    while True:
        video_id = jobs.get()
        try:
            wait = blocked_until - time.time()
            if wait > 0:
                time.sleep(wait)
            try:
                text, lang = fetch_transcript(video_id)
                store(video_id, text, lang)
                backoff_s = BACKOFF_START_S
            except PERMANENT:
                store(video_id, None, None)
            except StopIteration:
                store(video_id, None, None)
            except BLOCKED as e:
                blocked_until = time.time() + backoff_s
                log.warning("bloqueado por YouTube (%s); pausa de %d min", type(e).__name__, backoff_s // 60)
                backoff_s = min(backoff_s * 2, BACKOFF_MAX_S)
            except Exception as e:  # network hiccups, parse errors: retry a few times
                fails[video_id] = fails.get(video_id, 0) + 1
                log.warning("%s: %s (%d/%d)", video_id, type(e).__name__, fails[video_id], MAX_FAILS)
                if fails[video_id] >= MAX_FAILS:
                    store(video_id, None, None)
            time.sleep(random.uniform(*DELAY_S))
        finally:
            with state_lock:
                in_flight.discard(video_id)
            jobs.task_done()


def lookup(ids):
    found = cached(ids)
    items = {}
    for i in ids:
        if i in found:
            items[i] = found[i]
            continue
        items[i] = "pending"
        with state_lock:
            if i not in in_flight and time.time() >= blocked_until:
                in_flight.add(i)
                jobs.put(i)
    status = "bloqueado" if time.time() < blocked_until else "ok"
    return {"status": status, "items": items}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "cola": jobs.qsize(), "bloqueado": time.time() < blocked_until})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcripts":
            return self._send(404, {"error": "not found"})
        try:
            data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            ids = [i for i in data.get("ids", []) if isinstance(i, str) and 0 < len(i) <= 20][:100]
        except (ValueError, AttributeError):
            return self._send(400, {"error": "json inválido"})
        self._send(200, lookup(ids))

    def log_message(self, fmt, *args):
        log.debug(fmt, *args)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    threading.Thread(target=worker, daemon=True).start()
    log.info("Sintonía server en http://%s:%d (cache %s)", HOST, PORT, DB_PATH)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
