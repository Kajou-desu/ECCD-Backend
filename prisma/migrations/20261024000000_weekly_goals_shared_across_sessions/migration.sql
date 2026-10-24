-- Weekly goals are no longer split by session: one goal per (weekStart, title),
-- shared by the morning and the afternoon class. Per-student progress is
-- unchanged (student_goal_progress still has one row per goal + student).
--
-- Existing data: a goal that was added to both sessions exists as two rows with
-- the same (weekStart, title). They are merged into the row with the lowest id
-- (its description/category win), and every student's progress is kept.

-- 1. When a student has a progress row on more than one duplicate of the same
--    goal (only possible if they changed session mid-week), keep the most
--    recently updated one, so step 2 cannot violate the unique (goalId, studentId).
DELETE FROM "student_goal_progress" AS p
USING (
    SELECT sp."id",
           ROW_NUMBER() OVER (
               PARTITION BY k."keepId", sp."studentId"
               ORDER BY sp."updatedAt" DESC, sp."id" DESC
           ) AS rn
    FROM "student_goal_progress" sp
    JOIN "weekly_goals" g ON g."id" = sp."goalId"
    JOIN (
        SELECT MIN("id") AS "keepId", "weekStart", "title"
        FROM "weekly_goals"
        GROUP BY "weekStart", "title"
    ) k ON k."weekStart" = g."weekStart" AND k."title" = g."title"
) AS ranked
WHERE p."id" = ranked."id" AND ranked.rn > 1;

-- 2. Point the remaining progress rows at the surviving goal.
UPDATE "student_goal_progress" AS p
SET "goalId" = k."keepId"
FROM "weekly_goals" g,
     (
         SELECT MIN("id") AS "keepId", "weekStart", "title"
         FROM "weekly_goals"
         GROUP BY "weekStart", "title"
     ) k
WHERE g."id" = p."goalId"
  AND k."weekStart" = g."weekStart"
  AND k."title" = g."title"
  AND p."goalId" <> k."keepId";

-- 3. Remove the now-empty duplicate goals.
DELETE FROM "weekly_goals"
WHERE "id" NOT IN (
    SELECT MIN("id") FROM "weekly_goals" GROUP BY "weekStart", "title"
);

-- 4. Drop the session column and rebuild the indexes without it.
DROP INDEX "weekly_goals_weekStart_session_title_key";
DROP INDEX "weekly_goals_weekStart_session_idx";

ALTER TABLE "weekly_goals" DROP COLUMN "session";

CREATE UNIQUE INDEX "weekly_goals_weekStart_title_key" ON "weekly_goals"("weekStart", "title");
CREATE INDEX "weekly_goals_weekStart_idx" ON "weekly_goals"("weekStart");
