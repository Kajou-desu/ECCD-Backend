-- Student transfers: a request that starts with the student's current teacher.
-- Same-center moves are applied at once and recorded as "accepted"; a move to
-- another center waits as "pending" until the receiving teacher accepts it.
CREATE TYPE "TransferStatus" AS ENUM ('pending', 'accepted', 'declined', 'cancelled');

CREATE TABLE "student_transfers" (
    "id" SERIAL NOT NULL,
    "studentId" INTEGER NOT NULL,
    "fromTeacherId" INTEGER,
    "toTeacherId" INTEGER,
    "fromCenterId" INTEGER,
    "toCenterId" INTEGER,
    "fromSession" "Session" NOT NULL,
    "toSession" "Session" NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'pending',
    "createdById" INTEGER,
    "resolvedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "student_transfers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "student_transfers_studentId_status_idx" ON "student_transfers"("studentId", "status");
CREATE INDEX "student_transfers_toTeacherId_status_idx" ON "student_transfers"("toTeacherId", "status");
CREATE INDEX "student_transfers_fromTeacherId_status_idx" ON "student_transfers"("fromTeacherId", "status");

-- At most one open request per student, enforced by the database so two
-- simultaneous requests can't both be created.
CREATE UNIQUE INDEX "student_transfers_one_pending_per_student" ON "student_transfers"("studentId") WHERE "status" = 'pending';

ALTER TABLE "student_transfers" ADD CONSTRAINT "student_transfers_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "student_transfers" ADD CONSTRAINT "student_transfers_fromTeacherId_fkey" FOREIGN KEY ("fromTeacherId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "student_transfers" ADD CONSTRAINT "student_transfers_toTeacherId_fkey" FOREIGN KEY ("toTeacherId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
