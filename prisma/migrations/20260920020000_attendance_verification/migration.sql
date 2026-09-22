-- CreateEnum
CREATE TYPE "SignalKind" AS ENUM ('face', 'ble');

-- CreateTable: attendance_signals — latest face/BLE sighting per (session, student, kind).
CREATE TABLE "attendance_signals" (
    "id" SERIAL NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "studentId" INTEGER NOT NULL,
    "kind" "SignalKind" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_signals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "attendance_signals_sessionId_studentId_kind_key" ON "attendance_signals"("sessionId", "studentId", "kind");

CREATE INDEX "attendance_signals_sessionId_idx" ON "attendance_signals"("sessionId");

ALTER TABLE "attendance_signals" ADD CONSTRAINT "attendance_signals_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "attendance_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "attendance_signals" ADD CONSTRAINT "attendance_signals_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: attendance_verifications — audit trail for automatic attendance.
CREATE TABLE "attendance_verifications" (
    "id" SERIAL NOT NULL,
    "attendanceId" INTEGER NOT NULL,
    "sessionId" INTEGER,
    "faceDistance" DOUBLE PRECISION,
    "bleRssi" DOUBLE PRECISION,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_verifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "attendance_verifications_attendanceId_key" ON "attendance_verifications"("attendanceId");

CREATE INDEX "attendance_verifications_sessionId_idx" ON "attendance_verifications"("sessionId");

-- The evidence lives and dies with the attendance record it justifies.
ALTER TABLE "attendance_verifications" ADD CONSTRAINT "attendance_verifications_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "attendance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deleting a session (never done by the app today) keeps the evidence.
ALTER TABLE "attendance_verifications" ADD CONSTRAINT "attendance_verifications_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "attendance_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
