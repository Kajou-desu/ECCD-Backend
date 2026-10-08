import { signFileUrl, DOCUMENT_URL_TTL_MS } from "../lib/signedFileUrl.js";

// FileUploadField.jsx reads file?.name / file?.filename / file?.originalName
// to display an existing document's label — never file?.fileName. Map the
// DB column to `name` at the API boundary, same pattern used for photo.url.
export function toDocumentResponse(req, doc) {
  return {
    id: doc.id,
    name: doc.fileName,
    // Short-lived and never cached: this link is for the moment of viewing.
    // The app gets a fresh one when someone opens the document.
    url: signFileUrl(req, doc.fileUrl, DOCUMENT_URL_TTL_MS, { sensitive: true }),
    uploadedAt: doc.uploadedAt,
  };
}
