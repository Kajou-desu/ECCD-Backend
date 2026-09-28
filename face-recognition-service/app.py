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

import asyncio
import hmac
import io
import logging
import os
import re
import shutil

import cv2
import numpy as np
from fastapi import FastAPI, File, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response
from PIL import Image

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
# A small file can still decode to a huge bitmap (decompression bomb) and dlib's
# cost grows with pixels, so bound the decoded size too. Read from the header
# only — nothing is decoded until it passes. The web app downsizes to 2000px.
ENROLL_MAX_DIMENSION = 4096

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.state.known = recognizer.load_known_faces(KNOWN_FACES_DIR)
# Serialises enrol/delete so two requests for one student can't share the
# .tmp/.old folders or interleave the folder swap with the in-memory update.
app.state.enroll_lock = asyncio.Lock()


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


def _within_dimension_limit(data: bytes) -> bool:
    try:
        with Image.open(io.BytesIO(data)) as img:
            width, height = img.size
    except Exception:
        return False
    return 0 < width <= ENROLL_MAX_DIMENSION and 0 < height <= ENROLL_MAX_DIMENSION


@app.post("/enroll/{student_id}")
async def enroll(student_id: str, photos: list[UploadFile] = File(...)):
    """Replaces this student's whole enrollment photo set.

    Photos are size-, signature- and dimension-checked, written to a temp
    folder, and face-checked THERE. Only if at least one photo holds exactly one
    face is the temp folder swapped in (one atomic rename), so neither an I/O
    failure nor a set of unusable photos can leave a student with zero or
    half-written photos — the previous enrollment stays until a good one replaces it.
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
            if not _within_dimension_limit(data):
                return _error(400, "Each photo must be a readable image of at most "
                                   f"{ENROLL_MAX_DIMENSION}px on each side")
            saved.append((ext, data))
    except Exception:
        log.exception("Reading enrollment upload failed")
        return _error(500, "Enrollment failed")

    student_dir = os.path.join(KNOWN_FACES_DIR, student_id)
    tmp_dir = f"{student_dir}.tmp"
    old_dir = f"{student_dir}.old"
    async with app.state.enroll_lock:
        try:
            os.makedirs(KNOWN_FACES_DIR, exist_ok=True)
            shutil.rmtree(tmp_dir, ignore_errors=True)
            os.makedirs(tmp_dir, mode=0o700)
            for index, (ext, data) in enumerate(saved):
                with open(os.path.join(tmp_dir, f"{index}{ext}"), "wb") as f:
                    f.write(data)

            # Face detection is CPU-bound; keep it off the event loop, and do it
            # BEFORE the swap so a bad batch can't replace a working enrollment.
            encoding, _usable = await run_in_threadpool(recognizer.encode_student_dir, tmp_dir, student_id)
            if encoding is None:
                shutil.rmtree(tmp_dir, ignore_errors=True)
                return _error(422, "No photo contained exactly one clear face")

            # Move the existing folder aside (cheap rename, same filesystem)
            # rather than deleting it, so a failure on the next line can be
            # rolled back instead of losing the previous photos.
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

        # Only this student's encoding changed: swap in a new immutable set
        # instead of re-encoding every enrolled child's photos.
        app.state.known = app.state.known.with_student(int(student_id), encoding)

    return {"studentId": int(student_id), "photosReceived": len(saved), "enrolled": True}


def _enrolled_photo_paths(student_id: str) -> list[str]:
    """Paths of this student's stored photos, in the same order the encoder reads them."""
    student_dir = os.path.join(KNOWN_FACES_DIR, student_id)
    if not os.path.isdir(student_dir):
        return []
    with os.scandir(student_dir) as it:
        entries = sorted(it, key=lambda e: e.name)[: recognizer.MAX_IMAGES_PER_STUDENT]
    return [
        e.path
        for e in entries
        if os.path.splitext(e.name)[1].lower() in recognizer.IMAGE_EXTENSIONS
        and e.is_file(follow_symlinks=False)
    ]


@app.get("/enroll/{student_id}/photos")
def list_enrolled_photos(student_id: str):
    """How many photos are stored for this student (no image data)."""
    if not recognizer.STUDENT_DIR_RE.match(student_id):
        return _error(400, "Invalid student id")
    return {"studentId": int(student_id), "count": len(_enrolled_photo_paths(student_id))}


@app.get("/enroll/{student_id}/photos/{index}")
def get_enrolled_photo(student_id: str, index: str):
    """One stored photo by position. `index` is a number, never a file name, so
    a caller cannot steer the read outside this student's own folder."""
    if not recognizer.STUDENT_DIR_RE.match(student_id):
        return _error(400, "Invalid student id")
    if not re.fullmatch(r"\d{1,2}", index):
        return _error(400, "Invalid photo index")
    paths = _enrolled_photo_paths(student_id)
    position = int(index)
    if position >= len(paths):
        return _error(404, "Not found")
    try:
        with open(paths[position], "rb") as f:
            data = f.read(recognizer.MAX_ENROLL_IMAGE_BYTES + 1)
    except OSError:  # e.g. replaced by a concurrent re-enrollment
        return _error(404, "Not found")
    ext = _sniff_image_ext(data)
    if ext is None or len(data) > recognizer.MAX_ENROLL_IMAGE_BYTES:
        return _error(404, "Not found")
    return Response(
        content=data,
        media_type="image/png" if ext == ".png" else "image/jpeg",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@app.delete("/enroll/{student_id}")
async def unenroll(student_id: str):
    """Erases a student's face photos and encoding (biometric data of a child).
    Idempotent: `removed` says whether anything was there."""
    if not recognizer.STUDENT_DIR_RE.match(student_id):
        return _error(400, "Invalid student id")

    student_dir = os.path.join(KNOWN_FACES_DIR, student_id)
    async with app.state.enroll_lock:
        try:
            existed = os.path.isdir(student_dir)
            for path in (student_dir, f"{student_dir}.tmp", f"{student_dir}.old"):
                if os.path.isdir(path):
                    shutil.rmtree(path)
        except Exception:
            log.exception("Failed to remove enrollment for student %s", student_id)
            return _error(500, "Removal failed")
        app.state.known = app.state.known.without_student(int(student_id))
    return {"studentId": int(student_id), "removed": existed}


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
