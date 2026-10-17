import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { composeUserName } from "../utils/userName.js";
import { signToken } from "../utils/jwt.js";
import { fileUrl } from "../middleware/upload.js";
import { signFileUrl } from "../lib/signedFileUrl.js";
import {
  parseId,
  requireEmail,
  requireNonEmptyString,
  optionalString,
  optionalPhone,
  optionalPhMobile,
  requirePassword,
} from "../utils/validate.js";
import { AppError } from "../middleware/errorHandler.js";
import { sendOtpEmail } from "../lib/mailer.js";
import { removeStoredFiles } from "../lib/fileStorage.js";
import { otpMatches, hashOtp, MAX_OTP_ATTEMPTS } from "../utils/otp.js";
import { assertCanAccessStudents, studentScopeFor, teacherAccountScope } from "../utils/ownership.js";

const ROLES = ["Teacher", "Parent", "Guardian", "Admin"];

// Parents/Guardians get arrival/departure SMS (Semaphore, PH mobiles only), so
// their phone must be one it can deliver to. Teachers/Admins never receive
// SMS and may legitimately list a landline, so they keep the general check.
const SMS_ROLES = ["Parent", "Guardian"];
function phoneForRole(role, value) {
  return SMS_ROLES.includes(role) ? optionalPhMobile(value, "phone") : optionalPhone(value, "phone");
}

const ACTIONS = {
  PASSWORD_CHANGE: "password_change",
  ACCOUNT_DELETE: "account_delete",
};

const MAX_STUDENT_IDS = 100;

// Strict: only real positive integers are accepted (no true/"2"/0/-1/1.5
// coercion), at most MAX_STUDENT_IDS entries; duplicates collapse.
function parseStudentIds(raw) {
  if (raw.length > MAX_STUDENT_IDS) {
    throw new AppError(`You can connect at most ${MAX_STUDENT_IDS} students to one account.`, 400);
  }
  if (!raw.every((id) => Number.isInteger(id) && id > 0)) {
    throw new AppError("One of the selected students is not valid. Reload the page and try again.", 400);
  }
  return [...new Set(raw)];
}

async function issueAccountOtp(userId, email, action) {
  await prisma.accountActionOtp.updateMany({
    where: { userId, action, isUsed: false },
    data: { isUsed: true },
  });
  const otpCode = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await prisma.accountActionOtp.create({ data: { userId, action, otpCode: hashOtp(otpCode), expiresAt } });
  await sendOtpEmail(
    email,
    otpCode,
    action === ACTIONS.PASSWORD_CHANGE ? "Password Change" : "Account Deletion",
  );
}

