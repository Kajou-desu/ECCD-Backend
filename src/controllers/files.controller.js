import path from "node:path";
import fs from "node:fs";
import { AppError } from "../middleware/errorHandler.js";
import { verifyFileSignature } from "../lib/signedFileUrl.js";

const UPLOAD_DIR = path.resolve("uploads");

// Serves a previously uploaded file. Requires a valid ?exp=&sig= (see
// src/lib/signedFileUrl.js) generated fresh every time an entity is
// returned from the API — a copied/leaked link stops working once it
// expires, instead of granting permanent access. Filename is restricted to
// the basename to prevent path traversal (e.g. "../../etc/passwd"); we
// never join raw, unvalidated client input into a filesystem path.
export function getFile(req, res, next) {
  try {
    const requested = path.basename(req.params.filename);

    if (!verifyFileSignature(requested, req.query.exp, req.query.sig)) {
      // Same generic "Not found" as a missing file — an invalid vs.
      // expired vs. missing signature isn't distinguished, so this
      // response doesn't confirm to an attacker whether a given filename
      // ever existed.
      throw new AppError("Not found", 404);
    }

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
