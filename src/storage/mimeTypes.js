// Single source of truth for which file types the app accepts and the
// extension each is stored under. The extension of a stored object's key is
// derived from the *verified* MIME type at upload time, so it can also be
// trusted to derive the Content-Type when the object is served back.
export const EXT_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
};

export const ALLOWED_MIME_TYPES = new Set(Object.keys(EXT_BY_MIME));

export const MIME_BY_EXT = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime])
);

export function mimeFromKey(key) {
  const dot = key.lastIndexOf(".");
  const ext = dot >= 0 ? key.slice(dot).toLowerCase() : "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}
