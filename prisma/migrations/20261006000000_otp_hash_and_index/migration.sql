-- OTP codes are now stored as an HMAC-SHA256 hex digest (64 chars) in the
-- existing otpCode TEXT column instead of plaintext. No column change is
-- needed; the type already fits.
--
-- DEPLOY NOTE: any password_reset_otps / account_action_otps row that is
-- still unused at deploy time holds a plaintext code and can no longer match,
-- so it becomes invalid. They expire within 10 minutes anyway; affected users
-- just request a new code. Clearing them keeps that explicit.
DELETE FROM "password_reset_otps" WHERE "isUsed" = false;
DELETE FROM "account_action_otps" WHERE "isUsed" = false;

-- The lookup is (email, isUsed) ordered by createdAt DESC; the old
-- (email, otpCode, isUsed) index no longer matches the query.
DROP INDEX "password_reset_otps_email_otpCode_isUsed_idx";
CREATE INDEX "password_reset_otps_email_isUsed_createdAt_idx" ON "password_reset_otps"("email", "isUsed", "createdAt");