// Checks a code WITHOUT consuming it, and returns the matching record (or
// null). One guess is claimed with a single conditional UPDATE before the
// comparison, so parallel requests can't exceed MAX_OTP_ATTEMPTS (the old
// read-compare-increment sequence let them all read attempts=0).
async function checkAccountOtp(userId, action, otpCode) {
  const record = await prisma.accountActionOtp.findFirst({
    where: { userId, action, isUsed: false },
    orderBy: { createdAt: "desc" },
  });
  if (!record || record.expiresAt < new Date() || record.attempts >= MAX_OTP_ATTEMPTS) return null;

  const claimed = await prisma.accountActionOtp.updateMany({
    where: { id: record.id, isUsed: false, attempts: { lt: MAX_OTP_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (claimed.count === 0 || !otpMatches(otpCode, record.otpCode)) return null;
  return record;
}

// Single-use: only the request that flips isUsed false -> true wins.
async function consumeAccountOtp(record) {
  const { count } = await prisma.accountActionOtp.updateMany({
    where: { id: record.id, isUsed: false },
    data: { isUsed: true },
  });
  return count === 1;
}

async function verifyAccountOtp(userId, action, otpCode) {
  const record = await checkAccountOtp(userId, action, otpCode);
  return record ? consumeAccountOtp(record) : false;
}

// Excludes passwordHash/tokenVersion — never sent to the client.
const PUBLIC_SELECT = {
  id: true,
  firstName: true,
  middleName: true,
  lastName: true,
  name: true,
  email: true,
  phone: true,
  address: true,
  centerId: true,
  center: { select: { id: true, name: true } },
  role: true,
  isActive: true,
  createdAt: true,
  profilePicture: true,
  children: { select: { studentId: true } },
};

// profilePicture is stored as a plain (unsigned) URL — signed fresh on
// every read, same pattern as materials/documents, so the signature never
// goes stale sitting in the database.
function toUserResponse(req, user) {
  return {
    ...user,
    // The center's name under the old field name too, for clients that still read it.
    centerLocation: user.center?.name ?? null,
    profilePicture: user.profilePicture ? signFileUrl(req, user.profilePicture) : null,
    studentIds: user.children?.map((child) => child.studentId) ?? [],
  };
}

// toUserResponse for the account a Teacher just created or changed: its
// studentIds list only that Teacher's own students, like listUsers does. (An
// email match can connect a new account to other classes' students too.)
async function toScopedResponse(req, user) {
  if (req.user.role !== "Teacher" || !user.children?.length) return toUserResponse(req, user);
  const own = await prisma.student.findMany({
    where: { id: { in: user.children.map((c) => c.studentId) }, ...studentScopeFor(req.user) },
    select: { id: true },
  });
  const ownIds = new Set(own.map((s) => s.id));
  return toUserResponse(req, { ...user, children: user.children.filter((c) => ownIds.has(c.studentId)) });
}

function requireRoleValue(value) {
  if (!ROLES.includes(value)) {
    throw new AppError(`Choose a role: ${ROLES.join(", ")}.`, 400);
  }
  return value;
}

const LINKABLE_ROLES = ["Parent", "Guardian"];

// The raw validators say things like "Invalid firstName". These keep the same
// checks but give the person filling in the form a message they can act on.
function friendly(message, check) {
  try {
    return check();
  } catch (err) {
    if (err instanceof AppError && err.status === 400) throw new AppError(message, 400);
    throw err;
  }
}
const requireNamePart = (value, label) =>
  friendly(`${label} is required (up to 100 characters).`, () => requireNonEmptyString(value, label, 100));
const optionalNamePart = (value, label) =>
  friendly(`${label} must be 100 characters or fewer.`, () => optionalString(value, 100));
const accountEmail = (value) =>
  friendly("Enter a valid email address, for example name@example.com.", () => requireEmail(value));
const accountPhone = (role, value) =>
  friendly(
    SMS_ROLES.includes(role)
      ? "Enter a Philippine mobile number, for example 09171234567."
      : "Enter a valid phone number.",
    () => phoneForRole(role, value),
  );

const NO_STUDENT_MESSAGE =
  "A Parent or Guardian account must be connected to at least one student. Select a student for this account.";
const NO_CENTER_TEACHER_MESSAGE =
  "Your account is not assigned to a center yet. Ask an Admin to assign your center first.";
const NOT_IN_CENTER_MESSAGE = "This account could not be found in your center.";

// The Teacher's own center, or a clear refusal if an Admin has not set one:
// without it there is nothing to match accounts against.
function teacherCenterId(req) {
  if (req.user.centerId == null) throw new AppError(NO_CENTER_TEACHER_MESSAGE, 403);
  return req.user.centerId;
}

// An Admin picks the center of an account; it must exist.
async function requireExistingCenter(value) {
  const id = friendly("Choose the center for this account.", () => parseId(value, "centerId"));
  const center = await prisma.center.findUnique({ where: { id }, select: { id: true } });
  if (!center) throw new AppError("The selected center no longer exists. Reload the page and choose again.", 400);
  return id;
}

// Students being connected by an Admin must belong to the account's center
// (through their Teacher). A Teacher can only pick their own students, which
// are in their own center by definition (assertCanAccessStudents).
async function assertStudentsInCenter(studentIds, centerId) {
  const students = await prisma.student.findMany({
    where: { id: { in: studentIds } },
    select: { id: true, name: true, teacher: { select: { centerId: true } } },
  });
  if (students.length !== studentIds.length) {
    throw new AppError("One or more of the selected students no longer exist. Reload the page and try again.", 400);
  }
  const elsewhere = students.filter((student) => student.teacher?.centerId !== centerId);
  if (elsewhere.length) {
    throw new AppError(
      `These students are not at this account's center (or have no teacher yet): ${elsewhere
        .map((student) => student.name)
        .join(", ")}.`,
      400,
    );
  }
}

// Reverse of the student-side linking: connects a Parent/Guardian account to
// students whose registration lists its email AND whose Teacher is at the
// account's center (the same email at another center is not the same family
// record). Only called from the admin flows (register/update), never from
// self-service email changes, which are not verified. Adds links only;
// existing ones are kept.
async function linkStudentsByEmail(tx, userId, email, centerId) {
  if (centerId == null) return;
  const students = await tx.student.findMany({
    where: {
      OR: [{ motherEmail: email }, { fatherEmail: email }, { guardianEmail: email }],
      teacher: { centerId },
    },
    select: { id: true },
  });
  if (!students.length) return;
  await tx.parentChild.createMany({
    data: students.map((student) => ({ parentId: userId, studentId: student.id })),
    skipDuplicates: true,
  });
}

// A Parent/Guardian account is only useful (and only safe to leave around) if
// it reaches at least one student. Run inside the transaction so a failure
// rolls the whole save back.
async function requireStudentLink(tx, userId) {
  const link = await tx.parentChild.findFirst({ where: { parentId: userId }, select: { id: true } });
  if (!link) throw new AppError(NO_STUDENT_MESSAGE, 400);
}

// After an Admin moves an account to another center, every student it is
// connected to must be at that center.
async function requireLinksInCenter(tx, userId, centerId) {
  const links = await tx.parentChild.findMany({
    where: { parentId: userId },
    select: { student: { select: { name: true, teacher: { select: { centerId: true } } } } },
  });
  const elsewhere = links.filter((link) => link.student.teacher?.centerId !== centerId);
  if (elsewhere.length) {
    throw new AppError(
      `This account is connected to students at another center (${elsewhere
        .map((link) => link.student.name)
        .join(", ")}). Choose students from the new center for it first.`,
      400,
    );
  }
}

// GET /api/users/all — Teacher/Admin only (enforced at route level).
// An Admin sees every account. A Teacher sees the Teachers and Parent/Guardian
// accounts of their own center only, and only their own students in each
// account's studentIds.
export async function listUsers(req, res, next) {
  try {
    if (req.user.role === "Admin") {
      const users = await prisma.user.findMany({ select: PUBLIC_SELECT, orderBy: { name: "asc" } });
      return res.json(users.map((u) => toUserResponse(req, u)));
    }

    const centerId = teacherCenterId(req);
    const [users, ownStudents] = await Promise.all([
      prisma.user.findMany({
        select: PUBLIC_SELECT,
        where: { role: { in: ["Teacher", ...LINKABLE_ROLES] }, centerId },
        orderBy: { name: "asc" },
      }),
      prisma.student.findMany({ where: studentScopeFor(req.user) ?? { id: -1 }, select: { id: true } }),
    ]);
    const ownIds = new Set(ownStudents.map((s) => s.id));
    res.json(
      users.map((u) =>
        toUserResponse(req, { ...u, children: u.children?.filter((c) => ownIds.has(c.studentId)) }),
      ),
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/users/register — Teacher/Admin only (enforced at route level).
// Only an Admin may create another Admin account; a Teacher creating an
// account with role "Admin" is rejected here even if the request were
// crafted directly against the API, bypassing the frontend's own
// role-dropdown restriction (getAssignableRoles).
//
// Every non-Admin account belongs to a center. A Teacher's new account is
// always at the Teacher's own center (any centerId in the body is ignored); an
// Admin chooses it. A Parent/Guardian must end up connected to a student.
export async function registerUser(req, res, next) {
  try {
    const firstName = requireNamePart(req.body.firstName, "First name");
    const lastName = requireNamePart(req.body.lastName, "Last name");
    const middleName = optionalNamePart(req.body.middleName, "Middle name");
    const email = accountEmail(req.body.email);
    const password = requirePassword(req.body.password);
    const role = requireRoleValue(req.body.role);

    if (role === "Admin" && req.user.role !== "Admin") {
      return res.status(403).json({ message: "Only an Admin can grant the Admin role" });
    }
    // A Teacher manages families (Parent/Guardian accounts); creating another
    // staff login is an Admin decision.
    if (!LINKABLE_ROLES.includes(role) && req.user.role !== "Admin") {
      return res.status(403).json({ message: "Only an Admin can create a Teacher account" });
    }

    let centerId = null;
    if (req.user.role === "Teacher") centerId = teacherCenterId(req);
    else if (role !== "Admin") centerId = await requireExistingCenter(req.body.centerId);

    const phone = accountPhone(role, req.body.phone);
    const address = friendly("Address must be 500 characters or fewer.", () => optionalString(req.body.address, 500));
    const passwordHash = await bcrypt.hash(password, 10);

    const studentIds = Array.isArray(req.body.studentIds) ? parseStudentIds(req.body.studentIds) : [];

    if (studentIds.length && !LINKABLE_ROLES.includes(role)) {
      return res.status(400).json({ message: "Only Parent or Guardian accounts can be connected to students" });
    }
    if (studentIds.length) {
      if (req.user.role === "Teacher") await assertCanAccessStudents(req.user, studentIds);
      else await assertStudentsInCenter(studentIds, centerId);
    }

    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          firstName,
          middleName,
          lastName,
          name: composeUserName({ firstName, middleName, lastName }),
          email,
          passwordHash,
          role,
          phone,
          address,
          centerId,
        },
        select: PUBLIC_SELECT,
      });

      if (studentIds.length) {
        await tx.parentChild.createMany({
          data: studentIds.map((studentId) => ({ parentId: created.id, studentId })),
          skipDuplicates: true,
        });
      }
      if (LINKABLE_ROLES.includes(role)) {
        await linkStudentsByEmail(tx, created.id, email, centerId);
        await requireStudentLink(tx, created.id);
      }

      return tx.user.findUnique({ where: { id: created.id }, select: PUBLIC_SELECT });
    });

    res.status(201).json(await toScopedResponse(req, user));
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({
        message: "An account with this email address already exists. If it belongs to another center, ask an Admin to move it.",
      });
    }
    if (err.code === "P2003") {
      return res.status(400).json({ message: "One or more of the selected students no longer exist. Reload the page and try again." });
    }
    next(err);
  }
}

// PUT /api/profile/update — Teacher/Admin only (enforced at route level).
// Body carries the target account id as `userId` (not a URL param) to
// match the existing frontend contract.
export async function updateUser(req, res, next) {
  try {
    const id = parseId(req.body.userId, "userId");

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Account not found" });

    if (
      req.user.role === "Teacher" &&
      id !== req.user.id &&
      !LINKABLE_ROLES.includes(existing.role)
    ) {
      return res.status(403).json({ message: "Teachers can only modify their own or parent/guardian accounts" });
    }

    // ...and of those, only the ones at their own center. Answered like a
    // missing account, so a Teacher can't probe which accounts exist elsewhere.
    if (req.user.role === "Teacher" && id !== req.user.id) {
      if (existing.centerId !== teacherCenterId(req)) {
        return res.status(404).json({ message: NOT_IN_CENTER_MESSAGE });
      }
    }

    // Only an Admin may modify an existing Admin account, or promote any
    // account to Admin — defense in depth for the same rule the frontend's
    // role dropdown already enforces (getAssignableRoles).
    const requestedRole = req.body.role !== undefined ? requireRoleValue(req.body.role) : existing.role;
    if (
      req.user.role !== "Admin" &&
      (existing.role === "Admin" || requestedRole === "Admin")
    ) {
      return res.status(403).json({ message: "Only an Admin can modify an Admin account" });
    }

    // Changing a role moves an account between families and staff, so it is
    // an Admin decision (a Teacher could otherwise turn any Parent into a Teacher).
    if (req.user.role !== "Admin" && requestedRole !== existing.role) {
      return res.status(403).json({ message: "Only an Admin can change an account's role" });
    }

    const data = {};
    if (req.body.firstName !== undefined) data.firstName = requireNamePart(req.body.firstName, "First name");
    if (req.body.lastName !== undefined) data.lastName = requireNamePart(req.body.lastName, "Last name");
    if (req.body.middleName !== undefined) data.middleName = optionalNamePart(req.body.middleName, "Middle name");
    if (req.body.email !== undefined) data.email = accountEmail(req.body.email);
    // The email is where password-reset codes go, so changing someone's email
    // without their password is the same as taking the account. Only an Admin
    // may do it here; people change their own through Settings (which asks for
    // their password). The edit form resends the unchanged email, which is fine.
    if (data.email !== undefined && data.email !== existing.email && req.user.role !== "Admin") {
      return res.status(403).json({
        message: "Only an Admin can change an account's email address. The account owner can change it in Settings.",
      });
    }
    if (req.body.phone !== undefined) data.phone = accountPhone(requestedRole, req.body.phone);
    if (req.body.address !== undefined) {
      data.address = friendly("Address must be 500 characters or fewer.", () => optionalString(req.body.address, 500));
    }
    if (req.body.role !== undefined) data.role = requestedRole;

    // The center: an Admin sets it (a Teacher's account and every Parent/
    // Guardian need one); nobody else can move an account between centers.
    let centerId = existing.centerId;
    if (req.body.centerId !== undefined && req.body.centerId !== existing.centerId) {
      if (req.user.role !== "Admin") {
        // The edit form resends the unchanged value, which is fine; anything else is not.
        return res.status(403).json({ message: "Only an Admin can change an account's center" });
      }
      centerId = requestedRole === "Admin" ? null : await requireExistingCenter(req.body.centerId);
    }
    if (requestedRole === "Admin") centerId = null;
    else if (centerId == null) {
      return res.status(400).json({ message: "Choose a center for this account." });
    }
    const centerChanged = centerId !== existing.centerId;
    if (centerChanged) data.centerId = centerId;

    if (data.firstName !== undefined || data.middleName !== undefined || data.lastName !== undefined) {
      data.name = composeUserName({
        firstName: data.firstName ?? existing.firstName,
        middleName: data.middleName !== undefined ? data.middleName : existing.middleName,
        lastName: data.lastName ?? existing.lastName,
      });
    }

    const studentIds = Array.isArray(req.body.studentIds) ? parseStudentIds(req.body.studentIds) : null;

    if (studentIds && !LINKABLE_ROLES.includes(requestedRole) && studentIds.length) {
      return res.status(400).json({ message: "Only Parent or Guardian accounts can be connected to students" });
    }

    // A Teacher may only connect their own students, and replaces only their own
    // part of the list: links to another Teacher's students are not theirs to
    // remove (the form never shows them, so it never sends them).
    const teacherScoped = req.user.role === "Teacher";
    if (studentIds?.length) {
      if (teacherScoped) await assertCanAccessStudents(req.user, studentIds);
      else await assertStudentsInCenter(studentIds, centerId);
    }

    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id }, data, select: PUBLIC_SELECT });

      if (studentIds) {
        await tx.parentChild.deleteMany({
          where: teacherScoped ? { parentId: id, student: studentScopeFor(req.user) } : { parentId: id },
        });
        if (studentIds.length) {
          await tx.parentChild.createMany({
            data: studentIds.map((studentId) => ({ parentId: id, studentId })),
            skipDuplicates: true,
          });
          // Deactivated when its last child was deleted; a child again, so it works again.
          await tx.user.updateMany({ where: { id, isActive: false }, data: { isActive: true } });
        }
      } else if (LINKABLE_ROLES.includes(existing.role) && !LINKABLE_ROLES.includes(requestedRole)) {
        // Leaving Parent/Guardian: drop links so a Teacher/Admin never keeps
        // student access through ParentChild.
        await tx.parentChild.deleteMany({ where: { parentId: id } });
      }

      // Moving a Teacher to another center moves their students with them; the
      // Parent/Guardian accounts connected to those students must follow first.
      if (centerChanged && existing.role === "Teacher" && requestedRole === "Teacher") {
        const stranded = await tx.user.count({
          where: {
            role: { in: LINKABLE_ROLES },
            OR: [{ centerId: null }, { centerId: { not: centerId } }],
            children: { some: { student: { teacherId: id } } },
          },
        });
        if (stranded > 0) {
          throw new AppError(
            `${stranded} parent/guardian account${stranded === 1 ? " is" : "s are"} connected to this Teacher's students at their current center. Move ${stranded === 1 ? "it" : "them"} to the new center, or reassign the students, before changing this Teacher's center.`,
            400,
          );
        }
      }

      if (LINKABLE_ROLES.includes(requestedRole)) {
        // Match by email only when the email, role or center change could create
        // a new match; a plain edit must not restore links removed on purpose.
        const becameLinkable = !LINKABLE_ROLES.includes(existing.role);
        if (becameLinkable || centerChanged || (data.email && data.email !== existing.email)) {
          await linkStudentsByEmail(tx, id, data.email ?? existing.email, centerId);
        }
        if (centerChanged) await requireLinksInCenter(tx, id, centerId);
        await requireStudentLink(tx, id);
      }

      return tx.user.findUnique({ where: { id }, select: PUBLIC_SELECT });
    });

    res.json(await toScopedResponse(req, user));
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Account not found" });
    if (err.code === "P2002") {
      return res.status(409).json({
        message: "An account with this email address already exists. If it belongs to another center, ask an Admin to move it.",
      });
    }
    if (err.code === "P2003") {
      return res.status(400).json({ message: "One or more of the selected students no longer exist. Reload the page and try again." });
    }
    next(err);
  }
}

