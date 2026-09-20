# ECCD SmartTrack — face-recognition service

A small private HTTP service that answers one question: *"which enrolled student
is this face closest to, and by how much?"* It never marks attendance and never
decides whether a match is good enough — the backend owns those decisions
(`FACE_MAX_DISTANCE`, `FACE_MIN_MARGIN`).

```
Teacher's browser ──JPEG──► Backend (auth, session check) ──JPEG + X-Service-Key──► this service
                                     ◄── [{studentId, distance, margin, box}] ──────┘
```

## Privacy — read before enrolling anyone

Enrolled photos and the face encodings derived from them are **biometric data of
children**. Before adding a child's photos:

- Get and keep **written guardian consent**, and have your school's data-protection
  officer confirm what your local privacy law requires (e.g. the Philippines'
  Data Privacy Act treats biometrics as sensitive personal information).
- Keep `Images/` off git (already in `.gitignore`), off shared drives and out of backups you don't control.
- Delete a child's folder (and call `/reload`) when they leave.
- Frames sent for recognition are processed in memory only; this service never writes or logs them.

## Setup

```bash
cd face-recognition-service
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt        # dlib compiles from source: needs cmake + g++, and is slow
export RECOGNITION_SERVICE_KEY="$(openssl rand -hex 32)"   # also give this to the backend
uvicorn app:app --host 127.0.0.1 --port 8001
```

The service **refuses to start** without a `RECOGNITION_SERVICE_KEY` of 32+ characters.

Backend `.env`:

```
RECOGNITION_SERVICE_URL="http://127.0.0.1:8001"
RECOGNITION_SERVICE_KEY="<same key>"
```

## Enrolling students

```
Images/
  12/            <- the student's numeric id in the app (NOT their name)
    front.jpg
    smiling.jpg
    side.jpg
  47/
    ...
```

- Folder names must be the numeric student id; anything else is ignored.
- Use 3–5 clear, well-lit photos per child, **each containing exactly one face** (others are skipped, with a log line).
- Small children's faces change quickly — re-take photos every few months.
- After adding or removing photos: `curl -X POST -H "X-Service-Key: $RECOGNITION_SERVICE_KEY" http://127.0.0.1:8001/reload`

## Network exposure

This service has no user accounts and only a shared key. **Never expose it to the
internet.** Run it on the same host as the backend (loopback) or on a private
network only the backend can reach. If it must cross a network, put TLS in
front of it — the backend refuses plain `http://` to a non-loopback host in production.

## Calibrating

Use the backend's own numbers, not guesses. On a short test set (each child vs. the
others, in your real classroom lighting) note the typical `distance` for the *same*
child and for *different* children, then set `FACE_MAX_DISTANCE` between them, leaning
strict — a missed detection is retried a moment later, a wrong match is not.
On adult sample photos we measured 0.13–0.35 for the same person; **children will differ**.
`FACE_MIN_MARGIN` guards against look-alikes and siblings.

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```
