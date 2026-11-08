import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { studentTransferLimiter } from "../middleware/rateLimit.js";
import {
  createTransfer,
  listTransfers,
  listTransferTeachers,
  acceptTransfer,
  declineTransfer,
  cancelTransfer,
} from "../controllers/studentTransfers.controller.js";
import {
  auditTransferCreate,
  auditTransferAccept,
  auditTransferDecline,
  auditTransferCancel,
} from "../middleware/auditRoutes.js";

const router = Router();

// Who may do what to WHICH transfer is decided in the controller (the student's
// own teacher starts one, the receiving teacher answers it); the role check here
// only keeps parents out.
router.use(requireAuth, requireRole("Teacher", "Admin"));
router.get("/", listTransfers);
router.get("/teachers", listTransferTeachers);
router.post("/", studentTransferLimiter, auditTransferCreate, createTransfer);
router.post("/:id/accept", studentTransferLimiter, auditTransferAccept, acceptTransfer);
router.post("/:id/decline", studentTransferLimiter, auditTransferDecline, declineTransfer);
router.post("/:id/cancel", studentTransferLimiter, auditTransferCancel, cancelTransfer);

export default router;
