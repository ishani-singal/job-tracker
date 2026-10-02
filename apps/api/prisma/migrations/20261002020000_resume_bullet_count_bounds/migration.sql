-- AlterTable
ALTER TABLE "ResumePromptTemplate"
  ADD COLUMN "minBulletsWork" INTEGER,
  ADD COLUMN "maxBulletsWork" INTEGER,
  ADD COLUMN "minBulletsInternship" INTEGER,
  ADD COLUMN "maxBulletsInternship" INTEGER,
  ADD COLUMN "minBulletsProject" INTEGER,
  ADD COLUMN "maxBulletsProject" INTEGER;
