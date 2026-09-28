-- AlterTable: track when a student left school, so parents can be notified
-- on departure the same way they are on arrival. Nullable and set only by a
-- manual teacher/admin action (PATCH /attendance/:studentId/depart) — there is
-- no hardware signal for "left the building", only for "seen at the door".
ALTER TABLE "attendance" ADD COLUMN "departedAt" TIMESTAMP(3);
