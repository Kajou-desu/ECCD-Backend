import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger.js";

// Same directory middleware/upload.js writes to and controllers/files.controller.js
// reads from (all resolve relative to the process working directory).
export const UPLOAD_DIR = path.resolve("uploads");

// Maps a stored value — a bare filename, or the full URL older rows hold,
// optionally with a ?exp=&sig= query — to an absolute path *inside*
// UPLOAD_DIR, or null if it can't be mapped safely. Only the basename is ever
// used, so a stored value can never point outside the uploads directory.
export function resolveStoredPath(storedValue) {
  if (typeof storedValue !== "string" || !storedValue) return null;

  const name = path.basename(storedValue.split("?")[0]);
  if (!name || name === "." || name === "..") return null;

  const fullPath = path.join(UPLOAD_DIR, name);
  return fullPath.startsWith(UPLOAD_DIR + path.sep) ? fullPath : null;
}

// Best-effort delete of files that were stored for rows that no longer exist
// (or are being replaced). Never throws: the database change has already
// succeeded by the time this runs, and a leftover file must not turn a
// successful request into an error. Failures other than "already gone" are
// logged so they're visible.
export async function removeStoredFiles(...storedValues) {
  await Promise.all(
    storedValues.flat().map(async (storedValue) => {
      const filePath = resolveStoredPath(storedValue);
      if (!filePath) return;
      try {
        await fs.unlink(filePath);
      } catch (err) {
        if (err.code !== "ENOENT") {
          logger.warn({ err, file: path.basename(filePath) }, "Failed to delete stored file");
        }
      }
    })
  );
}

// Deletes whatever multer wrote to disk for this request (req.file / req.files).
// Used when a request is rejected after multer has already stored its upload.
export async function removeUploadedFiles(req) {
  const files = [
    ...(req.file ? [req.file] : []),
    ...(Array.isArray(req.files) ? req.files : []),
  ];
  await removeStoredFiles(files.map((file) => file.path));
}
