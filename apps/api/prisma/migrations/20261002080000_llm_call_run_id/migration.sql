-- AlterTable
ALTER TABLE "LlmCall"
  ADD COLUMN "runId" TEXT;

-- CreateIndex
CREATE INDEX "LlmCall_runId_idx" ON "LlmCall"("runId");
