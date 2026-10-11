-- CreateTable: the ECCD centers. Replaces the free-text users."centerLocation",
-- which could not be matched reliably ("ECCD Angeles" vs "Angeles ECCD ").
CREATE TABLE "centers" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "centers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "centers_name_key" ON "centers"("name");

-- AlterTable
ALTER TABLE "users" ADD COLUMN "centerId" INTEGER;

CREATE INDEX "users_centerId_idx" ON "users"("centerId");

-- Restrict: a center that still has accounts cannot be deleted.
ALTER TABLE "users" ADD CONSTRAINT "users_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "centers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Data: one center per distinct existing name (trimmed, case-insensitive; the
-- first spelling found wins), then point each Teacher at theirs.
INSERT INTO "centers" ("name")
SELECT DISTINCT ON (lower(btrim("centerLocation"))) btrim("centerLocation")
FROM "users"
WHERE "centerLocation" IS NOT NULL AND btrim("centerLocation") <> ''
ORDER BY lower(btrim("centerLocation")), "id";

UPDATE "users" u
SET "centerId" = c."id"
FROM "centers" c
WHERE u."role" = 'Teacher'
  AND u."centerLocation" IS NOT NULL
  AND lower(btrim(u."centerLocation")) = lower(c."name");

-- Data: a Parent/Guardian belongs to the center of the Teachers of the students
-- they are connected to (the most common one if several). Accounts with no
-- such link stay without a center until an Admin assigns one.
UPDATE "users" u
SET "centerId" = (
  SELECT t."centerId"
  FROM "parent_children" pc
  JOIN "students" s ON s."id" = pc."studentId"
  JOIN "users" t ON t."id" = s."teacherId"
  WHERE pc."parentId" = u."id" AND t."centerId" IS NOT NULL
  GROUP BY t."centerId"
  ORDER BY count(*) DESC, t."centerId"
  LIMIT 1
)
WHERE u."role" IN ('Parent', 'Guardian');
