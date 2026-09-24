import { prisma } from "../lib/prisma.js";
import crypto from "node:crypto";
import { assertCanAccessStudent } from "../utils/ownership.js";
import { composeStudentName } from "../utils/studentName.js";
import {
  parseId,
  parsePagination,
  requireNonEmptyString,
  optionalString,
  optionalEmail,
  optionalPhone,
  requireSession,
  requireStudentStatus,
  requireBirthday,
} from "../utils/validate.js";
import { toDocumentResponse } from "../utils/studentDocumentResponse.js";
import { signFileUrl } from "../lib/signedFileUrl.js";
import { AppError } from "../middleware/errorHandler.js";
import { logger } from "../lib/logger.js";
import { removeStoredFiles } from "../lib/fileStorage.js";
import { fileUrl } from "../middleware/upload.js";

// Lean shape for roster/table/dashboard views (StudentTable, EventCard,
// UploadStudentWork picker, useStudents search).
const LIST_SELECT = {
  id: true,
  studentCode: true,
  name: true,
  photo: true,
  birthday: true,
  address: true,
  session: true,
  status: true,
  guardianName: true,
  guardianPhone: true,
};

// Full shape for the edit form (StudentForm.jsx prefill) — every flat field
// plus embedded documents.
const DETAIL_INCLUDE = { documents: true };

// Prisma DateTime -> plain YYYY-MM-DD. Needed because StudentForm.jsx feeds
// student.birthday straight into <input type="date" value={...}>, which
// silently renders blank if given a full ISO datetime string (the default
// JSON.stringify output for a JS Date) instead of exactly "YYYY-MM-DD".
function toDateOnly(date) {
  if (!date) return null;
  return date.toISOString().slice(0, 10);
}

// FileUploadField.jsx reads file.name for existing documents, not fileName —
// same aliasing pattern used for photo.url in albums.controller.js.
function toStudentDetailResponse(req, student) {
  return {
    ...student,
    photo: signFileUrl(req, student.photo),
    birthday: toDateOnly(student.birthday),
    documents: (student.documents || []).map((doc) => toDocumentResponse(req, doc)),
  };
}

function temporaryStudentCode() {
  return `ECCD-2026-TEMP-${crypto.randomUUID()}`;
}

function finalStudentCode(studentId) {
  return `ECCD-2026-${studentId}`;
}

// Takes the already-validated/normalized `data` object from
// buildCreateData (not the raw request body) so the email lookup below
// matches the same lowercased/trimmed form every account's email is
// stored in — the raw body's email may differ only in case, which would
// silently fail to find an existing account.
function getPrimaryParent(data) {
  if (data.motherName && data.motherEmail) {
    return { name: data.motherName, email: data.motherEmail, phone: data.motherPhone, address: data.motherAddress, role: "Parent" };
  }
  if (data.fatherName && data.fatherEmail) {
    return { name: data.fatherName, email: data.fatherEmail, phone: data.fatherPhone, address: data.fatherAddress, role: "Parent" };
  }
  if (data.guardianName && data.guardianEmail) {
    return { name: data.guardianName, email: data.guardianEmail, phone: data.guardianPhone, address: data.guardianAddress, role: "Guardian" };
  }
  return null;
}

function buildCreateData(body) {
  const firstName = requireNonEmptyString(body.firstName, "firstName", 100);
  const lastName = requireNonEmptyString(body.lastName, "lastName", 100);
  const middleName = optionalString(body.middleName, 100);
  const suffix = optionalString(body.suffix, 20);
  const birthday = requireBirthday(body.birthday);
  const address = requireNonEmptyString(body.address, "address", 500);
  const session = requireSession(body.session);
  const status = requireStudentStatus(body.status);

  const motherName = optionalString(body.motherName, 200);
  const fatherName = optionalString(body.fatherName, 200);
  const guardianName = optionalString(body.guardianName, 200);
  // A guardian isn't required on its own, but the record needs at least one
  // contact — mirrors the frontend's studentSchema.superRefine.
  if (!motherName && !fatherName && !guardianName) {
    throw new AppError("At least one parent or guardian name is required", 400);
  }
  const guardianPhone = optionalPhone(body.guardianPhone, "guardianPhone");

  return {
    firstName,
    middleName,
    lastName,
    suffix,
    name: composeStudentName({ firstName, middleName, lastName, suffix }),
    birthday,
    address,
    session,
    status,
    motherName,
    motherAddress: optionalString(body.motherAddress, 500),
    motherPhone: optionalPhone(body.motherPhone, "motherPhone"),
    motherEmail: optionalEmail(body.motherEmail),
    fatherName,
    fatherAddress: optionalString(body.fatherAddress, 500),
    fatherPhone: optionalPhone(body.fatherPhone, "fatherPhone"),
    fatherEmail: optionalEmail(body.fatherEmail),
    guardianName,
    guardianAddress: optionalString(body.guardianAddress, 500),
    guardianPhone,
    guardianEmail: optionalEmail(body.guardianEmail),
    allergies: optionalString(body.allergies, 1000),
    dietary: optionalString(body.dietary, 1000),
    specialNotes: optionalString(body.specialNotes, 2000),
  };
}

