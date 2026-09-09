import { prisma } from "../lib/prisma.js";
import { assertCanAccessStudent } from "../utils/ownership.js";
import { composeStudentName } from "../utils/studentName.js";
import {
  parseId,
  requireNonEmptyString,
  optionalString,
  optionalEmail,
  requirePhone,
  optionalPhone,
  requireSession,
  requireStudentStatus,
  requireBirthday,
} from "../utils/validate.js";
import { toDocumentResponse } from "../utils/studentDocumentResponse.js";
import { signFileUrl } from "../lib/signedFileUrl.js";

// Lean shape for roster/table/dashboard views (StudentTable, EventCard,
// UploadStudentWork picker, useStudents search).
const LIST_SELECT = {
  id: true,
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

function buildCreateData(body) {
  const firstName = requireNonEmptyString(body.firstName, "firstName", 100);
  const lastName = requireNonEmptyString(body.lastName, "lastName", 100);
  const middleName = optionalString(body.middleName, 100);
  const suffix = optionalString(body.suffix, 20);
  const birthday = requireBirthday(body.birthday);
  const address = requireNonEmptyString(body.address, "address", 500);
  const session = requireSession(body.session);
  const status = requireStudentStatus(body.status);

  const guardianName = requireNonEmptyString(body.guardianName, "guardianName", 200);
  const guardianPhone = requirePhone(body.guardianPhone, "guardianPhone");

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
    motherName: optionalString(body.motherName, 200),
    motherAddress: optionalString(body.motherAddress, 500),
    motherPhone: optionalPhone(body.motherPhone, "motherPhone"),
    motherEmail: optionalEmail(body.motherEmail),
    fatherName: optionalString(body.fatherName, 200),
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
export async function getStudents(req, res, next) {
  try {
    const students = await prisma.student.findMany({
      select: LIST_SELECT,
      orderBy: { name: "asc" },
    });
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
    const student = await prisma.student.create({ data, include: DETAIL_INCLUDE });
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
    if (body.guardianName !== undefined) data.guardianName = requireNonEmptyString(body.guardianName, "guardianName", 200);
    if (body.guardianAddress !== undefined) data.guardianAddress = optionalString(body.guardianAddress, 500);
    if (body.guardianPhone !== undefined) data.guardianPhone = requirePhone(body.guardianPhone, "guardianPhone");
    if (body.guardianEmail !== undefined) data.guardianEmail = optionalEmail(body.guardianEmail);
    if (body.allergies !== undefined) data.allergies = optionalString(body.allergies, 1000);
    if (body.dietary !== undefined) data.dietary = optionalString(body.dietary, 1000);
    if (body.specialNotes !== undefined) data.specialNotes = optionalString(body.specialNotes, 2000);

    // Keep the denormalized `name` field in sync whenever any name part changes.
    if (
      data.firstName !== undefined ||
      data.middleName !== undefined ||
      data.lastName !== undefined ||
      data.suffix !== undefined
    ) {
      const existing = await prisma.student.findUnique({ where: { id } });
      if (!existing) return res.status(404).json({ message: "Student not found" });

      data.name = composeStudentName({
        firstName: data.firstName ?? existing.firstName,
        middleName: data.middleName !== undefined ? data.middleName : existing.middleName,
        lastName: data.lastName ?? existing.lastName,
        suffix: data.suffix !== undefined ? data.suffix : existing.suffix,
      });
    }

    const student = await prisma.student.update({ where: { id }, data, include: DETAIL_INCLUDE });
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
    await prisma.student.delete({ where: { id } }); // cascades to documents/attendance/submissions
    res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Student not found" });
    next(err);
  }
}
