-- Add stable public student codes while retaining numeric internal IDs.
ALTER TABLE "students" ADD COLUMN "studentCode" TEXT;

UPDATE "students"
SET "studentCode" = 'ECCD-2026-' || "id"::text
WHERE "studentCode" IS NULL;

ALTER TABLE "students" ALTER COLUMN "studentCode" SET NOT NULL;
CREATE UNIQUE INDEX "students_studentCode_key" ON "students"("studentCode");

CREATE TABLE "account_action_otps" (
  "id" SERIAL NOT NULL,
  "userId" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "otpCode" TEXT NOT NULL,
  "isUsed" BOOLEAN NOT NULL DEFAULT false,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_action_otps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "account_action_otps_userId_action_isUsed_idx"
  ON "account_action_otps"("userId", "action", "isUsed");
CREATE INDEX "account_action_otps_expiresAt_idx"
  ON "account_action_otps"("expiresAt");
ALTER TABLE "account_action_otps"
  ADD CONSTRAINT "account_action_otps_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
