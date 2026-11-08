-- Per-center morning and afternoon school hours (minutes since midnight, school
-- timezone). The late cutoff for a session is its start time; until a center
-- saves times it keeps using the application defaults (8:00 AM / 1:00 PM), so
-- this migration changes no behaviour by itself.

-- CreateTable
CREATE TABLE "school_time_settings" (
    "id" SERIAL NOT NULL,
    "centerId" INTEGER NOT NULL,
    "morningStartMin" INTEGER NOT NULL,
    "morningEndMin" INTEGER NOT NULL,
    "afternoonStartMin" INTEGER NOT NULL,
    "afternoonEndMin" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "school_time_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "school_time_settings_centerId_key" ON "school_time_settings"("centerId");

-- AddForeignKey
ALTER TABLE "school_time_settings" ADD CONSTRAINT "school_time_settings_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "centers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Defence in depth behind the API's own validation: every value is a real
-- minute of the day, each session ends after it starts, and the afternoon does
-- not begin before the morning ends. Hand-written because Prisma's schema
-- language cannot express CHECK constraints; Prisma ignores what it doesn't model.
ALTER TABLE "school_time_settings" ADD CONSTRAINT "school_time_settings_valid_times" CHECK (
    "morningStartMin" >= 0
    AND "afternoonEndMin" <= 1439
    AND "morningStartMin" < "morningEndMin"
    AND "morningEndMin" <= "afternoonStartMin"
    AND "afternoonStartMin" < "afternoonEndMin"
);
