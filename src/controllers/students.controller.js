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
  requireGender,
} from "../utils/validate.js";
import { toDocumentResponse } from "../utils/studentDocumentResponse.js";
import { signFileUrl } from "../lib/signedFileUrl.js";
import { AppError } from "../middleware/errorHandler.js";
import { logger } from "../lib/logger.js";
import { removeStoredFiles } from "../lib/fileStorage.js";
import { fileUrl } from "../middleware/upload.js";
import { isRecognitionConfigured, removeStudentEnrollment } from "../services/recognitionClient.js";
import { schoolDateString } from "../utils/schoolDate.js";

// Lean shape for roster/table/dashboard views (StudentTable, EventCard,
// UploadStudentWork picker, useStudents search).
const LIST_SELECT = {
  id: true,
  studentCode: true,
  name: true,
  photo: true,
  birthday: true,
  gender: true,
  address: true,
  session: true,
  status: true,
  motherName: true,
  motherPhone: true,
  fatherName: true,
  fatherPhone: true,
  guardianName: true,
  guardianPhone: true,
};

// Full shape for the edit form (StudentForm.jsx prefill) — every flat field
// plus embedded documents and the connected teacher.
const DETAIL_INCLUDE = {
  documents: true,
  teacher: { select: { id: true, name: true, centerLocation: true } },
};

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
// `teacher` is flattened from the included relation object down to a plain
// display name string — StudentProfileHeader.jsx renders it directly as
// `student.teacher`; `teacherId` (already a scalar column on the row) is
// kept as-is for the admin edit form's teacher picker.
function toStudentDetailResponse(req, student) {
  const { teacher, ...rest } = student;
  return {
    ...rest,
    teacher: teacher?.name ?? null,
    teacherCenterLocation: teacher?.centerLocation ?? null,
    // StudentProfileHeader.jsx reads `student.school`. There is no school column;
    // the school/center is the assigned teacher's center, so derive it here.
    school: teacher?.centerLocation ?? null,
    photo: signFileUrl(req, student.photo),
    birthday: toDateOnly(student.birthday),
    documents: (student.documents || []).map((doc) => toDocumentResponse(req, doc)),
  };
}

// The year comes from the school-local date, not a literal: "2026" was
// hard-coded, so every student created in later years got a 2026 code.
function codeYear() {
  return schoolDateString().slice(0, 4);
}

function temporaryStudentCode() {
  return `ECCD-${codeYear()}-TEMP-${crypto.randomUUID()}`;
}

function finalStudentCode(studentId) {
  return `ECCD-${codeYear()}-${studentId}`;
}

const EMAIL_FIELDS = ["motherEmail", "fatherEmail", "guardianEmail"];
const PRIMARY_GUARDIAN_TYPES = new Set(["Mother", "Father", "Legal Guardian"]);

function parsePrimaryGuardianType(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !PRIMARY_GUARDIAN_TYPES.has(value)) {
    throw new AppError("primaryGuardianType must be Mother, Father, or Legal Guardian", 400);
  }
  return value;
}

// Links existing Parent/Guardian accounts whose email matches any of `emails`.
// Emails are lowercased on every write path (requireEmail/optionalEmail), so an
// exact match is correct. Never creates accounts, only adds links, and logs
// ids only, never emails.
async function linkAccountsByEmail(tx, studentId, emails, actorId) {
  const unique = [...new Set(emails.filter(Boolean))];
  if (!unique.length) return;

  const accounts = await tx.user.findMany({
    where: { role: { in: ["Parent", "Guardian"] }, email: { in: unique } },
    select: { id: true },
  });
  if (!accounts.length) return;

  const { count } = await tx.parentChild.createMany({
    data: accounts.map((account) => ({ parentId: account.id, studentId })),
    skipDuplicates: true,
  });
  if (count) logger.info({ actorId, studentId, count }, "Linked parent accounts to student");
}

function buildCreateData(body) {
  const firstName = requireNonEmptyString(body.firstName, "firstName", 100);
  const lastName = requireNonEmptyString(body.lastName, "lastName", 100);
  const middleName = optionalString(body.middleName, 100);
  const suffix = optionalString(body.suffix, 20);
  const birthday = requireBirthday(body.birthday);
  const gender = requireGender(body.gender);
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
    gender,
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
    primaryGuardianType: parsePrimaryGuardianType(body.primaryGuardianType),
    allergies: optionalString(body.allergies, 1000),
    dietary: optionalString(body.dietary, 1000),
    specialNotes: optionalString(body.specialNotes, 2000),
  };
}

