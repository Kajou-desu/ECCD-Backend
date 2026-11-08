import { prisma } from "../lib/prisma.js";
import { fileUrl } from "../middleware/upload.js";
import { removeStoredFiles, removeUploadedFiles } from "../lib/fileStorage.js";
import { signFileUrl } from "../lib/signedFileUrl.js";
import { assertCanAccessStudent, studentScopeFor } from "../utils/ownership.js";
import { staffContentScopeFor } from "../utils/contentScope.js";
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
// students' work, which a Parent/Guardian must never see. A Teacher only gets
// materials of their own center, and only the work of students they may see
// (their center's): work handed in before materials had centers can't expose
// another center's children.
// `select` keeps the response to what the page renders; nothing else about
// the student leaves the server.
export async function getMaterialSubmissions(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");
    const scope = staffContentScopeFor(req.user);
    const studentScope = studentScopeFor(req.user);

    const material = await prisma.material.findUnique({
      where: { id, ...scope },
      select: {
        id: true,
        title: true,
        category: true,
        submissions: {
          where: { student: studentScope },
          orderBy: { submittedAt: "desc" },
          select: {
            id: true,
            studentId: true,
            fileName: true,
            fileUrl: true,
            submittedAt: true,
            student: { select: { name: true, session: true } },
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
        studentSession: student.session,
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

    // Work is only handed in for a material of the student's own center, so a
    // guessed materialId can't reach another center's material. A student with
    // no Teacher (so no center) has none, the same as a Parent's materials list.
    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: { teacher: { select: { centerId: true } } },
    });
    const studentCenterId = student?.teacher?.centerId ?? null;
    const material =
      studentCenterId == null
        ? null
        : await prisma.material.findUnique({ where: { id: materialId, centerId: studentCenterId } });
    if (!material) return res.status(404).json({ message: "Material not found" });

    // A student has one piece of work per material. If there is already one,
    // the caller must say so explicitly (replace=true) before it is swapped;
    // otherwise nothing is changed and the new upload is discarded.
    const existing = await prisma.submission.findMany({
      where: { materialId, studentId },
      select: { id: true, fileUrl: true },
    });
    const replace = req.body.replace === "true";
    if (existing.length > 0 && !replace) {
      await removeUploadedFiles(req);
      return res.status(409).json({
        message: "This student has already uploaded work for this material.",
        code: "SUBMISSION_EXISTS",
      });
    }

    const newData = {
      materialId,
      studentId,
      fileUrl: fileUrl(req, req.file.filename),
      fileName: req.file.originalname,
    };
    // Swap in one transaction so a failure can't leave the student with no work.
    const submission =
      existing.length > 0
        ? (
            await prisma.$transaction([
              prisma.submission.deleteMany({ where: { id: { in: existing.map((s) => s.id) } } }),
              prisma.submission.create({ data: newData }),
            ])
          )[1]
        : await prisma.submission.create({ data: newData });

    // The replaced files are unreachable now; best-effort cleanup (never throws).
    if (existing.length > 0) await removeStoredFiles(existing.map((s) => s.fileUrl));

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
