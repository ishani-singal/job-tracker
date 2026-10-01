-- CreateEnum
CREATE TYPE "StoryEntryType" AS ENUM ('WORK_EXPERIENCE', 'EDUCATION', 'INTERNSHIP', 'PROJECT', 'PAPER');

-- CreateEnum
CREATE TYPE "StorySourceType" AS ENUM ('STORY_FILE', 'RESUME_FILE', 'GITHUB_REPO');

-- CreateEnum
CREATE TYPE "StoryStatus" AS ENUM ('PROPOSED', 'CONFIRMED', 'REJECTED', 'PROPOSED_UPDATE');

-- CreateEnum
CREATE TYPE "ParseRunStatus" AS ENUM ('PENDING', 'PARSING', 'AWAITING_REVIEW', 'DONE', 'ERROR');

-- CreateTable
CREATE TABLE "StoryParseRun" (
    "id" TEXT NOT NULL,
    "status" "ParseRunStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "triggerSourceType" "StorySourceType",
    "triggerStoryFileId" TEXT,
    "triggerResumeFileId" TEXT,
    "triggerRepoFullName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoryParseRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoryCandidate" (
    "id" TEXT NOT NULL,
    "parseRunId" TEXT NOT NULL,
    "sourceType" "StorySourceType" NOT NULL,
    "storyFileId" TEXT,
    "resumeFileId" TEXT,
    "repoFullName" TEXT,
    "entryType" "StoryEntryType",
    "entryId" TEXT,
    "newEntryLabel" TEXT,
    "newEntryDates" JSONB,
    "sourceSpanText" TEXT NOT NULL,
    "proposedStoryText" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "status" "StoryStatus" NOT NULL DEFAULT 'PROPOSED',
    "resultingStoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoryCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateStory" (
    "id" TEXT NOT NULL,
    "entryType" "StoryEntryType" NOT NULL,
    "entryId" TEXT NOT NULL,
    "storyText" TEXT NOT NULL,
    "userEdited" BOOLEAN NOT NULL DEFAULT false,
    "status" "StoryStatus" NOT NULL DEFAULT 'CONFIRMED',
    "sourceCandidateId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateStory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoryParseRun_status_idx" ON "StoryParseRun"("status");

-- CreateIndex
CREATE INDEX "StoryParseRun_createdAt_idx" ON "StoryParseRun"("createdAt");

-- CreateIndex
CREATE INDEX "StoryCandidate_parseRunId_idx" ON "StoryCandidate"("parseRunId");

-- CreateIndex
CREATE INDEX "StoryCandidate_entryType_entryId_idx" ON "StoryCandidate"("entryType", "entryId");

-- CreateIndex
CREATE INDEX "StoryCandidate_status_idx" ON "StoryCandidate"("status");

-- CreateIndex
CREATE INDEX "CandidateStory_entryType_entryId_idx" ON "CandidateStory"("entryType", "entryId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateStory_entryType_entryId_key" ON "CandidateStory"("entryType", "entryId");

-- CreateIndex
CREATE INDEX "CandidateStory_status_idx" ON "CandidateStory"("status");

-- AddForeignKey
ALTER TABLE "StoryCandidate" ADD CONSTRAINT "StoryCandidate_parseRunId_fkey" FOREIGN KEY ("parseRunId") REFERENCES "StoryParseRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
