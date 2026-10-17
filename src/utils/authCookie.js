import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

// The session token lives in an httpOnly cookie, so a script running in the
// page (an XSS bug, a compromised dependency) can neither read nor copy it —
// unlike a token kept in localStorage. The browser attaches it by itself.
export const AUTH_COOKIE = "eccd_session";

function options(token) {
  // The cookie lives exactly as long as the token inside it.
  const exp = jwt.decode(token)?.exp;
  const maxAge = exp ? Math.max(0, exp * 1000 - Date.now()) : undefined;
  return {
    httpOnly: true,
    secure: env.authCookie.secure,
    sameSite: env.authCookie.sameSite,
    path: "/",
    ...(maxAge !== undefined && { maxAge }),
  };
}

export function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE, token, options(token));
}

export function clearAuthCookie(res) {
  // Attributes must match the ones it was set with, or browsers keep the cookie.
  res.clearCookie(AUTH_COOKIE, {
    httpOnly: true,
    secure: env.authCookie.secure,
    sameSite: env.authCookie.sameSite,
    path: "/",
  });
}

// Reads our cookie from the raw header. Deliberately small instead of adding a
// cookie-parsing dependency: one name, no signed cookies, no JSON cookies.
export function readAuthCookie(req) {
  const header = req.headers?.cookie;
  if (typeof header !== "string" || !header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== AUTH_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value) || null;
    } catch {
      return null;
    }
  }
  return null;
}
