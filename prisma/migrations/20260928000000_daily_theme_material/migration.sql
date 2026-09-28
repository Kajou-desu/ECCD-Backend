ALTER TABLE "daily_themes" ADD COLUMN "materialId" INTEGER;

CREATE INDEX "daily_themes_materialId_idx" ON "daily_themes"("materialId");

ALTER TABLE "daily_themes" ADD CONSTRAINT "daily_themes_materialId_fkey"
FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;