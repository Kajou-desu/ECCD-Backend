-- CreateEnum
CREATE TYPE "AttendanceSessionStatus" AS ENUM ('active', 'closed');

-- CreateTable: attendance_sessions — one row per teacher-started live
-- attendance run (Start/Stop Attendance). The foundation for face + BLE
-- verification; on its own it only records when a run was open.
CREATE TABLE "attendance_sessions" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "status" "AttendanceSessionStatus" NOT NULL DEFAULT 'active',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "startedById" INTEGER,

    CONSTRAINT "attendance_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "attendance_sessions_date_idx" ON "attendance_sessions"("date");

-- SetNull, not Cascade/Restrict: deleting a teacher account must neither
-- delete session history nor be blocked by it.
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- At most ONE active session at a time, enforced by the database itself so two
-- simultaneous "Start Attendance" clicks can't both win. Partial unique index:
-- every row with status = 'active' shares the same indexed value, so a second
-- active row is rejected. Hand-written because Prisma's schema language cannot
-- express partial indexes; Prisma ignores index predicates it doesn't model.
CREATE UNIQUE INDEX "attendance_sessions_one_active" ON "attendance_sessions"("status") WHERE "status" = 'active';
