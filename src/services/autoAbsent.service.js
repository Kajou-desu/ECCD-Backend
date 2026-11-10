import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { loadSchoolTimes, schoolTimesFor } from "../lib/schoolTimes.js";
import { schoolDateString, schoolMinutesOfDay } from "../utils/schoolDate.js";

// When a session ends, every student of that session and center who still has no
// attendance record for the day is marked absent. A record of any kind (present,
// late, excused, or an absent that is already there) is left alone, so this only
// ever fills gaps. Nothing is done on a weekend, a no-class day, or a day with a
// Holiday or Event on the calendar ("Others" is shown to users as an Event).
//
// Each (day, session, center) is done at most once (AutoAbsentRun, written in the
// same transaction as the absences), so a teacher who later deletes or changes
// one of these records is never overruled, and a restart or a second server
// can't mark anyone twice. If the server was down when a session ended, the
// next tick the same day catches up; earlier days are not revisited.
export const CALENDAR_EVENT_CATEGORIES = ["Holiday", "Event", "Others"];
const NO_CENTER = 0;
const SESSIONS = [
  { session: "morning", endKey: "morningEndMin" },
  { session: "afternoon", endKey: "afternoonEndMin" },
];

// Weekend, no-class day, or a Holiday/Event on the calendar.
export async function isClassDay(dateString) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const [noClass, event] = await Promise.all([
    prisma.noClassDay.findUnique({ where: { date }, select: { id: true } }),
    prisma.event.findFirst({ where: { date, category: { in: CALENDAR_EVENT_CATEGORIES } }, select: { id: true } }),
  ]);
  return !noClass && !event;
}

const isUniqueViolation = (err) => err?.code === "P2002";

// Marks one (session, center) group absent. Returns how many were marked, or
// null if it had already been done.
async function markGroup({ date, session, centerKey }) {
  const centerWhere =
    centerKey === NO_CENTER
      ? { OR: [{ teacherId: null }, { teacher: { centerId: null } }] }
      : { teacher: { centerId: centerKey } };

  try {
    return await prisma.$transaction(async (tx) => {
      const students = await tx.student.findMany({
        where: { status: "active", session, ...centerWhere, attendance: { none: { date } } },
        select: { id: true },
      });
      // Claim the group first: a concurrent run hits the unique index and rolls back.
      await tx.autoAbsentRun.create({ data: { date, session, centerKey, absentCount: students.length } });
      if (students.length > 0) {
        await tx.attendance.createMany({
          data: students.map(({ id }) => ({ studentId: id, date, status: "absent", late: false })),
          skipDuplicates: true,
        });
      }
      return students.length;
    });
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

export async function runAutoAbsent(now = new Date()) {
  const dateString = schoolDateString(now);
  const date = new Date(`${dateString}T00:00:00.000Z`);
  const nowMin = schoolMinutesOfDay(now);

  // Not a class day: nobody is marked absent.
  if (!(await isClassDay(dateString))) return { marked: 0 };

  const centers = await prisma.center.findMany({ select: { id: true } });
  const timesByCenter = await loadSchoolTimes(centers.map((c) => c.id));
  const done = await prisma.autoAbsentRun.findMany({ where: { date }, select: { session: true, centerKey: true } });
  const doneKeys = new Set(done.map((r) => `${r.session}:${r.centerKey}`));

  let marked = 0;
  for (const centerKey of [...centers.map((c) => c.id), NO_CENTER]) {
    const times = schoolTimesFor(timesByCenter, centerKey === NO_CENTER ? null : centerKey);
    for (const { session, endKey } of SESSIONS) {
      if (nowMin < times[endKey] || doneKeys.has(`${session}:${centerKey}`)) continue;
      const count = await markGroup({ date, session, centerKey });
      if (count) {
        marked += count;
        logger.info({ date: dateString, session, centerKey, count }, "Marked absent at the end of the session");
      }
    }
  }
  return { marked };
}
