import { prisma } from "./prisma.js";
import { isLateArrival } from "../utils/late.js";
import { loadSchoolTimes, schoolTimesFor } from "./schoolTimes.js";

// Late is decided ONCE, at the moment an arrival is recorded, and stored on the
// attendance record (see utils/late.js lateOf for reading it back). That keeps
// history stable when a student moves to another session, teacher or center, or
// a center changes its school times.
//
//   const rules = await loadLateRules([studentId, ...]);        // before writing
//   ... { status, arrivedAt, late: lateFlag(rules, studentId, status, arrivedAt) }

// studentId -> { session, times }: each student's session and their center's
// school times, in two queries however many students there are.
export async function loadLateRules(studentIds) {
  const ids = [...new Set(studentIds)];
  if (ids.length === 0) return new Map();
  const students = await prisma.student.findMany({
    where: { id: { in: ids } },
    select: { id: true, session: true, teacher: { select: { centerId: true } } },
  });
  const times = await loadSchoolTimes(students.map((s) => s.teacher?.centerId));
  return new Map(
    students.map((s) => [s.id, { session: s.session, times: schoolTimesFor(times, s.teacher?.centerId) }]),
  );
}

// Never null: a record being written now has a definite answer. A student the
// rules don't know (deleted meanwhile) is simply not late.
export function lateFlag(rules, studentId, status, arrivedAt) {
  const rule = rules.get(studentId);
  return rule ? isLateArrival(status, arrivedAt, rule.session, rule.times) : false;
}
