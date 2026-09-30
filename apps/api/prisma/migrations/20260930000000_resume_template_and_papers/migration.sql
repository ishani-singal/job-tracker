-- Application.resumeContent: markdown text -> structured JSON (StructuredResume).
-- Only 1 existing row has content as of this migration and it's fine to lose per
-- explicit product decision (personal tool, one-click to regenerate) — drop and
-- recreate as jsonb rather than attempting a text->json cast that would fail
-- anyway since the old content isn't valid JSON.
ALTER TABLE "Application" DROP COLUMN "resumeContent";
ALTER TABLE "Application" ADD COLUMN "resumeContent" JSONB;

-- CompanyResume.resumeContent: same rationale.
ALTER TABLE "CompanyResume" DROP COLUMN "resumeContent";
ALTER TABLE "CompanyResume" ADD COLUMN "resumeContent" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "CompanyResume" ALTER COLUMN "resumeContent" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ProjectEntry" ADD COLUMN "demoUrl" TEXT;

-- CreateTable
CREATE TABLE "PaperEntry" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "venue" TEXT,
    "authors" TEXT,
    "url" TEXT,
    "publishedMonth" INTEGER,
    "publishedYear" INTEGER,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaperEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResumeTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'default',
    "marginTopMin" DOUBLE PRECISION NOT NULL DEFAULT 36,
    "marginTopMax" DOUBLE PRECISION NOT NULL DEFAULT 54,
    "marginBottomMin" DOUBLE PRECISION NOT NULL DEFAULT 36,
    "marginBottomMax" DOUBLE PRECISION NOT NULL DEFAULT 54,
    "marginLeftMin" DOUBLE PRECISION NOT NULL DEFAULT 36,
    "marginLeftMax" DOUBLE PRECISION NOT NULL DEFAULT 54,
    "marginRightMin" DOUBLE PRECISION NOT NULL DEFAULT 36,
    "marginRightMax" DOUBLE PRECISION NOT NULL DEFAULT 54,
    "bulletFontMin" DOUBLE PRECISION NOT NULL DEFAULT 9,
    "bulletFontMax" DOUBLE PRECISION NOT NULL DEFAULT 11,
    "nameFontOffsetMin" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "nameFontOffsetMax" DOUBLE PRECISION NOT NULL DEFAULT 4,
    "sectionHeaderFontOffsetMin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sectionHeaderFontOffsetMax" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "horizontalTabStop" DOUBLE PRECISION NOT NULL DEFAULT 36,
    "spacingBeforeSectionMin" DOUBLE PRECISION NOT NULL DEFAULT 6,
    "spacingBeforeSectionMax" DOUBLE PRECISION NOT NULL DEFAULT 14,
    "spacingAfterSectionMin" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "spacingAfterSectionMax" DOUBLE PRECISION NOT NULL DEFAULT 6,
    "spacingBetweenBulletsMin" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "spacingBetweenBulletsMax" DOUBLE PRECISION NOT NULL DEFAULT 4,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResumeTemplate_pkey" PRIMARY KEY ("id")
);
