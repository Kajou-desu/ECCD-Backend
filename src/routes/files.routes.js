import { Router } from "express";
import { getFile } from "../controllers/files.controller.js";

// Not behind requireAuth: the frontend renders every file URL (photos,
// student avatars, materials, submissions, documents) via plain
// <img src>, <a href>, and window.open — none of which can attach a Bearer
// token, so a session-auth-gated route would break every image/file link.
// Instead, every URL returned by the API is HMAC-signed with a short
// expiry (see src/lib/signedFileUrl.js) computed fresh on each response,
// verified here in files.controller.js — so a leaked/copied link stops
// working after it expires rather than granting permanent access.
const router = Router();

router.get("/:filename", getFile);

export default router;
