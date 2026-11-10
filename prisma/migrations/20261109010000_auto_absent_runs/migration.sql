-- Automatic absences at the end of a session: one row per day, session and
-- center, written in the same transaction as the absences themselves.
CREATE TABLE "auto_absent_runs" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "session" "Session" NOT NULL,
    "centerKey" INTEGER NOT NULL,
    "absentCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auto_absent_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auto_absent_runs_date_session_centerKey_key" ON "auto_absent_runs"("date", "session", "centerKey");
