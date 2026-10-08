import { prisma } from "../lib/prisma.js";
import { listEnrolledStudentIds, removeStudentEnrollment } from "./recognitionClient.js";

// Face photos live in the recognition service, outside the database, so
// nothing stops them outliving their student (the service was down when the
// student was deleted, or the record was removed some other way). This finds
// the difference and, only when asked, erases it.
//
//   orphans  - enrolled, but no student row exists any more. Always safe to erase.
//   inactive - enrolled, student exists but is "inactive". These are NOT matched
//              at the door (the frame endpoint ignores inactive students) but the
//              photos are still held. Reported by default, erased only on request,
//              because "inactive" can be temporary (a school break).

// Pure: easy to test without a database or the service.
export function planReconcile(enrolledIds, students) {
  const statusById = new Map(students.map((s) => [s.id, s.status]));
  const orphans = [];
  const inactive = [];
  for (const id of enrolledIds) {
    if (!statusById.has(id)) orphans.push(id);
    else if (statusById.get(id) === "inactive") inactive.push(id);
  }
  return { orphans, inactive };
}

export async function reconcileEnrollments({ apply = false, purgeInactive = false } = {}) {
  const enrolledIds = await listEnrolledStudentIds();
  const students = enrolledIds.length
    ? await prisma.student.findMany({ where: { id: { in: enrolledIds } }, select: { id: true, status: true } })
    : [];
  const plan = planReconcile(enrolledIds, students);

  const toErase = apply ? [...plan.orphans, ...(purgeInactive ? plan.inactive : [])] : [];
  const erased = [];
  const failed = [];
  for (const id of toErase) {
    try {
      await removeStudentEnrollment(id);
      erased.push(id);
    } catch {
      failed.push(id); // reported by id only, never the error text (it may carry the service address)
    }
  }
  return { enrolled: enrolledIds.length, ...plan, erased, failed, applied: apply };
}