// PUT /api/profile/me — self-service profile update (name/email/phone/
// address). Deliberately does NOT accept `role` — role changes only ever
// go through the admin-managing-other-accounts flow (updateUser above).
export async function updateMyProfile(req, res, next) {
  try {
    const data = {};
    if (req.body.firstName !== undefined) data.firstName = requireNamePart(req.body.firstName, "First name");
    if (req.body.lastName !== undefined) data.lastName = requireNamePart(req.body.lastName, "Last name");
    if (req.body.middleName !== undefined) data.middleName = optionalNamePart(req.body.middleName, "Middle name");
    if (req.body.email !== undefined) data.email = accountEmail(req.body.email);
    if (req.body.phone !== undefined) data.phone = accountPhone(req.user.role, req.body.phone);
    if (req.body.address !== undefined) {
      data.address = friendly("Address must be 500 characters or fewer.", () => optionalString(req.body.address, 500));
    }

    // The email is where password-reset codes go, so changing it is as
    // sensitive as changing the password. Without this check, anyone holding
    // a stolen session token could point the account at their own mailbox,
    // trigger "forgot password", and own the account permanently. Require the
    // current password, exactly as the password-change flow already does.
    if (data.email !== undefined) {
      const account = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { email: true, passwordHash: true },
      });
      if (!account) return res.status(404).json({ message: "Account not found" });

      if (data.email !== account.email) {
        const { currentPassword } = req.body;
        if (typeof currentPassword !== "string" || !currentPassword) {
          return res.status(400).json({ message: "Current password is required to change your email" });
        }
        if (!(await bcrypt.compare(currentPassword, account.passwordHash))) {
          return res.status(401).json({ message: "Current password is incorrect" });
        }
      }
    }

    if (data.firstName !== undefined || data.middleName !== undefined || data.lastName !== undefined) {
      const existing = await prisma.user.findUnique({ where: { id: req.user.id } });
      if (!existing) return res.status(404).json({ message: "Account not found" });

      data.name = composeUserName({
        firstName: data.firstName ?? existing.firstName,
        middleName: data.middleName !== undefined ? data.middleName : existing.middleName,
        lastName: data.lastName ?? existing.lastName,
      });
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: PUBLIC_SELECT,
    });
    res.json(toUserResponse(req, user));
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Account not found" });
    if (err.code === "P2002") {
      return res.status(409).json({ message: "An account with this email already exists" });
    }
    next(err);
  }
}

