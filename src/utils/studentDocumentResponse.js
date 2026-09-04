// FileUploadField.jsx reads file?.name / file?.filename / file?.originalName
// to display an existing document's label — never file?.fileName. Map the
// DB column to `name` at the API boundary, same pattern used for photo.url.
export function toDocumentResponse(doc) {
  return {
    id: doc.id,
    name: doc.fileName,
    url: doc.fileUrl,
    uploadedAt: doc.uploadedAt,
  };
}
