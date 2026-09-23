# ECCD-Backend
Backend repository for ECCD SmartTrack System

## Smart attendance (face recognition + BLE)

Students are marked present automatically when both their face (camera) and their
BLE tag (ESP32) are seen at the door. Setup, calibration and operating notes:
[`docs/SMART_ATTENDANCE.md`](docs/SMART_ATTENDANCE.md). Components:
[`face-recognition-service/`](face-recognition-service/) and
[`esp32-ble-gateway/`](esp32-ble-gateway/).

## File storage

Uploaded files (photos, documents, submissions) live in an S3-compatible
bucket. Which one is decided **entirely by environment variables** — no code
changes to move between providers. See `.env.example` for both setups.

| | Neon Object Storage | AWS S3 |
|---|---|---|
| `STORAGE_DRIVER` | `s3` | `s3` |
| `S3_BUCKET`, `AWS_REGION` | your bucket / region | your bucket / region |
| `AWS_ENDPOINT_URL_S3` | the branch endpoint (from `neon env pull`) | **leave unset** |
| Credentials | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | IAM role (preferred) or the same two variables |
| Addressing | path-style (automatic when an endpoint is set) | virtual-hosted (automatic) |

`STORAGE_DRIVER=local` (the default) keeps files in `./uploads`, which is fine
for development or a single server but is invisible to other instances and lost
on ephemeral disks.

### How it works

- Buckets stay **private**. Files are streamed through `GET /api/files/:name`,
  which still requires the short-lived signed URL, so access control is the
  same regardless of provider. The frontend needs no change.
- Each object's key is its generated filename — the same value already stored
  (inside a URL) in the database — so **changing provider never touches
  database rows**.
- Uploads are validated (type whitelist + file-signature check) in a temp
  directory first; only files that pass are written to storage, and anything
  rejected afterwards is deleted from it again.
- Everything provider-specific lives in `src/storage/`. To support another
  provider, implement the four functions in `src/storage/index.js`
  (`put`, `get`, `head`, `remove`).

### Moving from local disk to a bucket

1. Set the `S3_*` / `AWS_*` variables for your provider (leave
   `STORAGE_DRIVER=local` for now).
2. `npm run storage:migrate -- --dry-run` — reports what would be copied.
3. `npm run storage:migrate` — copies `./uploads` into the bucket. Safe to
   re-run (already-copied files are skipped, so an interrupted run resumes),
   verifies each file by size, and never deletes the originals.
4. Set `STORAGE_DRIVER=s3` and restart. Keep `./uploads` until you have
   confirmed files open correctly.

### Moving from Neon to AWS S3 (or back)

Copy the objects between buckets (for example `aws s3 sync`, using
`--endpoint-url` for the Neon side), then change the variables in the table
above and restart. Keys are identical, so no database changes are needed.

### AWS IAM policy

Grant only what the app uses. `s3:ListBucket` is included deliberately: without
it, S3 answers a request for a *missing* object with 403 instead of 404, which
the app would report as a server error rather than "not found".

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::<YOUR_BUCKET_NAME>" },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::<YOUR_BUCKET_NAME>/*" }
  ]
}
```

Also enable "Block all public access" on the bucket. Neon Object Storage is
currently in beta; create the bucket as `private` (the default).
