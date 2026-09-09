import { prisma } from "../lib/prisma.js";
import { fileUrl } from "../middleware/upload.js";
import { parseId } from "../utils/validate.js";
import { toDocumentResponse } from "../utils/studentDocumentResponse.js";

// POST /api/students/:id/documents (multipart, field "documents", up to 10 files)
// Teacher/admin only (enforced at route level).
export async function uploadStudentDocuments(req, res, next) {
  try {
    const studentId = parseId(req.params.id, "id");

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