// Teacher/admin only (enforced at route level) — full roster.
// ?page & ?pageSize are optional; omitting both returns the full roster
// exactly as before (see parsePagination), so existing callers are
// unaffected. When paginated, total roster size is sent via X-Total-Count
// rather than changing the response body shape.
export async function getStudents(req, res, next) {
  try {
    const pagination = parsePagination(req.query);

    const [students, total] = await Promise.all([
      prisma.student.findMany({
        select: LIST_SELECT,
        orderBy: { name: "asc" },
        ...(pagination && { skip: pagination.skip, take: pagination.take }),
      }),
      pagination ? prisma.student.count() : Promise.resolve(null),
    ]);

    if (pagination) res.set("X-Total-Count", String(total));

    res.json(
      students.map((s) => ({
        ...s,
        photo: signFileUrl(req, s.photo),
        birthday: toDateOnly(s.birthday),
      }))
    );
  } catch (err) {
    next(err);
  }
}

// Any authenticated role; Parent/Guardian restricted to their own linked children.
// Returns the full detail shape (all flat fields + documents) so the
// edit form can be prefilled directly from this response.
export async function getStudent(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");
    await assertCanAccessStudent(req.user, id);

    const student = await prisma.student.findUnique({
      where: { id },
      include: DETAIL_INCLUDE,
    });
    if (!student) return res.status(404).json({ message: "Student not found" });
    res.json(toStudentDetailResponse(req, student));
  } catch (err) {
    next(err);
  }
}

// Teacher/admin only (enforced at route level).
export async function createStudent(req, res, next) {
  try {
    const data = buildCreateData(req.body);
    const student = await prisma.$transaction(async (tx) => {
      const created = await tx.student.create({
        data: { ...data, studentCode: temporaryStudentCode() },
        include: DETAIL_INCLUDE,
      });

      const finalized = await tx.student.update({
        where: { id: created.id },
        data: { studentCode: finalStudentCode(created.id) },
        include: DETAIL_INCLUDE,
      });

      const primary = getPrimaryParent(data);
      if (primary) {
        const account = await tx.user.findUnique({ where: { email: primary.email } });
        if (account && ["Parent", "Guardian"].includes(account.role)) {
          await tx.parentChild.upsert({
            where: { parentId_studentId: { parentId: account.id, studentId: created.id } },
            update: {},
            create: { parentId: account.id, studentId: created.id },
          });
        }
      }
      return finalized;
    });
    res.status(201).json(toStudentDetailResponse(req, student));
  } catch (err) {
    next(err);
  }
}

// Teacher/admin only (enforced at route level). Partial update: only
// fields present in the body are validated/changed.
export async function updateStudent(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");
    const body = req.body;
    const data = {};

    if (body.firstName !== undefined) data.firstName = requireNonEmptyString(body.firstName, "firstName", 100);
    if (body.lastName !== undefined) data.lastName = requireNonEmptyString(body.lastName, "lastName", 100);
    if (body.middleName !== undefined) data.middleName = optionalString(body.middleName, 100);
    if (body.suffix !== undefined) data.suffix = optionalString(body.suffix, 20);
    if (body.birthday !== undefined) data.birthday = requireBirthday(body.birthday);
    if (body.address !== undefined) data.address = requireNonEmptyString(body.address, "address", 500);
    if (body.session !== undefined) data.session = requireSession(body.session);
    if (body.status !== undefined) data.status = requireStudentStatus(body.status);
    if (body.motherName !== undefined) data.motherName = optionalString(body.motherName, 200);
    if (body.motherAddress !== undefined) data.motherAddress = optionalString(body.motherAddress, 500);
    if (body.motherPhone !== undefined) data.motherPhone = optionalPhone(body.motherPhone, "motherPhone");
    if (body.motherEmail !== undefined) data.motherEmail = optionalEmail(body.motherEmail);
    if (body.fatherName !== undefined) data.fatherName = optionalString(body.fatherName, 200);
    if (body.fatherAddress !== undefined) data.fatherAddress = optionalString(body.fatherAddress, 500);
    if (body.fatherPhone !== undefined) data.fatherPhone = optionalPhone(body.fatherPhone, "fatherPhone");
    if (body.fatherEmail !== undefined) data.fatherEmail = optionalEmail(body.fatherEmail);
    if (body.guardianName !== undefined) data.guardianName = optionalString(body.guardianName, 200);
    if (body.guardianAddress !== undefined) data.guardianAddress = optionalString(body.guardianAddress, 500);
    if (body.guardianPhone !== undefined) data.guardianPhone = optionalPhone(body.guardianPhone, "guardianPhone");
    if (body.guardianEmail !== undefined) data.guardianEmail = optionalEmail(body.guardianEmail);
    if (body.allergies !== undefined) data.allergies = optionalString(body.allergies, 1000);
    if (body.dietary !== undefined) data.dietary = optionalString(body.dietary, 1000);
    if (body.specialNotes !== undefined) data.specialNotes = optionalString(body.specialNotes, 2000);

    // Name parts changing needs the pre-update row to recompute the
    // denormalized `name`; motherName/fatherName/guardianName changing needs
    // it to check the "at least one parent/guardian name" invariant against
    // whichever of the three this request isn't touching.
    let existing = null;
    if (
      data.firstName !== undefined ||
      data.middleName !== undefined ||
      data.lastName !== undefined ||
      data.suffix !== undefined ||
      data.motherName !== undefined ||
      data.fatherName !== undefined ||
      data.guardianName !== undefined
    ) {
      existing = await prisma.student.findUnique({ where: { id } });
      if (!existing) return res.status(404).json({ message: "Student not found" });
    }

    // Keep the denormalized `name` field in sync whenever any name part changes.
    if (
      data.firstName !== undefined ||
      data.middleName !== undefined ||
      data.lastName !== undefined ||
      data.suffix !== undefined
    ) {
      data.name = composeStudentName({
        firstName: data.firstName ?? existing.firstName,
        middleName: data.middleName !== undefined ? data.middleName : existing.middleName,
        lastName: data.lastName ?? existing.lastName,
        suffix: data.suffix !== undefined ? data.suffix : existing.suffix,
      });
    }

    if (data.motherName !== undefined || data.fatherName !== undefined || data.guardianName !== undefined) {
      const motherName = data.motherName !== undefined ? data.motherName : existing.motherName;
      const fatherName = data.fatherName !== undefined ? data.fatherName : existing.fatherName;
      const guardianName = data.guardianName !== undefined ? data.guardianName : existing.guardianName;
      if (!motherName && !fatherName && !guardianName) {
        throw new AppError("At least one parent or guardian name is required", 400);
      }
    }

    const student = await prisma.student.update({ where: { id }, data, include: DETAIL_INCLUDE });
    res.json(toStudentDetailResponse(req, student));
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Student not found" });
    next(err);
  }
}

