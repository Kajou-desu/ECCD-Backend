-- AlterTable
-- Guardian is no longer mandatory on its own: a student record is valid as
-- long as at least one of motherName / fatherName / guardianName is set
-- (enforced in application code, students.controller.js).
ALTER TABLE "students" ALTER COLUMN "guardianName" DROP NOT NULL;
ALTER TABLE "students" ALTER COLUMN "guardianPhone" DROP NOT NULL;
