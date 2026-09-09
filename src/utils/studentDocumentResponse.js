import { signFileUrl } from "../lib/signedFileUrl.js";

// FileUploadField.jsx reads file?.name / file?.filename / file?.originalName
// to display an existing document's label — never file?.fileName. Map the
// DB column to `name` at the API boundary, same pattern used for photo.url.
export function toDocumentResponse(req, doc) {
  return {
    id: doc.id,
    name: doc.fileName,
    url: signFileUrl(req, doc.fileUrl),
    uploadedAt: doc.uploadedAt,
  };
}
