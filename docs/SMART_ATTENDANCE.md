# Smart attendance: face recognition + BLE

A student is marked present **automatically** only when **both** of these are seen
at the door within a short window:

1. their **face**, matched by a camera; and
2. their **BLE tag**, heard by an ESP32.

Either one alone is never enough. A teacher can always mark attendance by hand,
and a manual entry always wins over an automatic one.

```
                         ┌───────────────────────────┐
 Teacher's phone/laptop  │  React app                │
  camera ── JPEG frames ►│  Live attendance screen   │◄── polls monitor every 2 s
                         └───────────┬───────────────┘
                                     │ HTTPS + user token (Teacher/Admin)
                                     ▼
 ESP32 ── tag sightings ►   ┌──────────────────┐   JPEG + service key   ┌────────────────────────┐
  (device key, HTTPS)       │ Backend (Node)   │ ─────────────────────► │ face-recognition-      │
                            │ sessions, rules, │ ◄── who / how close ── │ service (Python, local)│
                            │ thresholds       │                        └────────────────────────┘
                            └────────┬─────────┘
                                     ▼
                                 PostgreSQL
```

Only pixels leave the teacher's device: the server decides who is in each frame.
Frames are handled in memory and never stored.

## When is a student marked present?

`attendanceVerification.service.js` — per student, per session:

- The **face** signal counts when the smoothed match distance is `<= FACE_MAX_DISTANCE`,
  the runner-up student is at least `FACE_MIN_MARGIN` farther (so look-alikes and
  siblings come back "unknown"), and it has been seen `VERIFY_MIN_HITS` times in a row.
- The **BLE** signal counts when the smoothed RSSI is `>= BLE_MIN_RSSI` and it has
  been seen `VERIFY_MIN_HITS` times in a row.
- Both must be fresh: seen within `VERIFY_WINDOW_SEC` of now.
- Then the student is marked **present** — but only if they have **no record for
  that day yet**. An existing record (marked by a teacher, excused, or from an
  earlier verification) is never overwritten.
- Evidence (face distance, RSSI, time) is stored in `attendance_verifications`.
  The roster shows "Verified automatically". If a teacher then edits the record
  by hand, the automatic evidence is removed: a manual entry is never labelled "verified".

Nothing is auto-marked **absent**; a blank stays blank until a teacher decides.

## Setup order

1. **Backend**: `npx prisma migrate deploy`, then set the environment variables below.
2. **Gateway record**: `npm run gateway:create -- "Front door"` and keep the printed key.
3. **Recognition service**: see `face-recognition-service/README.md`. Enrol photos (with consent).
4. **ESP32**: see `esp32-ble-gateway/README.md`. Find tag addresses and calibrate first.
5. **App**: on each student's page, add their **Attendance tag** address.
6. **Try it**: press **Start Attendance** in the top bar, then **Use this device's camera**.

### Backend environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `SCHOOL_TIMEZONE` | `Asia/Manila` | "Today" for attendance is computed in this zone, not the server's |
| `RECOGNITION_SERVICE_URL` / `_KEY` | unset | Enables live face recognition. Key is 32+ random characters; must match the service |
| `FACE_MAX_DISTANCE` | `0.5` | Lower = stricter face match |
| `FACE_MIN_MARGIN` | `0.05` | Best match must beat the runner-up by this much |
| `BLE_MIN_RSSI` | `-70` | dBm; higher (e.g. `-60`) = tag must be nearer |
| `VERIFY_WINDOW_SEC` | `30` | Face and BLE must both be this recent |
| `VERIFY_MIN_HITS` | `2` | Sightings in a row each signal needs |

Bad values stop the server at startup rather than quietly loosening verification.

## Calibrate before relying on it

The defaults are starting points, not measurements.

- **BLE**: use the ESP32's `SCAN_ONLY` mode as described in its README.
- **Face**: on real photos of your enrolled children in your classroom's lighting,
  compare the distance of the *same* child with *different* children, and set
  `FACE_MAX_DISTANCE` between them, leaning strict. Small children are harder for
  this model than adults; expect to re-shoot enrolment photos every few months.

## Operating notes

- **One session at a time.** Starting again returns the running one; a session left
  open is closed automatically after 12 hours.
- **Camera lives on one device.** Choosing a device's camera is opt-in on the live
  screen. It turns off when you leave the page or the session ends.
- **Deployment header**: the frontend's `vercel.json` must allow the camera
  (`Permissions-Policy: camera=(self)`); a blanket `camera=()` blocks it silently.
- **Rate limits**: session, gateway and frame paths each have their own budgets
  (per IP before login, per user/device after) and are exempt from the general
  300-per-15-minutes limit, which polling would exhaust.
- **Old data**: `attendance_signals` rows are working state and are not purged
  automatically. Clear old sessions occasionally, e.g.
  `DELETE FROM attendance_signals WHERE "sessionId" IN (SELECT id FROM attendance_sessions WHERE status = 'closed' AND "endedAt" < now() - interval '30 days');`

## Security summary

- Teacher endpoints require a valid user token **and** the Teacher/Admin role (default deny).
- The ESP32 authenticates with its own key (`X-Device-Key`, hash-only storage,
  constant-time check); a gateway key can't reach user endpoints, and a user token
  can't reach gateway endpoints. The gateway is told only tag addresses.
- The recognition service refuses to start without a key, authenticates before
  reading any upload, and is reached only by the backend (never expose it).
- Student identity is never taken from a request body: it comes from the tag
  registry (BLE) or the recognition result (face), and thresholds live only in the backend.
- Errors to clients are generic; details go to the server log only.

## Known limits

- A cloned tag address or a photo held up to the camera could fool the system: there
  is no liveness check. That is a reasonable trade-off for a classroom; it is not
  access control.
- Lighting, angle and a child's growth affect face matching; the manual roster is the fallback.
- Face templates are biometric data of children. Get guardian consent, restrict access
  to `Images/`, and delete on leaving. Ask your data-protection officer what local law requires.
