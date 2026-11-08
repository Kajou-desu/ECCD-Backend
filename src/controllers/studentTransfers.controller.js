import { prisma } from "../lib/prisma.js";
import { AppError } from "../middleware/errorHandler.js";
import { parseId, requireSession } from "../utils/validate.js";
import { freezeLate } from "../services/lateBackfill.js";

// Moving a student to another session, teacher or center.
//
//   POST /api/student-transfers          { studentId, toTeacherId?, toSession? }
//   GET  /api/student-transfers          what is waiting for me / what I asked for
//   GET  /api/student-transfers/teachers who a student can be moved to
//   POST /api/student-transfers/:id/accept | decline | cancel
//
// It always STARTS with the student's current teacher (an Admin may start one
// for anyone). Who has to agree depends on what changes:
//   * only the session, or a colleague at the same center: applied at once (they
//     share that center's data already); the new teacher is told;
//   * a teacher at ANOTHER center: pending until that teacher accepts, because it
//     hands a child's whole record to a different center. The requester can
//     cancel while it waits.
//   * an Admin's transfer is always applied at once.
// A student's attendance history stays with them. Late was decided when each
// arrival was recorded, so it does not change with the move (records from before
// that are fixed first, see freezeLate).

const TEACHER_SELECT = { id: true, name: true, centerId: true, center: { select: { name: true } } };
const INCLUDE = {
  student: { select: { id: true, name: true } },
  fromTeacher: { select: TEACHER_SELECT },
  toTeacher: { select: TEACHER_SELECT },
};

const person = (t) => (t ? { id: t.id, name: t.name, centerId: t.centerId, centerName: t.center?.name ?? null } : null);
export const toTransferResponse = (t) => ({
  id: t.id,
  status: t.status,
  createdAt: t.createdAt,
  resolvedAt: t.resolvedAt,
  student: t.student,
  fromTeacher: person(t.fromTeacher),
  toTeacher: person(t.toTeacher),
  fromSession: t.fromSession,
  toSession: t.toSession,
});

const isAdmin = (user) => user.role === "Admin";
const notify = (tx, userId, title, message) =>
  userId == null ? null : tx.notification.create({ data: { userId, title, message } });

// Moves the student. Runs inside the transaction that records the transfer, so a
// problem anywhere (a parent that can't follow, a student who has meanwhile been
// moved by someone else) undoes all of it.
async function applyTransfer(tx, t) {
  // Judge the student's old records (those from before Late was stored) as they
  // are NOW, before the session or center changes under them.
  await freezeLate({ where: { studentId: t.studentId }, db: tx });

  // Their parents' accounts belong to a center, and must follow the child there.
  if (t.fromCenterId !== t.toCenterId) {
    const links = await tx.parentChild.findMany({
      where: { studentId: t.studentId },
      select: { parentId: true, parent: { select: { centerId: true } } },
    });
    const follow = links.filter((l) => l.parent.centerId !== t.toCenterId).map((l) => l.parentId);
    if (follow.length > 0) {
      // A parent whose OTHER child stays at the old center can't belong to both.
      const staying =
        t.fromCenterId == null
          ? 0
          : await tx.parentChild.count({
              where: {
                parentId: { in: follow },
                studentId: { not: t.studentId },
                student: { teacher: { centerId: t.fromCenterId } },
              },
            });
      if (staying > 0) {
        throw new AppError(
          "A parent or guardian of this student also has another child at the current center. Disconnect them from one of the children first.",
          400,
        );
      }
      await tx.user.updateMany({ where: { id: { in: follow } }, data: { centerId: t.toCenterId } });
    }
  }

  // Guarded on where the request says the student is, so a student moved by
  // someone else in the meantime is never overwritten.
  const { count } = await tx.student.updateMany({
    where: { id: t.studentId, teacherId: t.fromTeacherId, session: t.fromSession },
    data: { teacherId: t.toTeacherId, session: t.toSession },
  });
  if (count === 0) throw new AppError("This student has changed since the request was made. Please start a new transfer.", 409);
}

const describeMove = (t) => {
  const parts = [];
  if (t.fromTeacherId !== t.toTeacherId) parts.push(`to teacher ${t.toTeacher?.name ?? "?"}`);
  if (t.fromSession !== t.toSession) parts.push(`to the ${t.toSession} session`);
  return parts.join(" and ");
};

