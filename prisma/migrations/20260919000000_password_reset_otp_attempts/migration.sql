-- Count wrong guesses against each password-reset OTP so it can be locked
-- after too many attempts (account_action_otps already has this column).
ALTER TABLE "password_reset_otps" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
