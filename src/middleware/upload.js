import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { AppError } from "./errorHandler.js";
import { uploadLimiter } from "./rateLimit.js";
import { UPLOAD_DIR, removeUploadedFiles } from "../lib/fileStorage.js";

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

// Endpoints that only ever display pictures (album photos, profile photo)
// accept images only — a PDF or Word file there is never legitimate.
const IMAGE_MIME_TYPES = new Set([...ALLOWED_MIME_TYPES].filter((type) => type.startsWith("image/")));

const EXT_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
};

// The MIME type in a multipart upload is whatever the client says it is, so
// the whitelist above only filters honest clients. These check the file's
// actual leading bytes against what its declared type must start with.
const ascii = (bytes, start, end) => bytes.subarray(start, end).toString("latin1");
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SIGNATURES = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b.subarray(0, 8).equals(PNG_MAGIC),
  "image/gif": (b) => ["GIF87a", "GIF89a"].includes(ascii(b, 0, 6)),
  "image/webp": (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP",
  "application/pdf": (b) => ascii(b, 0, 5) === "%PDF-",
  "application/msword": (b) => b.subarray(0, 8).equals(OLE_MAGIC),
  // .docx is a zip container ("PK\x03\x04").
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": (b) =>
    b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04,
};

export async function fileMatchesDeclaredType(filePath, mimetype) {
  const check = SIGNATURES[mimetype];
  if (!check) return false; // default deny: no known signature, no accept

  const handle = await fs.promises.open(filePath, "r");
  try {
    const head = Buffer.alloc(12);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return check(head.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

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

function buildMulter(allowedTypes) {
  return multer({
    storage,
    fileFilter: (_req, file, cb) => {
      if (!allowedTypes.has(file.mimetype)) {
        return cb(new AppError("Unsupported file type", 400));
      }
      cb(null, true);
    },
    // NOTE: no `files` limit here. This instance is shared across
    // upload.single() (materials, submissions) AND upload.array() routes
    // (student documents: up to 10, album photos: up to 20) — a global
    // files:1 cap here would reject every multi-file request regardless of
    // the per-route .array(field, maxCount) limit. Per-route counts are
    // enforced where .array()/.single() is called (see routes/*.js).
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB per file
      fields: 20, // multipart has no body-size cap like express.json's; bound the field count
    },
  });
}

const anyUpload = buildMulter(ALLOWED_MIME_TYPES);
const imageUpload = buildMulter(IMAGE_MIME_TYPES);

// Runs after multer: rejects any stored file whose real content doesn't match
// its declared type. Rejection goes through the error handler (400), and the
// cleanup hook below then deletes what multer already wrote.
async function verifyFileContents(req, _res, next) {
  const files = [
    ...(req.file ? [req.file] : []),
    ...(Array.isArray(req.files) ? req.files : []),
  ];
  try {
    for (const file of files) {
      if (!(await fileMatchesDeclaredType(file.path, file.mimetype))) {
        throw new AppError("File content does not match its type", 400);
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

// multer writes to disk *before* any controller check runs (ownership,
// "student exists", validation...). Without this, every rejected request
// would leave its upload behind as an orphan. Any 4xx/5xx response deletes
// the files this request stored; successful requests keep them.
function discardUploadsOnFailure(req, res, next) {
  res.on("finish", () => {
    if (res.statusCode >= 400) void removeUploadedFiles(req);
  });
  next();
}

// Each returns a middleware *array* (Express flattens it), so the route files
// keep calling upload.single(...) / upload.array(...) exactly as before while
// picking up the limiter, cleanup, and content check automatically.
// Routes must mount requireAuth first — the limiter keys on the user.
// Pass { imagesOnly: true } for endpoints that only ever show pictures.
export const upload = {
  single: (field, { imagesOnly = false } = {}) => [
    uploadLimiter,
    discardUploadsOnFailure,
    (imagesOnly ? imageUpload : anyUpload).single(field),
    verifyFileContents,
  ],
  array: (field, maxCount, { imagesOnly = false } = {}) => [
    uploadLimiter,
    discardUploadsOnFailure,
    (imagesOnly ? imageUpload : anyUpload).array(field, maxCount),
    verifyFileContents,
  ],
};

// Builds the initial stored URL at upload time. What's actually served is
// re-signed fresh on every read (see src/lib/signedFileUrl.js) — this
// value only needs to carry the filename through to storage; the
// protocol/host portion is discarded and rebuilt at read time.
export function fileUrl(req, filename) {
  return `${req.protocol}://${req.get("host")}/api/files/${filename}`;
}
