import bcrypt from "bcryptjs";
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

const ROLES = ["Teacher", "Parent", "Guardian", "Admin"];

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
};

// profilePicture is stored as a plain (unsigned) URL — signed fresh on
// every read, same pattern as materials/documents, so the signature never
// goes stale sitting in the database.
function toUserResponse(req, user) {
  return {
    ...user,
    profilePicture: user.profilePicture ? signFileUrl(req, user.profilePicture) : null,
  };
}

function requireRoleValue(value) {
  if (!ROLES.includes(value)) {
    throw new AppError(`Invalid role, expected one of: ${ROLES.join(", ")}`, 400);
  }
  return value;
}

// GET /api/users/all — Teacher/Admin only (enforced at route level).
export async function listUsers(req, res, next) {
  try {
    const users = await prisma.user.findMany({
      select: PUBLIC_SELECT,
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

    const user = await prisma.user.create({
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

    res.status(201).json(toUserResponse(req, user));
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ message: "An account with this email already exists" });
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

    const user = await prisma.user.update({ where: { id }, data, select: PUBLIC_SELECT });
    res.json(toUserResponse(req, user));
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Account not found" });
    if (err.code === "P2002") {
      return res.status(409).json({ message: "An account with this email already exists" });
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

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { profilePicture: fileUrl(req, req.file.filename) },
      select: PUBLIC_SELECT,
    });

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
export async function changeMyPassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body;
    if (typeof currentPassword !== "string" || !currentPassword) {
      return res.status(400).json({ message: "Current password is required" });
    }
    requirePassword(newPassword, "new password");

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ message: "Account not found" });

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ message: "Current password is incorrect" });

    const passwordHash = await bcrypt.hash(newPassword, 10);
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    });

    const token = signToken(updated);
    res.json({ message: "Password updated", token });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/profile/me — self-service account deletion, available to any
// authenticated role (unlike deleteUser above, which is the admin-managing-
// other-accounts flow). Requires re-entering the current password as
// confirmation for a destructive, irreversible action.
export async function deleteMyAccount(req, res, next) {
  try {
    const { password } = req.body;
    if (typeof password !== "string" || !password) {
      return res.status(400).json({ message: "Password is required to confirm deletion" });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ message: "Account not found" });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ message: "Incorrect password" });

    // Don't allow the last remaining Admin to delete themselves — that
    // would lock the whole organization out of account management with no
    // way back in.
    if (user.role === "Admin") {
      const adminCount = await prisma.user.count({
        where: { role: "Admin", isActive: true },
      });
      if (adminCount <= 1) {
        return res.status(400).json({
          message:
            "You're the only Admin account. Promote another account to Admin before deleting this one.",
        });
      }
    }

    await prisma.user.delete({ where: { id: user.id } }); // cascades to parent_children/notifications
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

    if (existing.role === "Admin" && req.user.role !== "Admin") {
      return res.status(403).json({ message: "Only an Admin can delete an Admin account" });
    }

    await prisma.user.delete({ where: { id } }); // cascades to parent_children/notifications
    res.status(204).send();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Account not found" });
    next(err);
  }
}
