ALTER TABLE "albums" DROP COLUMN "category";
ALTER TABLE "albums" ADD COLUMN "eventId" INTEGER;
ALTER TABLE "albums" ADD COLUMN "materialId" INTEGER;

CREATE INDEX "albums_eventId_idx" ON "albums"("eventId");
CREATE INDEX "albums_materialId_idx" ON "albums"("materialId");

ALTER TABLE "albums"
ADD CONSTRAINT "albums_eventId_fkey"
FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "albums"
ADD CONSTRAINT "albums_materialId_fkey"
FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;