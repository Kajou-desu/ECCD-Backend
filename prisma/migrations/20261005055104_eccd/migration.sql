-- DropIndex
DROP INDEX "albums_eventId_idx";

-- DropIndex
DROP INDEX "albums_materialId_idx";

-- DropIndex
DROP INDEX "daily_themes_materialId_idx";

-- AlterTable
ALTER TABLE "daily_themes" ALTER COLUMN "updatedAt" DROP DEFAULT;
