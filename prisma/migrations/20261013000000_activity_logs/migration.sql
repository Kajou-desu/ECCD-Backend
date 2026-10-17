-- CreateTable: activity_logs — who did what (Admin audit trail). Append-only.
CREATE TABLE "activity_logs" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" INTEGER,
    "actorEmail" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" INTEGER,
    "summary" TEXT NOT NULL,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "activity_logs_createdAt_idx" ON "activity_logs"("createdAt");
CREATE INDEX "activity_logs_actorId_createdAt_idx" ON "activity_logs"("actorId", "createdAt");
CREATE INDEX "activity_logs_action_createdAt_idx" ON "activity_logs"("action", "createdAt");

-- Deleting an account keeps its log entries (the email/role snapshot stays).
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