// POST /api/profile/me/photo — self-service profile picture upload.
export async function uploadMyProfilePhoto(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No photo file was provided" });
    }

    const previous = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { profilePicture: true },
    });

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { profilePicture: fileUrl(req, req.file.filename) },
      select: PUBLIC_SELECT,
    });

    if (previous?.profilePicture) await removeStoredFiles(previous.profilePicture);
    res.json(toUserResponse(req, user));
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Account not found" });
    next(err);
  }
}

// PUT /api/profile/me/password — self-service password change. Bumps
// tokenVersion (matching the forgot-password flow's convention) so every
// *other* session is signed out, but issues a fresh token in the response
// so the session making this request isn't abruptly logged out mid-flow.
export async function requestPasswordChangeOtp(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true },
    });
    if (!user) return res.status(404).json({ message: "Account not found" });
    await issueAccountOtp(user.id, user.email, ACTIONS.PASSWORD_CHANGE);
    res.json({ message: "Verification code sent to your email" });
  } catch (err) {
    next(err);
  }
}

export async function changeMyPassword(req, res, next) {
  try {
    const { currentPassword, newPassword, otpCode } = req.body;
    if (typeof currentPassword !== "string" || !currentPassword) {
      return res.status(400).json({ message: "Current password is required" });
    }
    requirePassword(newPassword, "new password");
    if (!(await verifyAccountOtp(req.user.id, ACTIONS.PASSWORD_CHANGE, otpCode))) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ message: "Account not found" });
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ message: "Current password is incorrect" });

    const passwordHash = await bcrypt.hash(newPassword, 10);
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    });
    res.json({ message: "Password updated", token: signToken(updated) });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/profile/me — self-service account deletion, available to any
