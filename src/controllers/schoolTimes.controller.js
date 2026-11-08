import { prisma } from "../lib/prisma.js";
import { AppError } from "../middleware/errorHandler.js";
import { parseId } from "../utils/validate.js";
import { NO_CENTER_MESSAGE, isMissingCenter } from "../utils/contentScope.js";
import { DEFAULT_SCHOOL_TIMES, requireSchoolTimes, toSchoolTimesResponse } from "../utils/schoolTimes.js";

// A center's morning and afternoon school hours (see utils/schoolTimes.js).
// Teacher/Admin only (enforced at route level).

// Which center the request is about, decided by the VERIFIED user: a Teacher's
// own center (a centerId in the request is ignored, like for new materials), an
// Admin — who has no center of their own — must name one.
function centerIdFor(req, requested) {
  if (req.user.role === "Teacher") {
    if (req.user.centerId == null) throw new AppError(NO_CENTER_MESSAGE, 403);
    return req.user.centerId;
  }
  if (req.user.role === "Admin") return parseId(requested, "centerId");
  throw new AppError("Forbidden", 403); // default deny
}

const toResponse = (centerId, row) => ({
  centerId,
  ...toSchoolTimesResponse(row ?? DEFAULT_SCHOOL_TIMES),
  // true until the center has saved times of its own
  isDefault: !row,
});

// GET /api/school-times[?centerId=N]  (centerId is only read for an Admin)
export async function getSchoolTimes(req, res, next) {
  try {
    const centerId = centerIdFor(req, req.query.centerId);
    const [center, row] = await Promise.all([
      prisma.center.findUnique({ where: { id: centerId }, select: { id: true } }),
      prisma.schoolTimeSettings.findUnique({ where: { centerId } }),
    ]);
    if (!center) throw new AppError("Center not found", 404);
    res.json(toResponse(centerId, row));
  } catch (err) {
    next(err);
  }
}

// PUT /api/school-times  { morningStart, morningEnd, afternoonStart, afternoonEnd, centerId? }
// Times are 24-hour "HH:MM" in the school's timezone. centerId is only read for
// an Admin.
export async function updateSchoolTimes(req, res, next) {
  try {
    const centerId = centerIdFor(req, req.body?.centerId);
    const times = requireSchoolTimes(req.body);
    const row = await prisma.schoolTimeSettings.upsert({
      where: { centerId },
      update: times,
      create: { centerId, ...times },
    });
    res.json(toResponse(centerId, row));
  } catch (err) {
    // An Admin named a center that doesn't exist (foreign key).
    if (isMissingCenter(err)) return next(new AppError("Center not found", 404));
    next(err);
  }
}
