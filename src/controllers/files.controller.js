import { pipeline } from "node:stream/promises";
import { AppError } from "../middleware/errorHandler.js";
import { env } from "../config/env.js";
import { verifyFileSignature } from "../lib/signedFileUrl.js";
import { getThumbnail } from "../lib/thumbnails.js";
import { storageKeyFrom } from "../lib/fileStorage.js";
import { getStorage } from "../storage/index.js";
import { mimeFromKey } from "../storage/mimeTypes.js";

// Serves a previously uploaded file. Requires a valid ?exp=&sig= (see
// src/lib/signedFileUrl.js) generated fresh every time an entity is
// returned from the API — a copied/leaked link stops working once it
// expires, instead of granting permanent access.
//
// The bucket itself stays private: the object is fetched server-side and
// streamed through, so this signature check is the only way in, whichever
// storage provider is configured. The key is restricted to a plain filename
// (storageKeyFrom) so client input can never address another object or path.
// helmet() also sends X-Frame-Options: SAMEORIGIN and a CSP with
// frame-ancestors 'self' / object-src 'none' on every response. Both stop the
// frontend (a different origin) from showing a PDF in an <iframe> — the browser
// reports "refused to connect". For this route only, replace them with a CSP
// that lets exactly the configured frontend origins frame the file (never "*").
// Safe to drop the rest of helmet's CSP here: only images/PDF/Word files are
// ever stored (storage/mimeTypes.js), served with nosniff, never HTML/SVG.
function frameAncestorsPolicy() {
  const origins = env.clientOrigins.filter((origin) => /^https?:\/\/[^\s;,'"]+$/.test(origin));
  return `frame-ancestors ${origins.length ? origins.join(" ") : "'none'"}`;
}

export async function getFile(req, res, next) {
  try {
    const key = storageKeyFrom(req.params.filename);

    // Same generic "Not found" for a bad key, a bad/expired signature, or a
    // missing object — the response doesn't confirm to an attacker whether a
    // given filename ever existed.
    // s=1 marks a document link. It is covered by the signature, so it can
    // be neither added nor removed by whoever holds the link.
    const sensitive = req.query.s === "1";
    if (!key || !verifyFileSignature(key, req.query.exp, req.query.sig, sensitive)) {
      throw new AppError("Not found", 404);
    }

    // ?v=thumb asks for a small version of an image (gallery tiles). Never
    // for documents, which are always served whole. If no thumbnail can be
    // made the original is served, so the picture still shows.
    const thumbnail = !sensitive && req.query.v === "thumb" ? await getThumbnail(key) : null;
    const object = thumbnail?.object ?? (await getStorage().get(key));
    if (!object) throw new AppError("Not found", 404);
    const servedKey = thumbnail?.key ?? key;

    // Content-Type comes from the key's extension, which upload derived from
    // the verified file type — not from metadata stored with the object.
    //
    // Files hold children's records and are reachable by a URL that encodes
    // the credential (the signature). "private" keeps shared caches/CDNs
    // from storing the response and later serving it without the check.
    //
    // helmet() defaults every response to Cross-Origin-Resource-Policy:
    // same-origin, which makes browsers refuse to render these files in an
    // <img>/<iframe> on the frontend (a different origin than this API).
    // Relaxed for this route only: access is already gated by the signed,
    // expiring URL, and every other endpoint keeps helmet's stricter default.
    res.set({
      "Content-Type": mimeFromKey(servedKey),
      // Inline so a PDF previews the same way in every browser; the filename is
      // the validated storage key (a plain name), never client input.
      "Content-Disposition": `inline; filename="${servedKey.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      // The URL carries the signature; don't leak it to other sites via Referer.
      "Referrer-Policy": "no-referrer",
      // Documents are never kept by the browser: a link is for one viewing.
      "Cache-Control": sensitive ? "private, no-store" : "private, max-age=300",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Content-Security-Policy": frameAncestorsPolicy(),
    });
    res.removeHeader("X-Frame-Options");
    if (object.contentLength != null) res.set("Content-Length", String(object.contentLength));

    await pipeline(object.body, res);
  } catch (err) {
    // Once bytes are flowing a JSON error can't be sent; just drop the
    // connection (also what happens when the client goes away mid-download).
    if (res.headersSent) return void res.destroy();
    next(err);
  }
}
