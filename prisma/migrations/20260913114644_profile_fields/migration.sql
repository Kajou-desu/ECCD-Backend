-- AlterTable: users — track last successful login and a profile picture
-- for account settings display (AccountSettings.jsx / ProfileSettings.jsx
-- previously showed hardcoded fake values and never persisted a photo).
ALTER TABLE "users" ADD COLUMN "lastLoginAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "profilePicture" TEXT;