// POST /api/student-transfers
export async function createTransfer(req, res, next) {
  try {
    const body = req.body ?? {};
    const studentId = parseId(body.studentId, "studentId");
    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true, name: true, session: true, teacherId: true, teacher: { select: TEACHER_SELECT } },
    });
    // Only the student's own teacher (or an Admin) may start it. A student that
    // doesn't exist and another teacher's student get the same answer.
    const allowed = isAdmin(req.user) || (req.user.role === "Teacher" && student?.teacherId === req.user.id);
    if (!student || !allowed) throw new AppError("Forbidden", 403);

    const toSession = body.toSession === undefined ? student.session : requireSession(body.toSession);
    const toTeacherId = body.toTeacherId === undefined ? student.teacherId : parseId(body.toTeacherId, "toTeacherId");
    if (toTeacherId === null) throw new AppError("Choose the teacher to move this student to", 400);
    const toTeacher = await prisma.user.findFirst({
      where: { id: toTeacherId, role: "Teacher", isActive: true },
      select: TEACHER_SELECT,
    });
    if (!toTeacher) throw new AppError("Selected teacher not found", 400);
    if (toTeacher.centerId == null) throw new AppError("That teacher isn't assigned to a center yet", 400);
    if (toTeacher.id === student.teacherId && toSession === student.session) {
      throw new AppError("The student is already with that teacher in that session", 400);
    }

    const fromCenterId = student.teacher?.centerId ?? null;
    const immediate =
      isAdmin(req.user) ||
      toTeacher.id === student.teacherId ||
      (fromCenterId !== null && fromCenterId === toTeacher.centerId);

    const transfer = await prisma.$transaction(async (tx) => {
      const open = await tx.studentTransfer.findFirst({ where: { studentId, status: "pending" }, select: { id: true } });
      if (open) throw new AppError("There is already a transfer waiting for this student", 409);

      const now = new Date();
      const created = await tx.studentTransfer.create({
        data: {
          studentId,
          fromTeacherId: student.teacherId,
          toTeacherId: toTeacher.id,
          fromCenterId,
          toCenterId: toTeacher.centerId,
          fromSession: student.session,
          toSession,
          createdById: req.user.id,
          ...(immediate && { status: "accepted", resolvedAt: now, resolvedById: req.user.id }),
        },
        include: INCLUDE,
      });

      if (immediate) {
        await applyTransfer(tx, created);
        if (toTeacher.id !== req.user.id && toTeacher.id !== student.teacherId) {
          await notify(tx, toTeacher.id, "Student transferred to you", `${student.name} was moved ${describeMove(created)}.`);
        }
      } else {
        await notify(
          tx,
          toTeacher.id,
          "Student transfer request",
          `${created.fromTeacher?.name ?? "A teacher"} (${created.fromTeacher?.centerName ?? "another center"}) asks you to take ${student.name}. Review it under Students.`,
        );
      }
      return created;
    });

    res.status(immediate ? 200 : 202).json(toTransferResponse(transfer));
  } catch (err) {
    // The partial unique index caught a simultaneous second request.
    if (err?.code === "P2002") return next(new AppError("There is already a transfer waiting for this student", 409));
    next(err);
  }
}

// GET /api/student-transfers — pending requests only.
//   incoming: waiting for me to accept (an Admin sees every pending one here)
//   outgoing: ones I asked for
export async function listTransfers(req, res, next) {
  try {
    const admin = isAdmin(req.user);
    const [incoming, outgoing] = await Promise.all([
      prisma.studentTransfer.findMany({
        where: { status: "pending", ...(admin ? {} : { toTeacherId: req.user.id }) },
        include: INCLUDE,
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      admin
        ? []
        : prisma.studentTransfer.findMany({
            where: { status: "pending", fromTeacherId: req.user.id },
            include: INCLUDE,
            orderBy: { createdAt: "desc" },
            take: 100,
          }),
    ]);
    res.json({ incoming: incoming.map(toTransferResponse), outgoing: outgoing.map(toTransferResponse) });
  } catch (err) {
    next(err);
  }
}

// GET /api/student-transfers/teachers — the active Teachers a student can be
// moved to, with their center's name (and nothing else about them).
export async function listTransferTeachers(req, res, next) {
  try {
    const teachers = await prisma.user.findMany({
      where: { role: "Teacher", isActive: true, centerId: { not: null }, id: { not: req.user.id } },
      select: TEACHER_SELECT,
      orderBy: { name: "asc" },
      take: 500,
    });
    res.json(teachers.map(person));
  } catch (err) {
    next(err);
  }
}

// accept / decline / cancel share the lookup and the "still pending" guard.
async function resolve(req, res, next, { allowed, status, effect, notice }) {
  try {
    const id = parseId(req.params.id, "id");
    const found = await prisma.studentTransfer.findUnique({ where: { id }, include: INCLUDE });
    // Not yours and not there look the same.
    if (!found || !(isAdmin(req.user) || allowed(found, req.user))) throw new AppError("Forbidden", 403);
    if (found.status !== "pending") throw new AppError("This transfer has already been dealt with", 409);

    const result = await prisma.$transaction(async (tx) => {
      // Only one of two simultaneous answers wins.
      const { count } = await tx.studentTransfer.updateMany({
        where: { id, status: "pending" },
        data: { status, resolvedAt: new Date(), resolvedById: req.user.id },
      });
      if (count === 0) throw new AppError("This transfer has already been dealt with", 409);
      if (effect) await effect(tx, found);
      const [userId, title, message] = notice(found);
      await notify(tx, userId, title, message);
      return tx.studentTransfer.findUnique({ where: { id }, include: INCLUDE });
    });
    res.json(toTransferResponse(result));
  } catch (err) {
    next(err);
  }
}

// POST /api/student-transfers/:id/accept — the receiving teacher (or an Admin)
export const acceptTransfer = (req, res, next) =>
  resolve(req, res, next, {
    allowed: (t, user) => t.toTeacherId === user.id,
    status: "accepted",
    effect: applyTransfer,
    notice: (t) => [t.fromTeacherId, "Transfer accepted", `${t.toTeacher?.name ?? "The teacher"} accepted ${t.student.name}.`],
  });

// POST /api/student-transfers/:id/decline — the receiving teacher (or an Admin)
export const declineTransfer = (req, res, next) =>
  resolve(req, res, next, {
    allowed: (t, user) => t.toTeacherId === user.id,
    status: "declined",
    notice: (t) => [t.fromTeacherId, "Transfer declined", `${t.toTeacher?.name ?? "The teacher"} declined ${t.student.name}. They stay with you.`],
  });

// POST /api/student-transfers/:id/cancel — the teacher who asked (or an Admin)
export const cancelTransfer = (req, res, next) =>
  resolve(req, res, next, {
    allowed: (t, user) => t.fromTeacherId === user.id,
    status: "cancelled",
    notice: (t) => [t.toTeacherId, "Transfer cancelled", `The request to move ${t.student.name} to you was cancelled.`],
  });
