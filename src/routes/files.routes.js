import { Router } from "express";
import { getFile } from "../controllers/files.controller.js";

// Deliberately NOT behind requireAuth: the frontend renders every file URL
// (photos, student avatars, materials, submissions, documents) via plain
// <img src>, <a href>, and window.open — none of which can attach a Bearer
// token, so an auth-gated route would silently break every image and file
// link in the app. Compensating controls instead of session auth:
//   - filenames are crypto.randomBytes-derived (effectively unguessable)
//   - upload MIME whitelist (see middleware/upload.js)
//   - path-traversal protection (see files.controller.js)
// If stricter access control is needed later, the real fix is on the
// frontend: switch these to authenticated fetch() + blob object URLs.
const router = Router();

router.get("/:filename", getFile);

export default router;
