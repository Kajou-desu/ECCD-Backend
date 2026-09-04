import path from "node:path";
import fs from "node:fs";
import { AppError } from "../middleware/errorHandler.js";

const UPLOAD_DIR = path.resolve("uploads");

// Serves a previously uploaded file. Public by design (see files.routes.js
// for why) — filename is restricted to the basename to prevent path
// traversal (e.g. "../../etc/passwd"); we never join raw, unvalidated
// client input into a filesystem path.
export function getFile(req, res, next) {
  try {
    const requested = path.basename(req.params.filename);
    const filePath = path.join(UPLOAD_DIR, requested);

    // Defense in depth: confirm the resolved path is still inside UPLOAD_DIR.
    if (!filePath.startsWith(UPLOAD_DIR + path.sep)) {
      throw new AppError("Not found", 404);
    }

    if (!fs.existsSync(filePath)) {
      throw new AppError("Not found", 404);
    }

    res.sendFile(filePath);
  } catch (err) {
    next(err);
  }
}