// Teacher/admin only (enforced at route level).
// POST /api/students/:id/photo — multipart, field "photo", single file.
// Mirrors uploadMyProfilePhoto in users.controller.js: store the storage
// key via fileUrl(), re-sign it at read time, and clean up the previous
// stored file once the new one is safely recorded.
export async function uploadStudentPhoto(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");
    if (!req.file) {
      return res.status(400).json({ message: "No photo file was provided" });
    }

    const previous = await prisma.student.findUnique({ where: { id }, select: { photo: true } });
    if (!previous) return res.status(404).json({ message: "Student not found" });

    const student = await prisma.student.update({
      where: { id },
      data: { photo: fileUrl(req, req.file.filename) },
      include: DETAIL_INCLUDE,
    });

    if (previous.photo) await removeStoredFiles(previous.photo);
    res.json(toStudentDetailResponse(req, student));
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Student not found" });
    next(err);
  }
}

// Teacher/admin only (enforced at route level).
export async function deleteStudent(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");

    // The delete cascades to documents and submissions in the database; gather
    // their files first so the student's records don't outlive the student.
    const [documents, submissions] = await Promise.all([
      prisma.studentDocument.findMany({ where: { studentId: id }, select: { fileUrl: true } }),
      prisma.submission.findMany({ where: { studentId: id }, select: { fileUrl: true } }),
    ]);

    const deleted = await prisma.student.delete({ where: { id } }); // cascades to documents/attendance/submissions
    await removeStoredFiles(
      deleted.photo,
      documents.map((d) => d.fileUrl),
      submissions.map((s) => s.fileUrl),
    );
    res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Student not found" });
    next(err);
  }
}


export async function importStudents(req, res, next) {
  try {
    const rows = Array.isArray(req.body?.students) ? req.body.students : [];
    if (!rows.length) return res.status(400).json({ message: "No student records supplied" });
    if (rows.length > 500) return res.status(400).json({ message: "A maximum of 500 students can be imported at once" });

    const created = [];
    const failed = [];
    for (let index = 0; index < rows.length; index += 1) {
      try {
        const student = await prisma.$transaction(async (tx) => {
          const data = buildCreateData(rows[index]);
          const created = await tx.student.create({
            data: { ...data, studentCode: temporaryStudentCode() },
            include: DETAIL_INCLUDE,
          });
          return tx.student.update({
            where: { id: created.id },
            data: { studentCode: finalStudentCode(created.id) },
            include: DETAIL_INCLUDE,
          });
        });
        created.push(toStudentDetailResponse(req, student));
      } catch (err) {
        if (err instanceof AppError) {
          failed.push({ row: index + 2, message: err.message });
        } else {
          logger.error({ err, row: index + 2 }, "Unexpected error importing student row");
          failed.push({ row: index + 2, message: "Invalid student record" });
        }
      }
    }

    res.status(201).json({ imported: created.length, failed, students: created });
  } catch (err) {
    next(err);
  }
}
