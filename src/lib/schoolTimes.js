import { prisma } from "./prisma.js";
import { DEFAULT_SCHOOL_TIMES } from "../utils/schoolTimes.js";

// Saved school times for the given centers, as centerId -> row, in one query.
// A center with no row is simply absent from the map; schoolTimesFor supplies
// the defaults. A student's center is their teacher's (students carry no center
// of their own), so callers pass `student.teacher?.centerId`, which may be
// missing. Nothing is queried when no center is involved.
export async function loadSchoolTimes(centerIds) {
  const ids = [...new Set(centerIds.filter((id) => id != null))];
  if (ids.length === 0) return new Map();
  const rows = await prisma.schoolTimeSettings.findMany({ where: { centerId: { in: ids } } });
  return new Map(rows.map((row) => [row.centerId, row]));
}

export function schoolTimesFor(timesByCenter, centerId) {
  return timesByCenter.get(centerId) ?? DEFAULT_SCHOOL_TIMES;
}