// authenticated role (unlike deleteUser above, which is the admin-managing-
// other-accounts flow). Requires re-entering the current password as
// confirmation for a destructive, irreversible action.
export async function requestAccountDeletionOtp(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true },
    });
    if (!user) return res.status(404).json({ message: "Account not found" });
    await issueAccountOtp(user.id, user.email, ACTIONS.ACCOUNT_DELETE);
    res.json({ message: "Verification code sent to your email" });
  } catch (err) {
    next(err);
  }
}

export async function deleteMyAccount(req, res, next) {
  try {
    const { password, otpCode } = req.body;
    if (typeof password !== "string" || !password) {
      return res.status(400).json({ message: "Password is required to confirm deletion" });
    }
    // The code is checked first (so the password can't be probed without it)
    // but only CONSUMED once the password is also right — a mistyped password
    // used to burn the code and force a new request.
    const otpRecord = await checkAccountOtp(req.user.id, ACTIONS.ACCOUNT_DELETE, otpCode);
    if (!otpRecord) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ message: "Account not found" });
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ message: "Incorrect password" });
    }
    // Student.teacherId is ON DELETE SET NULL, so deleting a Teacher who still
    // has students would leave them assigned to nobody — invisible to every
    // Teacher. Make them hand the students over first.
    if (user.role === "Teacher") {
      const assigned = await prisma.student.count({ where: { teacherId: user.id } });
      if (assigned > 0) {
        return res.status(400).json({
          message: "Reassign your students to another teacher before deleting this account.",
        });
      }
    }

    if (user.role === "Admin") {
      const adminCount = await prisma.user.count({ where: { role: "Admin", isActive: true } });
      if (adminCount <= 1) {
        return res.status(400).json({ message: "Promote another account to Admin before deleting this one." });
      }
    }

    // Last step before the irreversible one: every refusal above leaves the
    // code usable for a retry.
    if (!(await consumeAccountOtp(otpRecord))) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    await prisma.user.delete({ where: { id: user.id } });
    await removeStoredFiles(user.profilePicture);
    res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Account not found" });
    next(err);
  }
}

