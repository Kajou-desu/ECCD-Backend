import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import {
  updateUser,
  updateMyProfile,
  changeMyPassword,
  deleteMyAccount,
  uploadMyProfilePhoto,
} from "../controllers/users.controller.js";

const router = Router();

// Account management's edit-account flow (AccountForm.jsx). Not a
// self-service "edit my own profile" endpoint — see users.controller.js
// for why only Teacher/Admin can reach it and what it enforces.
router.put("/update", requireAuth, requireRole("Teacher", "Admin"), updateUser);

// Self-service — any authenticated role, scoped to the caller's own
// account only (req.user.id, never a client-supplied id).
router.put("/me", requireAuth, updateMyProfile);
router.post("/me/photo", requireAuth, upload.single("photo"), uploadMyProfilePhoto);
router.put("/me/password", requireAuth, changeMyPassword);
router.delete("/me", requireAuth, deleteMyAccount);

export default router;
