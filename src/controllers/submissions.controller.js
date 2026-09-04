import { prisma } from "../lib/prisma.js";
import { fileUrl } from "../middleware/upload.js";
import { assertCanAccessStudent } from "../utils/ownership.js";
import { parseId } from "../utils/validate.js";

// GET /api/students/:childId/submissions
// Parent/Guardian may only view their own child's submissions.
export async function getSubmissions(req, res, next) {
  try {
    const childId = parseId(req.params.childId, "childId");
    await assertCanAccessStudent(req.user, childId);

    const submissions = await prisma.submission.findMany({
      where: { studentId: childId },
      orderBy: { submittedAt: "desc" },
    });
    res.json(submissions);
  } catch (err) {
    next(err);
  }
}

// POST /api/submissions (multipart: materialId, studentId, file)
// studentId is client-supplied but must be verified against the caller's
// own children before we trust it (prevents submitting work as another child).
export async function submitStudentWork(req, res, next) {
  try {
    const materialId = parseId(req.body.materialId, "materialId");
    const studentId = parseId(req.body.studentId, "studentId");
    if (!req.file) {
      return res.status(400).json({ message: "file required" });
    }

    await assertCanAccessStudent(req.user, studentId);

    const material = await prisma.material.findUnique({ where: { id: materialId } });
    if (!material) return res.status(404).json({ message: "Material not found" });

    const submission = await prisma.submission.create({
      data: {
        materialId,
        studentId,
        fileUrl: fileUrl(req, req.file.filename),
        fileName: req.file.originalname,
      },
    });
    res.status(201).json(submission);
  } catch (err) {
    next(err);
  }
}
