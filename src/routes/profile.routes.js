import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { accountOtpLimiter, profileUpdateLimiter } from "../middleware/rateLimit.js";
import {
  updateUser,
  updateMyProfile,
  changeMyPassword,
  requestPasswordChangeOtp,
  deleteMyAccount,
  requestAccountDeletionOtp,
  uploadMyProfilePhoto,
} from "../controllers/users.controller.js";
import { auditAccountUpdate, auditOwnPasswordChange, auditOwnAccountDelete } from "../middleware/auditRoutes.js";

const router = Router();

// Account management's edit-account flow (AccountForm.jsx). Not a
// self-service "edit my own profile" endpoint — see users.controller.js
// for why only Teacher/Admin can reach it and what it enforces.
router.put("/update", requireAuth, requireRole("Teacher", "Admin"), auditAccountUpdate, updateUser);

// Self-service — any authenticated role, scoped to the caller's own
// account only (req.user.id, never a client-supplied id).
router.put("/me", requireAuth, profileUpdateLimiter, updateMyProfile);
router.post("/me/photo", requireAuth, upload.single("photo", { imagesOnly: true }), uploadMyProfilePhoto);
router.post("/me/password/request-otp", requireAuth, accountOtpLimiter, requestPasswordChangeOtp);
router.put("/me/password", requireAuth, accountOtpLimiter, auditOwnPasswordChange, changeMyPassword);
// Self-deletion is Admin-only: Teacher and Parent/Guardian accounts are removed
// by an Admin (DELETE /users/delete/:id), which also keeps a family's or a
// class's data from vanishing on a single tap. deleteMyAccount still refuses to
// remove the last Admin.
router.post("/me/delete/request-otp", requireAuth, requireRole("Admin"), accountOtpLimiter, requestAccountDeletionOtp);
router.delete("/me", requireAuth, requireRole("Admin"), accountOtpLimiter, auditOwnAccountDelete, deleteMyAccount);

export default router;