// DELETE /api/users/delete/:id — Teacher/Admin only (enforced at route level).
export async function deleteUser(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");

    if (id === req.user.id) {
      return res.status(400).json({ message: "You cannot delete your own account" });
    }

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Account not found" });

    if (req.user.role === "Teacher" && !["Parent", "Guardian"].includes(existing.role)) {
      return res.status(403).json({ message: "Teachers can only delete parent/guardian accounts" });
    }

    if (existing.role === "Admin" && req.user.role !== "Admin") {
      return res.status(403).json({ message: "Only an Admin can delete an Admin account" });
    }

    // A Teacher can delete only an account at their own center whose connected
    // students are all their own (or that has none). One that also reaches
    // another Teacher's student keeps that access, so only an Admin may remove it.
    if (req.user.role === "Teacher") {
      if (existing.centerId !== teacherCenterId(req)) {
        return res.status(404).json({ message: NOT_IN_CENTER_MESSAGE });
      }
      const scope = await teacherAccountScope(req.user, id);
      if (!scope.canDelete) {
        return res.status(403).json({
          message: "This account is also connected to students of another teacher, so only an Admin can delete it.",
        });
      }
    }

    await prisma.user.delete({ where: { id } }); // cascades to parent_children/notifications
    await removeStoredFiles(existing.profilePicture);
    res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Account not found" });
    next(err);
  }
}
