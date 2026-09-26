"""ECCD SmartTrack face-recognition microservice.

Private service: only the backend calls it. It answers "which enrolled student
is this face closest to, and how sure" — never "mark them present".

  uvicorn app:app --host 127.0.0.1 --port 8001

Security posture:
  * refuses to start without a strong RECOGNITION_SERVICE_KEY;
  * authenticates BEFORE reading any request body (unauthenticated callers never
    get their upload parsed), comparing keys in constant time;
  * bounds upload size, image dimensions and face count;
  * frames are processed in memory only — never written to disk or logged;
  * errors return generic messages; API docs endpoints are disabled.
"""
from __future__ import annotations

import hmac
import logging
import os
import shutil

import cv2
import numpy as np
from fastapi import FastAPI, File, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

import recognizer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")

SERVICE_KEY = os.environ.get("RECOGNITION_SERVICE_KEY", "")
if len(SERVICE_KEY) < 32:
    raise RuntimeError("RECOGNITION_SERVICE_KEY must be set to at least 32 characters.")

KNOWN_FACES_DIR = os.environ.get("KNOWN_FACES_DIR", "./Images")
MAX_FRAME_BYTES = 300 * 1024  # a 640px JPEG is ~50 KB; the backend caps at 200 KB
MAX_BODY_BYTES = MAX_FRAME_BYTES + 4096  # multipart framing overhead
MAX_IMAGE_DIMENSION = 1920

# Enrollment: replaces a student's whole photo set (a handful of full-res
# photos, not a downscaled frame), so it gets its own, larger body budget.
ENROLL_MAX_IMAGES = 8
ENROLL_MAX_BODY_BYTES = ENROLL_MAX_IMAGES * recognizer.MAX_ENROLL_IMAGE_BYTES + 8192

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.state.known = recognizer.load_known_faces(KNOWN_FACES_DIR)


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"detail": message}, status_code=status)


@app.middleware("http")
async def guard(request: Request, call_next):
    if request.url.path == "/health":
        return await call_next(request)

    # 1. Authenticate first, in constant time.
    supplied = request.headers.get("x-service-key", "")
    if not hmac.compare_digest(supplied.encode(), SERVICE_KEY.encode()):
        return _error(401, "Unauthorized")

    # 2. Bound the body before it is parsed. A length is required: without one
    # (chunked upload) we can't bound it, so refuse rather than buffer blindly.
    if request.method == "POST":
        length = request.headers.get("content-length", "")
        if not length.isdigit():
            return _error(411, "Content-Length required")
        limit = ENROLL_MAX_BODY_BYTES if request.url.path.startswith("/enroll/") else MAX_BODY_BYTES
        if int(length) > limit:
            return _error(413, "Request too large")

    return await call_next(request)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/reload")
def reload_known_faces():
    """Re-reads KNOWN_FACES_DIR after photos are added or removed."""
    app.state.known = recognizer.load_known_faces(KNOWN_FACES_DIR)
    return {"students": len(app.state.known)}


def _sniff_image_ext(data: bytes) -> str | None:
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    return None


@app.post("/enroll/{student_id}")
async def enroll(student_id: str, photos: list[UploadFile] = File(...)):
    """Replaces this student's whole enrollment photo set, then reloads.

    Writes to a temp folder first and swaps it in with one atomic rename, so a
    failure partway through never leaves a student with zero or half-written
    photos. Every photo is size- and signature-checked before anything is
    written; `load_known_faces` (called at the end) separately enforces
    "exactly one face per photo", skipping ones that don't qualify.
    """
    if not recognizer.STUDENT_DIR_RE.match(student_id):
        return _error(400, "Invalid student id")
    if not photos:
        return _error(400, "At least one photo is required")
    if len(photos) > ENROLL_MAX_IMAGES:
        return _error(400, f"At most {ENROLL_MAX_IMAGES} photos are allowed")

    saved: list[tuple[str, bytes]] = []
    try:
        for photo in photos:
            data = await photo.read(recognizer.MAX_ENROLL_IMAGE_BYTES + 1)
            if len(data) > recognizer.MAX_ENROLL_IMAGE_BYTES:
                return _error(413, "Photo too large")
            ext = _sniff_image_ext(data)
            if ext is None:
                return _error(400, "Each photo must be a JPEG or PNG image")
            saved.append((ext, data))
    except Exception:
        log.exception("Reading enrollment upload failed")
        return _error(500, "Enrollment failed")

    student_dir = os.path.join(KNOWN_FACES_DIR, student_id)
    tmp_dir = f"{student_dir}.tmp"
    old_dir = f"{student_dir}.old"
    try:
        os.makedirs(KNOWN_FACES_DIR, exist_ok=True)
        shutil.rmtree(tmp_dir, ignore_errors=True)
        os.makedirs(tmp_dir, mode=0o700)
        for index, (ext, data) in enumerate(saved):
            with open(os.path.join(tmp_dir, f"{index}{ext}"), "wb") as f:
                f.write(data)

        # The swap-in is the only step that must not leave a student with no
        # folder at all: move the existing one aside (cheap rename, same
        # filesystem) rather than deleting it, so a failure on the next line
        # can be rolled back instead of losing the previous photos.
        shutil.rmtree(old_dir, ignore_errors=True)
        if os.path.isdir(student_dir):
            os.replace(student_dir, old_dir)
        try:
            os.replace(tmp_dir, student_dir)
        except Exception:
            if os.path.isdir(old_dir) and not os.path.isdir(student_dir):
                os.replace(old_dir, student_dir)  # restore what was there before
            raise
        shutil.rmtree(old_dir, ignore_errors=True)  # swap succeeded: drop the old copy
    except Exception:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        log.exception("Failed to store enrollment photos for student %s", student_id)
        return _error(500, "Enrollment failed")

    app.state.known = recognizer.load_known_faces(KNOWN_FACES_DIR)
    return {
        "studentId": int(student_id),
        "photosReceived": len(saved),
        "enrolled": int(student_id) in app.state.known.ids,
    }


def _process(data: bytes) -> dict | JSONResponse:
    # JPEG magic bytes: don't hand arbitrary content to the image decoder.
    if data[:3] != b"\xff\xd8\xff":
        return _error(400, "Frame must be a JPEG image")
    bgr = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if bgr is None:
        return _error(400, "Frame could not be decoded")
    height, width = bgr.shape[:2]
    if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
        return _error(400, "Frame dimensions too large")

    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    return {"width": width, "height": height, "faces": recognizer.analyze(rgb, app.state.known)}


@app.post("/recognize")
async def recognize(frame: UploadFile = File(...)):
    data = await frame.read(MAX_FRAME_BYTES + 1)
    if len(data) > MAX_FRAME_BYTES:
        return _error(413, "Frame too large")
    try:
        # Face detection is CPU-bound; keep it off the event loop.
        return await run_in_threadpool(_process, data)
    except Exception:
        log.exception("Frame processing failed")  # logs the stack trace, never the image
        return _error(500, "Recognition failed")
