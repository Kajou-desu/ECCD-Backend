import { prisma } from "../lib/prisma.js";
import { fileUrl } from "../middleware/upload.js";
import { signFileUrl } from "../lib/signedFileUrl.js";
import { assertCanAccessStudent } from "../utils/ownership.js";
import { parseId } from "../utils/validate.js";
import { notifyTeacherOfSubmission } from "../services/submissionNotification.service.js";

function toSubmissionResponse(req, submission) {
  return { ...submission, fileUrl: signFileUrl(req, submission.fileUrl) };
}

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
    res.json(submissions.map((s) => toSubmissionResponse(req, s)));
  } catch (err) {
    next(err);
  }
}

// GET /api/materials/:id/submissions
// Everything the "student works" page needs in one round trip: the material
// (so an unknown id is a clean 404) and every student's uploaded work for it.
// Staff only — the route enforces Teacher/Admin, because this lists ALL
// students' work, which a Parent/Guardian must never see.
// `select` keeps the response to what the page renders; nothing else about
// the student leaves the server.
export async function getMaterialSubmissions(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");

    const material = await prisma.material.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        category: true,
        submissions: {
          orderBy: { submittedAt: "desc" },
          select: {
            id: true,
            studentId: true,
            fileName: true,
            fileUrl: true,
            submittedAt: true,
            student: { select: { name: true } },
          },
        },
      },
    });
    if (!material) return res.status(404).json({ message: "Material not found" });

    const { submissions, ...materialInfo } = material;
    res.json({
      material: materialInfo,
      submissions: submissions.map(({ student, ...submission }) => ({
        ...submission,
        studentName: student.name,
        fileUrl: signFileUrl(req, submission.fileUrl),
      })),
    });
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

    // Only when a parent/guardian submits: a teacher/admin uploading on a
    // child's behalf must not notify the teacher about their own action.
    // Fire-and-forget so the response never waits on it.
    if (req.user.role === "Parent" || req.user.role === "Guardian") {
      Promise.resolve()
        .then(() => notifyTeacherOfSubmission(studentId, material.title))
        .catch(() => {});
    }

    res.status(201).json(toSubmissionResponse(req, submission));
  } catch (err) {
    next(err);
  }
}
