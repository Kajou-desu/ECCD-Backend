-- Materials and event-photo albums become per center: a center's Teachers and
-- families see only their own center's, instead of every center sharing one pool.
-- (An album's photos belong to the album, so they follow it.)

-- AlterTable
ALTER TABLE "materials" ADD COLUMN "centerId" INTEGER;
ALTER TABLE "albums" ADD COLUMN "centerId" INTEGER;

-- Data: a material belongs to the center of the account that added it, read from
-- the activity log (the earliest "material.create" entry whose account has a
-- center). Materials added before the log existed, or by an Admin (who has no
-- center of their own), are handled below.
UPDATE "materials" m
SET "centerId" = c."centerId"
FROM (
  SELECT DISTINCT ON (l."targetId") l."targetId" AS "materialId", u."centerId"
  FROM "activity_logs" l
  JOIN "users" u ON u."id" = l."actorId"
  WHERE l."action" = 'material.create'
    AND l."targetType" = 'material'
    AND l."targetId" IS NOT NULL
    AND u."centerId" IS NOT NULL
  ORDER BY l."targetId", l."createdAt", l."id"
) c
WHERE m."id" = c."materialId";

-- Data: an album connected to an activity follows that activity's center.
UPDATE "albums" a
SET "centerId" = m."centerId"
FROM "materials" m
WHERE a."materialId" = m."id" AND m."centerId" IS NOT NULL;

-- Data: when the system has exactly one center, everything that is still
-- unassigned can only belong to it. (MIN never fails, and the WHERE keeps this a
-- no-op whenever there are several centers.)
UPDATE "materials"
SET "centerId" = (SELECT MIN("id") FROM "centers")
WHERE "centerId" IS NULL AND (SELECT COUNT(*) FROM "centers") = 1;

UPDATE "albums"
SET "centerId" = (SELECT MIN("id") FROM "centers")
WHERE "centerId" IS NULL AND (SELECT COUNT(*) FROM "centers") = 1;

-- With several centers, a row that still has no center could not be matched to one.
-- It stays NULL and is visible to Admins only (nobody else is allowed to see a row
-- with no center). To hand such rows to a center:
--   UPDATE "materials" SET "centerId" = <center id> WHERE "id" IN (...);
--   UPDATE "albums"    SET "centerId" = <center id> WHERE "id" IN (...);

CREATE INDEX "materials_centerId_idx" ON "materials"("centerId");
CREATE INDEX "albums_centerId_idx" ON "albums"("centerId");

-- Restrict: a center that still has materials or albums cannot be deleted.
ALTER TABLE "materials" ADD CONSTRAINT "materials_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "centers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "albums" ADD CONSTRAINT "albums_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "centers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
