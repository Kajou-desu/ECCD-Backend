-- AlterTable: daily_themes is now editable (see dashboard.controller.js
-- upsertDailyTheme), so it needs an updatedAt like every other mutable
-- table. DEFAULT CURRENT_TIMESTAMP backfills existing rows.
ALTER TABLE "daily_themes" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable: weekly_goals — one row per (weekStart, session), mirroring
-- daily_themes' one-row-per-day pattern. See docs/WEEKLY_GOALS_PROPOSAL.md.
CREATE TABLE "weekly_goals" (
    "id" SERIAL NOT NULL,
    "weekStart" DATE NOT NULL,
    "session" "Session" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_goals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "weekly_goals_weekStart_session_idx" ON "weekly_goals"("weekStart", "session");

CREATE UNIQUE INDEX "weekly_goals_weekStart_session_title_key" ON "weekly_goals"("weekStart", "session", "title");

-- SetNull, not Cascade/Restrict: deleting a teacher account must neither
-- delete goal history nor be blocked by it (same reasoning as
-- attendance_sessions.startedById).
ALTER TABLE "weekly_goals" ADD CONSTRAINT "weekly_goals_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: student_goal_progress — per-student progress against a goal.
-- Absence of a row = 0%/"Not started", so a goal doesn't need a row per
-- student up front (see WEEKLY_GOALS_PROPOSAL.md).
CREATE TABLE "student_goal_progress" (
    "id" SERIAL NOT NULL,
    "goalId" INTEGER NOT NULL,
    "studentId" INTEGER NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Not started',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_goal_progress_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "student_goal_progress_goalId_studentId_key" ON "student_goal_progress"("goalId", "studentId");

ALTER TABLE "student_goal_progress" ADD CONSTRAINT "student_goal_progress_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "weekly_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "student_goal_progress" ADD CONSTRAINT "student_goal_progress_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
