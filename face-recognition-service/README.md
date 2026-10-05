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
- Deleting a student in the app now erases their enrollment automatically
  (`DELETE /enroll/{id}`). If that call ever fails it is logged as an error —
  remove the folder by hand (and call `/reload`) so no orphaned biometrics remain.
- Frames sent for recognition are processed in memory only; this service never writes or logs them.

## Setup

### Windows (local development)

The recognition service must run on the same machine as the backend, or on a
private network reachable by it. Keep it bound to loopback for local development.

1. Open PowerShell in `ECCD-Backend/face-recognition-service`. If `.venv` does
  not exist yet, create it and install the dependencies. On Windows, installing
  `dlib` may require CMake and the Visual Studio C++ Build Tools (Desktop
  development with C++ workload).

  ```powershell
  py -3.11 -m venv .venv
  .\.venv\Scripts\python.exe -m pip install -r requirements.txt
  ```

2. Generate a private key and put the same value in
  `ECCD-Backend/.env` for both variables below. Use a new random key for each
  deployment; do not commit it or share it in chat.

  ```powershell
  py -c "import secrets; print(secrets.token_hex(32))"
  ```

  ```dotenv
  RECOGNITION_SERVICE_URL="http://127.0.0.1:8001"
  RECOGNITION_SERVICE_KEY="<the generated key>"
  ```

3. In the PowerShell window for the recognition service, set the same key and
  use a private enrollment directory. Starting from this directory keeps the
  data out of the repository's shared `Images/` folder.

  ```powershell
  $env:RECOGNITION_SERVICE_KEY = "<the generated key>"
  $env:KNOWN_FACES_DIR = Join-Path (Get-Location) "enrolled_faces"
  .\.venv\Scripts\uvicorn.exe app:app --host 127.0.0.1 --port 8001
  ```

4. In a second PowerShell window, start the backend from `ECCD-Backend`:

  ```powershell
  npm.cmd run dev
  ```

  Restart the backend whenever its `.env` values change. Keep both processes
  running while using the app.

5. Verify the recognition service from PowerShell:

  ```powershell
  Invoke-RestMethod http://127.0.0.1:8001/health
  ```

  It should return `status: ok`. The attendance screen should then report face
  recognition as ready. A healthy service with no enrolled students can detect
  faces but cannot identify students.

6. After obtaining and recording guardian consent, open the student's page in
  the app and use **Face recognition enrollment**. Select 3–5 clear, well-lit
  JPEG or PNG photos, each showing only that child, then choose **Replace
  enrollment photos**. This replaces the whole enrolled set for that student;
  it is separate from the student's profile picture. The service stores these
  photos and derived face encodings in `face-recognition-service/enrolled_faces/`.

7. Start an attendance session and allow camera access on the teacher's device.
  Face matches alone do not mark attendance: the student's BLE tag must also
  be detected within the configured verification window. Calibrate face and
  BLE thresholds with consented test data before relying on automatic records.

To remove a student's enrollment, delete the student through the app (which
requests removal from the service), or remove that student's numeric folder from
`enrolled_faces/` and restart the service. Protect the enrollment directory as
biometric data and include it in backups only when those backups are authorized
and protected.

### Linux / macOS

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

For the app-based enrollment flow, use **Face recognition enrollment** on the
student's page as described above. The directory-based layout below is an
alternative for administrators managing photos directly on the service host.

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
front of it. For Railway's private network, the backend permits plain `http://`
only for `*.railway.internal` because those addresses are private to the project.

## Deploying on Railway

1. Create a service from this repository with **Root Directory** set to
   `face-recognition-service`; Railway will build the included `Dockerfile`.
2. Attach a persistent **Volume** mounted at `/data`. Enrolled photos are stored
   in `/data/Images`; without the volume, a redeploy removes all enrollments.
3. Set `RECOGNITION_SERVICE_KEY` to a random value of at least 32 characters.
   Do not generate a public domain for the recognition service.
4. In the backend service, set `RECOGNITION_SERVICE_URL` to
   `http://${{<service>.RAILWAY_PRIVATE_DOMAIN}}:8001` and
   `RECOGNITION_SERVICE_KEY` to `${{<service>.RECOGNITION_SERVICE_KEY}}`.
5. Keep one replica. Enroll students through the deployed app after recording
   guardian consent; local enrollments are not copied to the cloud.

Railway mounts volumes as `root`. The image's `entrypoint.sh` therefore starts as
root only long enough to `chown` `/data/Images` to the `app` user, then drops to
`app` before the service starts — so you do **not** need `RAILWAY_RUN_UID=0`, and
the service never runs as root. Do not add `USER app` to the Dockerfile or set
`RAILWAY_RUN_UID` to a non-zero value: either one starts the entrypoint without
root, so the ownership fix cannot run.

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
