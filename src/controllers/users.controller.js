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
  requirePassword,
} from "../utils/validate.js";
import { AppError } from "../middleware/errorHandler.js";
import { sendOtpEmail } from "../lib/mailer.js";
import { removeStoredFiles } from "../lib/fileStorage.js";
import { otpMatches, MAX_OTP_ATTEMPTS } from "../utils/otp.js";

const ROLES = ["Teacher", "Parent", "Guardian", "Admin"];

const ACTIONS = {
  PASSWORD_CHANGE: "password_change",
  ACCOUNT_DELETE: "account_delete",
};

async function issueAccountOtp(userId, email, action) {
  await prisma.accountActionOtp.updateMany({
    where: { userId, action, isUsed: false },
    data: { isUsed: true },
  });
  const otpCode = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await prisma.accountActionOtp.create({ data: { userId, action, otpCode, expiresAt } });
  await sendOtpEmail(
    email,
    otpCode,
    action === ACTIONS.PASSWORD_CHANGE ? "Password Change" : "Account Deletion",
  );
}

async function verifyAccountOtp(userId, action, otpCode) {
  const record = await prisma.accountActionOtp.findFirst({
    where: { userId, action, isUsed: false },
    orderBy: { createdAt: "desc" },
  });
  if (!record || record.expiresAt < new Date() || record.attempts >= MAX_OTP_ATTEMPTS) return false;
  if (!otpMatches(otpCode, record.otpCode)) {
    await prisma.accountActionOtp.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    return false;
  }
  await prisma.accountActionOtp.update({ where: { id: record.id }, data: { isUsed: true } });
  return true;
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
    profilePicture: user.profilePicture ? signFileUrl(req, user.profilePicture) : null,
    studentIds: user.children?.map((child) => child.studentId) ?? [],
  };
}

function requireRoleValue(value) {
  if (!ROLES.includes(value)) {
    throw new AppError(`Invalid role, expected one of: ${ROLES.join(", ")}`, 400);
  }
  return value;
}

const LINKABLE_ROLES = ["Parent", "Guardian"];

// Reverse of the student-side linking: connects a Parent/Guardian account to
// students whose registration lists its email. Only called from the admin
// flows (register/update), never from self-service email changes, which are
// not verified. Adds links only; existing ones are kept.
async function linkStudentsByEmail(tx, userId, email) {
  const students = await tx.student.findMany({
    where: { OR: [{ motherEmail: email }, { fatherEmail: email }, { guardianEmail: email }] },
    select: { id: true },
  });
  if (!students.length) return;
  await tx.parentChild.createMany({
    data: students.map((student) => ({ parentId: userId, studentId: student.id })),
    skipDuplicates: true,
  });
}

// GET /api/users/all — Teacher/Admin only (enforced at route level).
export async function listUsers(req, res, next) {
  try {
    const users = await prisma.user.findMany({
      select: PUBLIC_SELECT,
      where: req.user.role === "Admin" ? undefined : { role: { not: "Admin" } },
      orderBy: { name: "asc" },
    });
    res.json(users.map((u) => toUserResponse(req, u)));
  } catch (err) {
    next(err);
  }
}

