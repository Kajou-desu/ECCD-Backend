import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

const MAX_TITLE_LENGTH = 100;

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Tells the teacher connected to a student (Student.teacherId) that a parent
// or guardian submitted work. In-app only — unlike attendance, this has no
// email/SMS channel. A student with no teacher assigned is a silent no-op.
// Never throws: a notification failure must never turn a successful
// submission into a 500 (same contract as attendanceNotification.service.js).
export async function notifyTeacherOfSubmission(studentId, materialTitle) {
  try {
    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: { name: true, teacherId: true },
    });
    if (!student || !student.teacherId) return;

    const title = "New submission";
    const message = `${student.name} submitted work for "${truncate(materialTitle, MAX_TITLE_LENGTH)}".`;

    await prisma.notification.create({
      data: { userId: student.teacherId, title, message },
    });
  } catch (err) {
    logger.error({ err, studentId }, "notifyTeacherOfSubmission failed");
  }
}
