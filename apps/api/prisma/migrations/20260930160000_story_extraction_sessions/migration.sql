-- AlterEnum
ALTER TYPE "GenerationSessionScope" ADD VALUE 'STORY_EXTRACTION';

-- AlterTable
ALTER TABLE "GenerationSession" ADD COLUMN "storyParseRunId" TEXT;
ALTER TABLE "GenerationSession" ADD COLUMN "sourceLabel" TEXT;
ALTER TABLE "GenerationSession" ADD COLUMN "sourceType" "StorySourceType";
ALTER TABLE "GenerationSession" ADD COLUMN "storyFileId" TEXT;
ALTER TABLE "GenerationSession" ADD COLUMN "resumeFileId" TEXT;
ALTER TABLE "GenerationSession" ADD COLUMN "repoFullName" TEXT;

-- CreateIndex
CREATE INDEX "GenerationSession_storyParseRunId_idx" ON "GenerationSession"("storyParseRunId");
