-- AlterTable: when the teachers were told that an automatically picked-up
-- student was seen at the entry camera again. Null = not told (yet).
ALTER TABLE "attendance" ADD COLUMN "pickupReturnAlertedAt" TIMESTAMP(3);
