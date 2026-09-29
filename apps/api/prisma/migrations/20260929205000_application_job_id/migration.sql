-- AlterTable
ALTER TABLE "Application" ADD COLUMN "jobId" TEXT;

-- CreateIndex
CREATE INDEX "Application_jobId_idx" ON "Application"("jobId");
