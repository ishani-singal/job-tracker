-- Replaces the upload-time Story extraction/confirmation pipeline with
-- live, per-generation extraction keyed directly off each file's/repo's
-- pinned entry. Existing StoryFile/ResumeFile/ConnectedRepo rows have no
-- durable entry association recoverable from the old pipeline (only
-- transient StoryParseRun hints, dropped here) — deleted so the tables can
-- require entryType/entryId going forward; underlying files on disk are
-- untouched, only these DB rows are removed. Re-upload/reconnect under the
-- new required picker.

-- DropForeignKey (StoryCandidate -> StoryParseRun)
ALTER TABLE "StoryCandidate" DROP CONSTRAINT IF EXISTS "StoryCandidate_parseRunId_fkey";

-- DropTable (old Story extraction pipeline)
DROP TABLE IF EXISTS "StoryCandidate";
DROP TABLE IF EXISTS "CandidateStory";
DROP TABLE IF EXISTS "StoryParseRun";

-- DropEnum (no longer referenced once the tables above are gone)
DROP TYPE IF EXISTS "StoryStatus";
DROP TYPE IF EXISTS "ParseRunStatus";

-- Remove STORY_EXTRACTION sessions and their messages before dropping the
-- columns/enum value that described them.
DELETE FROM "SessionMessage" WHERE "sessionId" IN (
  SELECT "id" FROM "GenerationSession" WHERE "scope" = 'STORY_EXTRACTION'
);
DELETE FROM "GenerationSession" WHERE "scope" = 'STORY_EXTRACTION';

-- AlterTable (drop the STORY_EXTRACTION-only columns from GenerationSession)
ALTER TABLE "GenerationSession" DROP COLUMN IF EXISTS "storyParseRunId";
ALTER TABLE "GenerationSession" DROP COLUMN IF EXISTS "sourceLabel";
ALTER TABLE "GenerationSession" DROP COLUMN IF EXISTS "sourceType";
ALTER TABLE "GenerationSession" DROP COLUMN IF EXISTS "storyFileId";
ALTER TABLE "GenerationSession" DROP COLUMN IF EXISTS "resumeFileId";
ALTER TABLE "GenerationSession" DROP COLUMN IF EXISTS "repoFullName";
DROP INDEX IF EXISTS "GenerationSession_storyParseRunId_idx";

-- Postgres has no DROP VALUE for enums — recreate GenerationSessionScope
-- without STORY_EXTRACTION now that nothing references it. The column's
-- default (an enum literal) has to be dropped before the type swap —
-- Postgres can't auto-cast a DEFAULT expression the way it can casts of
-- existing row data via USING — and re-added afterward against the new type.
ALTER TABLE "GenerationSession" ALTER COLUMN "scope" DROP DEFAULT;
ALTER TYPE "GenerationSessionScope" RENAME TO "GenerationSessionScope_old";
CREATE TYPE "GenerationSessionScope" AS ENUM ('APPLICATION', 'LINKEDIN', 'COMPANY');
ALTER TABLE "GenerationSession"
  ALTER COLUMN "scope" TYPE "GenerationSessionScope"
  USING ("scope"::text::"GenerationSessionScope");
ALTER TABLE "GenerationSession" ALTER COLUMN "scope" SET DEFAULT 'APPLICATION'::"GenerationSessionScope";
DROP TYPE "GenerationSessionScope_old";

-- Existing uploads/connections have no recoverable entry association —
-- delete so entryType/entryId can be required going forward (see header).
DELETE FROM "StoryFile";
DELETE FROM "ResumeFile";
DELETE FROM "ConnectedRepo";

-- AlterTable (pin every Stories/Resume file and connected repo to exactly
-- one entry, required from here on)
ALTER TABLE "StoryFile" ADD COLUMN "entryType" "StoryEntryType" NOT NULL;
ALTER TABLE "StoryFile" ADD COLUMN "entryId" TEXT NOT NULL;
CREATE INDEX "StoryFile_entryType_entryId_idx" ON "StoryFile"("entryType", "entryId");

ALTER TABLE "ResumeFile" ADD COLUMN "entryType" "StoryEntryType" NOT NULL;
ALTER TABLE "ResumeFile" ADD COLUMN "entryId" TEXT NOT NULL;
CREATE INDEX "ResumeFile_entryType_entryId_idx" ON "ResumeFile"("entryType", "entryId");

ALTER TABLE "ConnectedRepo" ADD COLUMN "entryType" "StoryEntryType" NOT NULL;
ALTER TABLE "ConnectedRepo" ADD COLUMN "entryId" TEXT NOT NULL;
CREATE INDEX "ConnectedRepo_entryType_entryId_idx" ON "ConnectedRepo"("entryType", "entryId");

-- CreateTable (per-source extraction cache, populated lazily at generation time)
CREATE TABLE "ExtractedNarrative" (
    "id" TEXT NOT NULL,
    "sourceType" "StorySourceType" NOT NULL,
    "storyFileId" TEXT,
    "resumeFileId" TEXT,
    "repoFullName" TEXT,
    "entryType" "StoryEntryType" NOT NULL,
    "entryId" TEXT NOT NULL,
    "narrativeText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractedNarrative_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExtractedNarrative_storyFileId_key" ON "ExtractedNarrative"("storyFileId");
CREATE UNIQUE INDEX "ExtractedNarrative_resumeFileId_key" ON "ExtractedNarrative"("resumeFileId");
CREATE UNIQUE INDEX "ExtractedNarrative_repoFullName_key" ON "ExtractedNarrative"("repoFullName");
CREATE INDEX "ExtractedNarrative_entryType_entryId_idx" ON "ExtractedNarrative"("entryType", "entryId");
