-- AlterTable: password_reset_otps — add isUsed flag (audit 4.2)
ALTER TABLE "password_reset_otps" ADD COLUMN "isUsed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: submissions — add updatedAt for resubmission audit trail (audit 4.3)
ALTER TABLE "submissions" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex (audit 4.1, 4.2)
CREATE INDEX "password_reset_otps_email_otpCode_isUsed_idx" ON "password_reset_otps"("email", "otpCode", "isUsed");

-- CreateIndex
CREATE INDEX "password_reset_otps_expiresAt_idx" ON "password_reset_otps"("expiresAt");

-- CreateIndex
CREATE INDEX "students_status_idx" ON "students"("status");

-- CreateIndex
CREATE INDEX "students_session_idx" ON "students"("session");

-- CreateIndex
CREATE INDEX "students_name_idx" ON "students"("name");

-- CreateIndex
CREATE INDEX "attendance_date_idx" ON "attendance"("date");

-- CreateIndex
CREATE INDEX "attendance_status_idx" ON "attendance"("status");

-- CreateIndex
CREATE INDEX "events_date_idx" ON "events"("date");

-- CreateIndex
CREATE INDEX "events_category_idx" ON "events"("category");
