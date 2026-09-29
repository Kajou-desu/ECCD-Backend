import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { sendAttendanceEmail } from "../lib/mailer.js";
import { sendSms } from "../lib/sms.js";

// Wall-clock time in the school's own timezone, e.g. "7:42 AM" — the same
// zone attendance itself is computed in (see utils/schoolDate.js), not the
// server's/UTC's.
function formatSchoolTime(date, timeZone = env.schoolTimezone) {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
}

// Fans a message out to every parent/guardian linked to a student: an
// in-app Notification row, plus best-effort email and SMS. Each channel, for
// each parent, is caught independently — one bounced email or bad phone
// number must never stop the others, and none of this may ever throw back
// into the attendance write that triggered it (see callers).
async function notifyParents(studentId, buildMessages) {
  const [student, links] = await Promise.all([
    prisma.student.findUnique({ where: { id: studentId }, select: { name: true } }),
    prisma.parentChild.findMany({
      where: { studentId },
      include: { parent: { select: { id: true, email: true, phone: true } } },
    }),
  ]);
  if (!student || links.length === 0) return;

  const { title, message, emailSubject, smsText } = buildMessages(student.name);

  // One parent at a time (a student has only a few): firing every email/SMS at
  // once can trip Resend's and Semaphore's per-second/per-minute limits.
  for (const { parent } of links) {
    if (!parent) continue;

    try {
      await prisma.notification.create({ data: { userId: parent.id, title, message } });
    } catch (err) {
      logger.error({ err, studentId, parentId: parent.id }, "Failed to write in-app attendance notification");
    }

    if (parent.email) {
      try {
        await sendAttendanceEmail(parent.email, emailSubject, message);
      } catch (err) {
        logger.error({ err, studentId, parentId: parent.id }, "Failed to send attendance email");
      }
    }

    if (parent.phone) {
      try {
        await sendSms(parent.phone, smsText);
      } catch (err) {
        logger.error({ err, studentId, parentId: parent.id }, "Failed to send attendance SMS");
      }
    }
  }
}

// Called after a student is marked present (automatic face+BLE verification,
// or a teacher's manual entry for today). Never throws: a notification
// failure must never turn a successful attendance write into a 500.
export async function notifyArrival(studentId, arrivedAt) {
  try {
    const time = formatSchoolTime(arrivedAt);
    await notifyParents(studentId, (name) => {
      const message = `${name} arrived at school at ${time}.`;
      return {
        title: "Arrival",
        message,
        emailSubject: `ECCD SmartTrack — ${name} has arrived`,
        smsText: `ECCD SmartTrack: ${message}`,
      };
    });
  } catch (err) {
    logger.error({ err, studentId }, "notifyArrival failed");
  }
}

// Called after a teacher/admin marks a student departed. Never throws, for
// the same reason as notifyArrival.
export async function notifyDeparture(studentId, departedAt) {
  try {
    const time = formatSchoolTime(departedAt);
    await notifyParents(studentId, (name) => {
      const message = `${name} has departed from school at ${time}.`;
      return {
        title: "Departure",
        message,
        emailSubject: `ECCD SmartTrack — ${name} has departed`,
        smsText: `ECCD SmartTrack: ${message}`,
      };
    });
  } catch (err) {
    logger.error({ err, studentId }, "notifyDeparture failed");
  }
}
