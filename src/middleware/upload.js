import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { AppError } from "./errorHandler.js";

const UPLOAD_DIR = path.resolve("uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Whitelist by MIME type — never trust the client-supplied filename/extension
// alone. Covers the material/photo/submission use cases for this app.
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const EXT_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    // Extension is derived from the verified MIME type, not the client-supplied
    // filename, to prevent extension-spoofing / path traversal via filename.
    const ext = EXT_BY_MIME[file.mimetype] || "";
    cb(null, `${unique}${ext}`);
  },
});

function fileFilter(_req, file, cb) {
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return cb(new AppError("Unsupported file type", 400));
  }
  cb(null, true);
}

export const upload = multer({
  storage,
  fileFilter,
  // NOTE: no `files` limit here. This instance is shared across
  // upload.single() (materials, submissions) AND upload.array() routes
  // (student documents: up to 10, album photos: up to 20) — a global
  // files:1 cap here would reject every multi-file request regardless of
  // the per-route .array(field, maxCount) limit. Per-route counts are
  // enforced where .array()/.single() is called (see routes/*.js).
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
});

// Builds the initial stored URL at upload time. What's actually served is
// re-signed fresh on every read (see src/lib/signedFileUrl.js) — this
// value only needs to carry the filename through to storage; the
// protocol/host portion is discarded and rebuilt at read time.
export function fileUrl(req, filename) {
  return `${req.protocol}://${req.get("host")}/api/files/${filename}`;
}
