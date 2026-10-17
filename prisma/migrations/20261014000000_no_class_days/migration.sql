-- CreateTable: days with no class. A weekday is a school day unless it is listed here.
CREATE TABLE "no_class_days" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "reason" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "no_class_days_pkey" PRIMARY KEY ("id")
);

-- One row per date.
CREATE UNIQUE INDEX "no_class_days_date_key" ON "no_class_days"("date");

-- Deleting the account that set a day keeps the day.
ALTER TABLE "no_class_days" ADD CONSTRAINT "no_class_days_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
