-- CreateEnum
CREATE TYPE "GenerationSessionScope" AS ENUM ('APPLICATION', 'LINKEDIN', 'COMPANY');

-- AlterTable: GenerationSession — existing rows get scope=APPLICATION (their
-- correct historical value, since scope didn't exist before), applicationId
-- widened to nullable (existing rows keep their value, just no longer
-- required going forward).
ALTER TABLE "GenerationSession" ADD COLUMN     "company" TEXT,
ADD COLUMN     "scope" "GenerationSessionScope" NOT NULL DEFAULT 'APPLICATION',
ALTER COLUMN "applicationId" DROP NOT NULL;

-- AlterTable: add updatedAt to the four entry tables with a backfill from
-- createdAt for existing rows (auto-diff would add NOT NULL with no default,
-- which fails outright against rows that already exist).
ALTER TABLE "WorkExperienceEntry" ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "WorkExperienceEntry" SET "updatedAt" = "createdAt";
ALTER TABLE "WorkExperienceEntry" ALTER COLUMN "updatedAt" SET NOT NULL;

ALTER TABLE "EducationEntry" ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "EducationEntry" SET "updatedAt" = "createdAt";
ALTER TABLE "EducationEntry" ALTER COLUMN "updatedAt" SET NOT NULL;

ALTER TABLE "InternshipEntry" ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "InternshipEntry" SET "updatedAt" = "createdAt";
ALTER TABLE "InternshipEntry" ALTER COLUMN "updatedAt" SET NOT NULL;

ALTER TABLE "ProjectEntry" ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "ProjectEntry" SET "updatedAt" = "createdAt";
ALTER TABLE "ProjectEntry" ALTER COLUMN "updatedAt" SET NOT NULL;

-- CreateTable
CREATE TABLE "LinkedinProfile" (
    "id" TEXT NOT NULL,
    "headline" TEXT,
    "about" TEXT,
    "entryBullets" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedinProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyResume" (
    "id" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "resumeContent" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyResume_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanyResume_company_key" ON "CompanyResume"("company");

-- CreateIndex
CREATE INDEX "GenerationSession_company_idx" ON "GenerationSession"("company");

-- CreateIndex
CREATE INDEX "GenerationSession_scope_idx" ON "GenerationSession"("scope");
