import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logger } from "./logger.js";
import { getStorage } from "../storage/index.js";

// Where multer parks an upload while it is being validated. Deliberately not
// the storage location: nothing lands in real storage until it has passed
// the content check (see middleware/upload.js).
export const UPLOAD_TMP_DIR = path.join(os.tmpdir(), "eccd-uploads");

// Storage keys are the generated upload filenames. This accepts one only if
// it is a plain filename: no separators, no leading dot, no odd characters.
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

// Maps a stored value — a bare filename, or the full URL older rows hold,
// optionally with a ?exp=&sig= query — to a storage key, or null if it can't
// be one. Only the basename is used, so a stored value can never address
// anything but a top-level object.
export function storageKeyFrom(storedValue) {
  if (typeof storedValue !== "string" || !storedValue) return null;
  const name = path.basename(storedValue.split("?")[0]);
  return KEY_PATTERN.test(name) ? name : null;
}

// Best-effort delete of stored objects whose rows no longer exist (or are
// being replaced). Never throws: the database change has already succeeded by
// the time this runs, and a leftover object must not turn a successful
// request into an error. Failures other than "already gone" are logged.
export async function removeStoredFiles(...storedValues) {
  const storage = getStorage();
  await Promise.all(
    storedValues.flat().map(async (storedValue) => {
      const key = storageKeyFrom(storedValue);
      if (!key) return;
      try {
        await storage.remove(key);
      } catch (err) {
        logger.warn({ err, key }, "Failed to delete stored object");
      }
    })
  );
}

async function removeTempFile(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") logger.warn({ err }, "Failed to delete temporary upload");
  }
}

// Cleans up everything multer/our pipeline produced for this request
// (req.file / req.files): the temporary file, and — if it had already been
// moved into storage — the stored object. Used when a request is rejected
// after its upload was accepted. Never throws.
export async function removeUploadedFiles(req) {
  const files = [
    ...(req.file ? [req.file] : []),
    ...(Array.isArray(req.files) ? req.files : []),
  ];
  await Promise.all(
    files.map(async (file) => {
      await removeTempFile(file.path);
      if (file.stored) await removeStoredFiles(file.filename);
    })
  );
}
