import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { logger } from "./logger.js";
import { getStorage } from "../storage/index.js";
import { thumbnailKeyFor } from "./fileStorage.js";

// Gallery grids showed every photo at full size: a 10 MB phone photo to fill
// a 150 px tile. A thumbnail is the same picture, resized once and stored next
// to the original.
//
// It is created the first time it is asked for (GET /api/files/<name>?v=thumb)
// and kept, so photos uploaded before this existed need no migration and a
// photo nobody views never costs anything. It needs no signature of its own:
// the request is already authorised by the original file's signature, and a
// thumbnail shows strictly less than the original.
export const THUMBNAIL_WIDTH = 480;

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

export function canThumbnail(key) {
  return IMAGE_EXTENSIONS.has(path.extname(key).toLowerCase());
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Two requests for the same new thumbnail share one resize.
const inFlight = new Map();

async function createThumbnail(key, thumbKey) {
  const original = await getStorage().get(key);
  if (!original) return null;

  const input = await readAll(original.body);
  const output = await sharp(input)
    .rotate() // apply the camera's EXIF orientation, then drop the tag
    .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 72 })
    .toBuffer();

  // The storage contract takes a file path, so go through a temp file.
  const tmp = path.join(os.tmpdir(), `eccd-${process.pid}-${Date.now()}-${thumbKey}`);
  try {
    await fs.writeFile(tmp, output);
    await getStorage().put(thumbKey, tmp, "image/jpeg");
  } catch (err) {
    // Not being able to cache the thumbnail must not fail the request: this
    // one is still served, and the next request tries again.
    logger.warn({ err, key: thumbKey }, "Could not store thumbnail");
  } finally {
    await fs.rm(tmp, { force: true });
  }
  return { body: Readable.from(output), contentLength: output.length };
}

// Returns { key, object } for the thumbnail, or null when there is none to
// give (not an image, original missing, or the image can't be decoded) — the
// caller then serves the original.
export async function getThumbnail(key) {
  if (!canThumbnail(key)) return null;
  const thumbKey = thumbnailKeyFor(key);

  const existing = await getStorage().get(thumbKey);
  if (existing) return { key: thumbKey, object: existing };

  try {
    let pending = inFlight.get(thumbKey);
    if (!pending) {
      pending = createThumbnail(key, thumbKey).finally(() => inFlight.delete(thumbKey));
      inFlight.set(thumbKey, pending);
    }
    const created = await pending;
    return created ? { key: thumbKey, object: created } : null;
  } catch (err) {
    logger.warn({ err, key }, "Could not create thumbnail; serving the original");
    return null;
  }
}
