"""Face matching for the ECCD SmartTrack recognition service.

This module is deliberately a pure nearest-neighbour lookup: it reports WHO the
closest enrolled student is and HOW FAR away, plus how far ahead of the runner-up
that match is. It never decides whether that is good enough — the backend owns
the thresholds (FACE_MAX_DISTANCE / FACE_MIN_MARGIN), so there is one place to
tune and nothing to keep in sync.

All use of the face_recognition / dlib library is confined to this file.
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass

import face_recognition
import numpy as np

log = logging.getLogger("recognizer")

# Enrolment folders must be named by the numeric student id. Anything else
# (names, "..", symlinks) is ignored, so a stray or hostile folder can't be
# picked up or steer the loader outside KNOWN_FACES_DIR.
STUDENT_DIR_RE = re.compile(r"^\d{1,9}$")
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png"}
MAX_ENROLL_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGES_PER_STUDENT = 20
MAX_FACES_PER_FRAME = 10
ENCODING_SIZE = 128


@dataclass(frozen=True)
class Match:
    student_id: int | None
    distance: float | None
    margin: float | None  # runner-up distance minus best; None if only one student is enrolled


class KnownFaces:
    """One averaged 128-d encoding per enrolled student."""

    def __init__(self, ids: list[int], encodings: np.ndarray):
        self.ids = list(ids)
        self.encodings = np.asarray(encodings, dtype=np.float64).reshape(len(ids), ENCODING_SIZE)

    def __len__(self) -> int:
        return len(self.ids)

    def match(self, encoding: np.ndarray) -> Match:
        if len(self.ids) == 0:
            return Match(None, None, None)
        distances = np.linalg.norm(self.encodings - np.asarray(encoding, dtype=np.float64), axis=1)
        order = np.argsort(distances)
        best = float(distances[order[0]])
        # Each student has exactly one encoding, so the runner-up is always a
        # DIFFERENT student — which is what makes the margin meaningful.
        margin = float(distances[order[1]] - best) if len(order) > 1 else None
        return Match(self.ids[int(order[0])], best, margin)


def load_known_faces(root: str) -> KnownFaces:
    """Loads Images/<studentId>/*.jpg|png, averaging each student's encodings."""
    ids: list[int] = []
    encodings: list[np.ndarray] = []

    if not os.path.isdir(root):
        log.warning("Known-faces directory %r does not exist; nobody is enrolled.", root)
        return KnownFaces([], np.empty((0, ENCODING_SIZE)))

    for entry in sorted(os.scandir(root), key=lambda e: e.name):
        if not entry.is_dir(follow_symlinks=False) or not STUDENT_DIR_RE.match(entry.name):
            continue
        vectors = []
        photos = sorted(os.scandir(entry.path), key=lambda e: e.name)[:MAX_IMAGES_PER_STUDENT]
        for index, photo in enumerate(photos):
            ext = os.path.splitext(photo.name)[1].lower()
            if ext not in IMAGE_EXTENSIONS or not photo.is_file(follow_symlinks=False):
                continue
            if photo.stat().st_size > MAX_ENROLL_IMAGE_BYTES:
                log.warning("Student %s photo #%d skipped: file too large.", entry.name, index)
                continue
            try:
                found = face_recognition.face_encodings(face_recognition.load_image_file(photo.path))
            except Exception:  # unreadable/corrupt image: skip it, don't abort loading everyone
                log.warning("Student %s photo #%d skipped: could not be read.", entry.name, index)
                continue
            # An enrolment photo must contain exactly one face, or we can't know
            # whose encoding it is.
            if len(found) != 1:
                log.warning("Student %s photo #%d skipped: expected 1 face, found %d.", entry.name, index, len(found))
                continue
            vectors.append(found[0])
        if vectors:
            ids.append(int(entry.name))
            encodings.append(np.mean(vectors, axis=0))

    log.info("Loaded %d enrolled student(s).", len(ids))
    return KnownFaces(ids, np.array(encodings) if encodings else np.empty((0, ENCODING_SIZE)))


def analyze(rgb: np.ndarray, known: KnownFaces) -> list[dict]:
    """Detects faces in an RGB frame and matches each against the enrolled set."""
    locations = face_recognition.face_locations(rgb, model="hog")[:MAX_FACES_PER_FRAME]
    encodings = face_recognition.face_encodings(rgb, locations)
    faces = []
    for (top, right, bottom, left), encoding in zip(locations, encodings):
        m = known.match(encoding)
        faces.append(
            {
                "box": [int(top), int(right), int(bottom), int(left)],
                "studentId": m.student_id,
                "distance": None if m.distance is None else round(m.distance, 4),
                "margin": None if m.margin is None else round(m.margin, 4),
            }
        )
    return faces
