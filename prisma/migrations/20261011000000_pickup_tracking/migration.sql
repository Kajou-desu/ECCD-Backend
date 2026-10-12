-- "Departed" becomes "picked up". RENAME (not drop + add) so existing departure
-- timestamps survive.
ALTER TABLE "attendance" RENAME COLUMN "departedAt" TO "pickedUpAt";

-- AlterTable: true when the pickup watch (not a teacher) recorded the pickup.
-- Only those are undone if the student is seen again.
ALTER TABLE "attendance" ADD COLUMN "pickedUpAuto" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: sessions started by the pickup watch, and the one-time
-- "pickup window is over, stop the camera" reminder.
ALTER TABLE "attendance_sessions" ADD COLUMN "autoStarted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "attendance_sessions" ADD COLUMN "stopReminderSentAt" TIMESTAMP(3);

-- CreateEnum
CREATE TYPE "PickupCheckAnswer" AS ENUM ('still_here', 'picked_up');

-- CreateTable: pickup_checks — "is this student still in the center?" prompts.
CREATE TABLE "pickup_checks" (
    "id" SERIAL NOT NULL,
    "studentId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "answeredAt" TIMESTAMP(3),
    "answer" "PickupCheckAnswer",

    CONSTRAINT "pickup_checks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pickup_checks_studentId_date_idx" ON "pickup_checks"("studentId", "date");

CREATE INDEX "pickup_checks_date_idx" ON "pickup_checks"("date");

ALTER TABLE "pickup_checks" ADD CONSTRAINT "pickup_checks_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
