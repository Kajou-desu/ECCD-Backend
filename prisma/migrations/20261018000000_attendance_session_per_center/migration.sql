-- Live attendance sessions become per center: each center can run its own
-- session at the same time instead of the whole system sharing one.

-- AlterTable
ALTER TABLE "attendance_sessions" ADD COLUMN "centerId" INTEGER;

-- Data: a session belongs to the center of the Teacher who started it. Sessions
-- with no starter (auto-started by the pickup watch) or whose starter has no
-- center stay NULL, the "no center yet" session.
UPDATE "attendance_sessions" s
SET "centerId" = u."centerId"
FROM "users" u
WHERE s."startedById" = u."id";

CREATE INDEX "attendance_sessions_centerId_status_idx" ON "attendance_sessions"("centerId", "status");

-- Restrict: a center that still has session history cannot be deleted.
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "centers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most ONE active session per center (still enforced by the database, so two
-- simultaneous "Start Attendance" clicks at one center can't both win). Replaces
-- the single system-wide index. COALESCE gives the "no center yet" sessions one
-- shared slot of their own (a plain unique index would treat every NULL as
-- distinct); center ids start at 1, so 0 can never clash with a real center.
-- Hand-written because Prisma's schema language cannot express partial or
-- expression indexes; Prisma ignores indexes it doesn't model.
DROP INDEX "attendance_sessions_one_active";

CREATE UNIQUE INDEX "attendance_sessions_one_active_per_center" ON "attendance_sessions" ((COALESCE("centerId", 0))) WHERE "status" = 'active';
