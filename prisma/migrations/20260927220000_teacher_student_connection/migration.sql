-- AlterTable: free-text "which center" field for a Teacher account. No
-- fixed list of centers exists yet, so this is plain text rather than an enum.
ALTER TABLE "users" ADD COLUMN "centerLocation" TEXT;

-- AlterTable: one teacher per student.
ALTER TABLE "students" ADD COLUMN "teacherId" INTEGER;

CREATE INDEX "students_teacherId_idx" ON "students"("teacherId");

-- SetNull, not Cascade/Restrict: deleting a teacher account must neither
-- delete their students nor be blocked by it (same convention as
-- attendance_sessions.startedById).
ALTER TABLE "students" ADD CONSTRAINT "students_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