// POST /api/users/register — Teacher/Admin only (enforced at route level).
// Only an Admin may create another Admin account; a Teacher creating an
// account with role "Admin" is rejected here even if the request were
// crafted directly against the API, bypassing the frontend's own
// role-dropdown restriction (getAssignableRoles).
export async function registerUser(req, res, next) {
  try {
    const firstName = requireNonEmptyString(req.body.firstName, "firstName", 100);
    const lastName = requireNonEmptyString(req.body.lastName, "lastName", 100);
    const middleName = optionalString(req.body.middleName, 100);
    const email = requireEmail(req.body.email);
    const password = requirePassword(req.body.password);
    const role = requireRoleValue(req.body.role);

    if (role === "Admin" && req.user.role !== "Admin") {
      return res.status(403).json({ message: "Only an Admin can grant the Admin role" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const studentIds = Array.isArray(req.body.studentIds)
      ? [...new Set(req.body.studentIds.map((id) => Number(id)).filter(Number.isInteger))]
      : [];

    if (studentIds.length && !["Parent", "Guardian"].includes(role)) {
      return res.status(400).json({ message: "Only Parent or Guardian accounts can be connected to students" });
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
          phone: optionalPhone(req.body.phone, "phone"),
          address: optionalString(req.body.address, 500),
        },
        select: PUBLIC_SELECT,
      });

      if (studentIds.length) {
        await tx.parentChild.createMany({
          data: studentIds.map((studentId) => ({ parentId: created.id, studentId })),
          skipDuplicates: true,
        });
      }
      if (LINKABLE_ROLES.includes(role)) await linkStudentsByEmail(tx, created.id, email);

      return tx.user.findUnique({ where: { id: created.id }, select: PUBLIC_SELECT });
    });

    res.status(201).json(toUserResponse(req, user));
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ message: "An account with this email already exists" });
    }
    if (err.code === "P2003") {
      return res.status(400).json({ message: "One or more selected students do not exist" });
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
      !["Parent", "Guardian"].includes(existing.role)
    ) {
      return res.status(403).json({ message: "Teachers can only modify their own or parent/guardian accounts" });
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

    const data = {};
    if (req.body.firstName !== undefined) data.firstName = requireNonEmptyString(req.body.firstName, "firstName", 100);
    if (req.body.lastName !== undefined) data.lastName = requireNonEmptyString(req.body.lastName, "lastName", 100);
    if (req.body.middleName !== undefined) data.middleName = optionalString(req.body.middleName, 100);
    if (req.body.email !== undefined) data.email = requireEmail(req.body.email);
    if (req.body.phone !== undefined) data.phone = optionalPhone(req.body.phone, "phone");
    if (req.body.address !== undefined) data.address = optionalString(req.body.address, 500);
    if (req.body.role !== undefined) data.role = requestedRole;

    if (data.firstName !== undefined || data.middleName !== undefined || data.lastName !== undefined) {
      data.name = composeUserName({
        firstName: data.firstName ?? existing.firstName,
        middleName: data.middleName !== undefined ? data.middleName : existing.middleName,
        lastName: data.lastName ?? existing.lastName,
      });
    }

    const studentIds = Array.isArray(req.body.studentIds)
      ? [...new Set(req.body.studentIds.map((value) => Number(value)).filter(Number.isInteger))]
      : null;

    if (studentIds && !["Parent", "Guardian"].includes(requestedRole) && studentIds.length) {
      return res.status(400).json({ message: "Only Parent or Guardian accounts can be connected to students" });
    }

    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id }, data, select: PUBLIC_SELECT });

      if (studentIds) {
        await tx.parentChild.deleteMany({ where: { parentId: id } });
        if (studentIds.length) {
          await tx.parentChild.createMany({
            data: studentIds.map((studentId) => ({ parentId: id, studentId })),
            skipDuplicates: true,
          });
        }
      } else if (LINKABLE_ROLES.includes(existing.role) && !LINKABLE_ROLES.includes(requestedRole)) {
        // Leaving Parent/Guardian: drop links so a Teacher/Admin never keeps
        // student access through ParentChild.
        await tx.parentChild.deleteMany({ where: { parentId: id } });
      }

      // Match by email only when the email or role change could create a
      // new match; a plain edit must not restore links removed on purpose.
      const becameLinkable = !LINKABLE_ROLES.includes(existing.role) && LINKABLE_ROLES.includes(requestedRole);
      if (LINKABLE_ROLES.includes(requestedRole) && (becameLinkable || (data.email && data.email !== existing.email))) {
        await linkStudentsByEmail(tx, id, data.email ?? existing.email);
      }

      return tx.user.findUnique({ where: { id }, select: PUBLIC_SELECT });
    });

    res.json(toUserResponse(req, user));
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Account not found" });
    if (err.code === "P2002") {
      return res.status(409).json({ message: "An account with this email already exists" });
    }
    if (err.code === "P2003") {
      return res.status(400).json({ message: "One or more selected students do not exist" });
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
    if (req.body.firstName !== undefined) data.firstName = requireNonEmptyString(req.body.firstName, "firstName", 100);
    if (req.body.lastName !== undefined) data.lastName = requireNonEmptyString(req.body.lastName, "lastName", 100);
    if (req.body.middleName !== undefined) data.middleName = optionalString(req.body.middleName, 100);
    if (req.body.email !== undefined) data.email = requireEmail(req.body.email);
    if (req.body.phone !== undefined) data.phone = optionalPhone(req.body.phone, "phone");
    if (req.body.address !== undefined) data.address = optionalString(req.body.address, 500);

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
    if (!(await verifyAccountOtp(req.user.id, ACTIONS.ACCOUNT_DELETE, otpCode))) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ message: "Account not found" });
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ message: "Incorrect password" });
    }

    if (user.role === "Admin") {
      const adminCount = await prisma.user.count({ where: { role: "Admin", isActive: true } });
      if (adminCount <= 1) {
        return res.status(400).json({ message: "Promote another account to Admin before deleting this one." });
      }
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

    await prisma.user.delete({ where: { id } }); // cascades to parent_children/notifications
    await removeStoredFiles(existing.profilePicture);
    res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Account not found" });
    next(err);
  }
}
