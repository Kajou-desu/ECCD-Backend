-- A teacher can manually Start or Stop automatic pickup (Live attendance page).
-- One small row per center per school day records the choice, so a Stop survives
-- a server restart.

-- CreateEnum
CREATE TYPE "PickupWatchMode" AS ENUM ('on', 'off');

-- CreateTable
CREATE TABLE "pickup_watch_overrides" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "centerId" INTEGER,
    "mode" "PickupWatchMode" NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pickup_watch_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pickup_watch_overrides_date_idx" ON "pickup_watch_overrides"("date");

-- AddForeignKey
-- Cascade: unlike sessions, an override is a day-long setting, not history.
ALTER TABLE "pickup_watch_overrides" ADD CONSTRAINT "pickup_watch_overrides_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "centers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most ONE override per center per day, enforced by the database so two
-- simultaneous presses can't both insert. COALESCE gives the "no center yet"
-- Teachers one shared slot (a plain unique index would treat every NULL as
-- distinct); center ids start at 1, so 0 can never clash with a real center.
-- Hand-written because Prisma's schema language cannot express expression
-- indexes; Prisma ignores indexes it doesn't model.
CREATE UNIQUE INDEX "pickup_watch_overrides_one_per_center_day" ON "pickup_watch_overrides" ("date", (COALESCE("centerId", 0)));
