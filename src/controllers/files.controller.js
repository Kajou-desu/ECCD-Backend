import { pipeline } from "node:stream/promises";
import { AppError } from "../middleware/errorHandler.js";
import { verifyFileSignature } from "../lib/signedFileUrl.js";
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
export async function getFile(req, res, next) {
  try {
    const key = storageKeyFrom(req.params.filename);

    // Same generic "Not found" for a bad key, a bad/expired signature, or a
    // missing object — the response doesn't confirm to an attacker whether a
    // given filename ever existed.
    if (!key || !verifyFileSignature(key, req.query.exp, req.query.sig)) {
      throw new AppError("Not found", 404);
    }

    const object = await getStorage().get(key);
    if (!object) throw new AppError("Not found", 404);

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
      "Content-Type": mimeFromKey(key),
      "Cache-Control": "private, max-age=300",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    if (object.contentLength != null) res.set("Content-Length", String(object.contentLength));

    await pipeline(object.body, res);
  } catch (err) {
    // Once bytes are flowing a JSON error can't be sent; just drop the
    // connection (also what happens when the client goes away mid-download).
    if (res.headersSent) return void res.destroy();
    next(err);
  }
}
