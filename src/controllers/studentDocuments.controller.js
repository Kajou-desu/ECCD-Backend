import { prisma } from "../lib/prisma.js";
import { fileUrl } from "../middleware/upload.js";
import { parseId } from "../utils/validate.js";
import { toDocumentResponse } from "../utils/studentDocumentResponse.js";
import { removeStoredFiles } from "../lib/fileStorage.js";
import { assertCanAccessStudent } from "../utils/ownership.js";
import { signFileUrl, DOCUMENT_URL_TTL_MS } from "../lib/signedFileUrl.js";

// POST /api/students/:id/documents (multipart, field "documents", up to 10 files)
// Teacher/admin only (enforced at route level); a Teacher is further
// restricted to their own connected students.
export async function uploadStudentDocuments(req, res, next) {
  try {
    const studentId = parseId(req.params.id, "id");
    await assertCanAccessStudent(req.user, studentId);

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ message: "At least one file required" });
    }

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) return res.status(404).json({ message: "Student not found" });

    const created = await prisma.$transaction(
      files.map((file) =>
        prisma.studentDocument.create({
          data: {
            studentId,
            fileName: file.originalname,
            fileUrl: fileUrl(req, file.filename),
          },
        })
      )
    );

    res.status(201).json(created.map((doc) => toDocumentResponse(req, doc)));
  } catch (err) {
    next(err);
  }
}

// DELETE /api/students/:id/documents/:documentId
// Teacher/admin only (enforced at route level). Scoped to studentId as
// well as documentId so a document can't be deleted via a mismatched
// student id in the URL.
export async function deleteStudentDocument(req, res, next) {
  try {
    const studentId = parseId(req.params.id, "id");
    const documentId = parseId(req.params.documentId, "documentId");
    await assertCanAccessStudent(req.user, studentId);

    // Student documents hold personal records (IDs, certificates), so the
    // stored file must go with the row — not linger on disk after a "delete".
    const document = await prisma.studentDocument.findFirst({
      where: { id: documentId, studentId },
      select: { fileUrl: true },
    });
    if (!document) return res.status(404).json({ message: "Document not found" });

    await prisma.studentDocument.deleteMany({ where: { id: documentId, studentId } });
    await removeStoredFiles(document.fileUrl);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// GET /api/students/:id/documents/:documentId/link
// Hands out a fresh, short-lived link to ONE document, at the moment someone
// opens it. Same access rule as viewing the student (Admin, the assigned
// Teacher, or a linked Parent/Guardian). Scoped to studentId as well as
// documentId so a document can't be reached through another student's id.
export async function getStudentDocumentLink(req, res, next) {
  try {
    const studentId = parseId(req.params.id, "id");
    const documentId = parseId(req.params.documentId, "documentId");
    await assertCanAccessStudent(req.user, studentId);

    const document = await prisma.studentDocument.findFirst({
      where: { id: documentId, studentId },
      select: { fileUrl: true },
    });
    if (!document) return res.status(404).json({ message: "Document not found" });

    res.set("Cache-Control", "no-store");
    res.json({ url: signFileUrl(req, document.fileUrl, DOCUMENT_URL_TTL_MS, { sensitive: true }) });
  } catch (err) {
    next(err);
  }
}
