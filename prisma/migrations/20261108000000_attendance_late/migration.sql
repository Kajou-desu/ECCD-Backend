-- Late is decided once, when the arrival is recorded, and kept on the record.
-- NULL = a record from before this column existed: it is still judged live
-- (see utils/late.js lateOf) until scripts/backfill-attendance-late.js fixes it.
ALTER TABLE "attendance" ADD COLUMN "late" BOOLEAN;
