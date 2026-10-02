-- AlterTable: drop the global per-entry-type bullet bounds...
ALTER TABLE "ResumePromptTemplate"
  DROP COLUMN "minBulletsWork",
  DROP COLUMN "maxBulletsWork",
  DROP COLUMN "minBulletsInternship",
  DROP COLUMN "maxBulletsInternship",
  DROP COLUMN "minBulletsProject",
  DROP COLUMN "maxBulletsProject";

-- ...and add them per-entry instead, so each role/internship/project can
-- set its own bullet count bounds rather than sharing one bound per type.
ALTER TABLE "WorkExperienceEntry"
  ADD COLUMN "minBullets" INTEGER,
  ADD COLUMN "maxBullets" INTEGER;

ALTER TABLE "InternshipEntry"
  ADD COLUMN "minBullets" INTEGER,
  ADD COLUMN "maxBullets" INTEGER;

ALTER TABLE "ProjectEntry"
  ADD COLUMN "minBullets" INTEGER,
  ADD COLUMN "maxBullets" INTEGER;
