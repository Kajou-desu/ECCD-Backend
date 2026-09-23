import fs from "node:fs/promises";
import path from "node:path";
import { storageKeyFrom } from "../lib/fileStorage.js";
import { mimeFromKey } from "./mimeTypes.js";

// Copies every file in `dir` (the old ./uploads folder) into `destination`
// storage under the same key. Because the database already stores each file's
// URL with that filename as its last segment, no database change is needed:
// once the copy is done, switching STORAGE_DRIVER makes existing rows resolve
// to the copied objects.
//
// Safe to run repeatedly (already-copied files are skipped, so an interrupted
// run just resumes) and read-only with respect to `dir` — it never deletes the
// originals. Each upload is verified by size before it counts as done.
export async function migrateDirectoryToStorage({ dir, destination, dryRun = false }) {
  const summary = { transferred: 0, skipped: 0, bytes: 0, failed: [], ignored: [] };
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue; // .gitkeep etc.

    const key = storageKeyFrom(entry.name);
    if (key !== entry.name) {
      summary.ignored.push(entry.name); // not a name this app would ever have generated
      continue;
    }

    try {
      const filePath = path.join(dir, key);
      const { size } = await fs.stat(filePath);

      const existing = await destination.head(key);
      if (existing && existing.size === size) {
        summary.skipped += 1;
        continue;
      }

      if (!dryRun) {
        await destination.put(key, filePath, mimeFromKey(key));
        const stored = await destination.head(key);
        if (!stored || stored.size !== size) {
          throw new Error(`size mismatch after upload (expected ${size}, found ${stored?.size ?? "nothing"})`);
        }
      }
      summary.transferred += 1;
      summary.bytes += size;
    } catch (err) {
      summary.failed.push({ key, error: err.message });
    }
  }

  return summary;
}
