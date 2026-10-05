-- AlterTable: users — per-user opt-out for the optional attendance-alert
-- channels (email, SMS). NOT NULL DEFAULT true backfills every existing row
-- to "on", so behavior is unchanged until a user turns a channel off.
ALTER TABLE "users" ADD COLUMN "notifyByEmail" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "notifyBySms" BOOLEAN NOT NULL DEFAULT true;
