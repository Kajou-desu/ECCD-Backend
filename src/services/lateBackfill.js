import { prisma } from "../lib/prisma.js";
import { isLateArrival } from "../utils/late.js";
import { loadSchoolTimes, schoolTimesFor } from "../lib/schoolTimes.js";

// Gives attendance records that predate the stored `late` flag (late = null)
// their answer, judged ONCE with each student's session and center times as they
// are right now. Used by scripts/backfill-attendance-late.js for everything, and
// by a student transfer for that one student, so the move can't re-judge their
// old records against a new session or center. `where` narrows which records;
// `db` is the prisma client or a transaction. Returns how many were fixed.
export async function freezeLate({ where = {}, db = prisma, batchSize = 500 } = {}) {
  let fixed = 0;
  for (;;) {
    const rows = await db.attendance.findMany({
      where: { ...where, late: null },
      select: {
        id: true,
        status: true,
        arrivedAt: true,
        student: { select: { session: true, teacher: { select: { centerId: true } } } },
      },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    if (rows.length === 0) return fixed;

    const times = await loadSchoolTimes(rows.map((r) => r.student.teacher?.centerId));
    const late = [];
    const onTime = [];
    for (const r of rows) {
      const rule = schoolTimesFor(times, r.student.teacher?.centerId);
      (isLateArrival(r.status, r.arrivedAt, r.student.session, rule) ? late : onTime).push(r.id);
    }
    // Every row in the batch gets a non-null value, so the next pass starts after them.
    if (late.length) await db.attendance.updateMany({ where: { id: { in: late } }, data: { late: true } });
    if (onTime.length) await db.attendance.updateMany({ where: { id: { in: onTime } }, data: { late: false } });
    fixed += rows.length;
  }
}

export const countUnfrozenLate = (db = prisma) => db.attendance.count({ where: { late: null } });