// Teacher/admin only (enforced at route level).
// Admin sees the full roster; a Teacher sees only students connected to
// them (Student.teacherId), so a teacher's "Student Info" list matches who
// they actually manage.
// ?page & ?pageSize are optional; omitting both returns the full roster
// exactly as before (see parsePagination), so existing callers are
// unaffected. When paginated, total roster size is sent via X-Total-Count
// rather than changing the response body shape.
export async function getStudents(req, res, next) {
  try {
    const pagination = parsePagination(req.query);
    const where = req.user.role === "Teacher" ? { teacherId: req.user.id } : undefined;

    const [students, total] = await Promise.all([
      prisma.student.findMany({
        select: LIST_SELECT,
        where,
        orderBy: { name: "asc" },
        ...(pagination && { skip: pagination.skip, take: pagination.take }),
      }),
      pagination ? prisma.student.count({ where }) : Promise.resolve(null),
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

// Resolves who a new/updated student is connected to. A Teacher creating or
// already managing a student is always the assigned teacher — any
// client-supplied teacherId is ignored so a teacher can't hand a student off
// to (or claim one on behalf of) another teacher. An Admin must explicitly
// choose an existing Teacher account; `null` explicitly unassigns.
async function resolveTeacherId(actor, requestedTeacherId) {
  if (actor.role === "Teacher") return actor.id;

  if (requestedTeacherId === null) return null;
  const teacherId = parseId(requestedTeacherId, "teacherId");
  const teacher = await prisma.user.findUnique({ where: { id: teacherId }, select: { role: true } });
  if (!teacher || teacher.role !== "Teacher") {
    throw new AppError("Selected teacher account not found", 400);
  }
  return teacherId;
}

// Teacher/admin only (enforced at route level).
export async function createStudent(req, res, next) {
  try {
    const data = buildCreateData(req.body);
    // Admin must pick a teacher to connect the student to; a Teacher always
    // self-assigns (resolveTeacherId ignores req.body.teacherId for them).
    data.teacherId = await resolveTeacherId(req.user, req.body.teacherId);

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

      await linkAccountsByEmail(
        tx,
        created.id,
        EMAIL_FIELDS.map((f) => data[f]),
        req.user?.id
      );
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
    await assertCanAccessStudent(req.user, id);
    const body = req.body;
    const data = {};

    // Only an Admin may reassign a student's teacher; a Teacher is already
    // restricted (via assertCanAccessStudent above) to editing their own
    // assigned students, so they have no reason to change this field.
    if (body.teacherId !== undefined) {
      if (req.user.role !== "Admin") {
        throw new AppError("Only an Admin can change a student's assigned teacher", 403);
      }
      data.teacherId = await resolveTeacherId(req.user, body.teacherId);
    }

    if (body.firstName !== undefined) data.firstName = requireNonEmptyString(body.firstName, "firstName", 100);
    if (body.lastName !== undefined) data.lastName = requireNonEmptyString(body.lastName, "lastName", 100);
    if (body.middleName !== undefined) data.middleName = optionalString(body.middleName, 100);
    if (body.suffix !== undefined) data.suffix = optionalString(body.suffix, 20);
    if (body.birthday !== undefined) data.birthday = requireBirthday(body.birthday);
    if (body.gender !== undefined) data.gender = requireGender(body.gender);
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
    if (body.primaryGuardianType !== undefined) {
      data.primaryGuardianType = parsePrimaryGuardianType(body.primaryGuardianType);
    }
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

    // The edit form resends every field, so link only emails that actually
    // changed; otherwise any unrelated edit would restore links an admin
    // removed on purpose in Account Management.
    const student = await prisma.$transaction(async (tx) => {
      const before = await tx.student.findUnique({
        where: { id },
        select: { motherEmail: true, fatherEmail: true, guardianEmail: true },
      });
      const updated = await tx.student.update({ where: { id }, data, include: DETAIL_INCLUDE });
      const changed = EMAIL_FIELDS.filter((f) => data[f] !== undefined && data[f] !== before?.[f]);
      await linkAccountsByEmail(tx, id, changed.map((f) => data[f]), req.user?.id);
      return updated;
    });
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
    await assertCanAccessStudent(req.user, id);
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
    await assertCanAccessStudent(req.user, id);

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

    // The child's face photos/encoding live in the recognition service, outside
    // the database cascade: erase them too. The student is already gone, so a
    // failure here is logged (id only, never the photos) rather than failing the
    // request — an orphaned enrollment needs following up, not a retry loop.
    if (isRecognitionConfigured()) {
      try {
        await removeStudentEnrollment(id);
      } catch (err) {
        logger.error({ err, studentId: id }, "Could not erase face enrollment for a deleted student");
      }
    }
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
          // Bulk import has no per-row teacher picker: a Teacher importing
          // self-assigns every row; an Admin's rows are left unassigned for
          // a teacher to be connected later via edit.
          data.teacherId = req.user.role === "Teacher" ? req.user.id : null;

          // Re-uploading the same file (a double click, or a retry after a
          // timeout) must not create every child twice. A row is a duplicate
          // when the same teacher already has a student with this name and
          // birthday; rows committed earlier in this same file count too.
          const duplicate = await tx.student.findFirst({
            where: {
              firstName: { equals: data.firstName, mode: "insensitive" },
              lastName: { equals: data.lastName, mode: "insensitive" },
              birthday: data.birthday,
              teacherId: data.teacherId,
            },
            select: { id: true },
          });
          if (duplicate) {
            throw new AppError("Already exists (same name and birthday), skipped", 409);
          }

          const created = await tx.student.create({
            data: { ...data, studentCode: temporaryStudentCode() },
            include: DETAIL_INCLUDE,
          });
          const finalized = await tx.student.update({
            where: { id: created.id },
            data: { studentCode: finalStudentCode(created.id) },
            include: DETAIL_INCLUDE,
          });
          await linkAccountsByEmail(tx, created.id, EMAIL_FIELDS.map((f) => data[f]), req.user?.id);
          return finalized;
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
