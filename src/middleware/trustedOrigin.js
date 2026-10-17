import { env } from "../config/env.js";
import { readAuthCookie } from "../utils/authCookie.js";

// A browser attaches the session cookie to ANY request to this server, including
// one a malicious page makes (cross-site request forgery). So a state-changing
// request that is authenticated by that cookie must also come from one of our
// own frontends, which the browser states in the Origin header (Referer as a
// fallback) and a page can't forge. Requests that carry an Authorization
// header (API clients) are not affected: nothing is attached automatically.
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function requireTrustedOrigin(req, res, next) {
  if (!UNSAFE_METHODS.has(req.method)) return next();
  if (req.headers.authorization) return next();
  if (!readAuthCookie(req)) return next();

  const origin = req.get("origin") || originOf(req.get("referer"));
  if (origin && env.clientOrigins.includes(origin)) return next();

  return res.status(403).json({ message: "Forbidden" });
}
