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
        if int(length) > MAX_BODY_BYTES:
            return _error(413, "Frame too large")

    return await call_next(request)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/reload")
def reload_known_faces():
    """Re-reads KNOWN_FACES_DIR after photos are added or removed."""
    app.state.known = recognizer.load_known_faces(KNOWN_FACES_DIR)
    return {"students": len(app.state.known)}


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
