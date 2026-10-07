-- Absolute section-header font size, per-entry-header spacing, GitHub/portfolio links.
ALTER TABLE "ResumeTemplate"
  ADD COLUMN "sectionHeaderFontMin" DOUBLE PRECISION NOT NULL DEFAULT 9,
  ADD COLUMN "sectionHeaderFontMax" DOUBLE PRECISION NOT NULL DEFAULT 12,
  ADD COLUMN "spacingBeforeEntryHeaderMin" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  ADD COLUMN "spacingBeforeEntryHeaderMax" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
  ADD COLUMN "spacingAfterEntryHeaderMin" DOUBLE PRECISION NOT NULL DEFAULT 1,
  ADD COLUMN "spacingAfterEntryHeaderMax" DOUBLE PRECISION NOT NULL DEFAULT 2;

-- Keep existing templates rendering exactly as before: the old header size was
-- (bullet font, floored at 9) + the offset.
UPDATE "ResumeTemplate" SET
  "sectionHeaderFontMin" = GREATEST(9, "bulletFontMin") + "sectionHeaderFontOffsetMin",
  "sectionHeaderFontMax" = GREATEST(9, "bulletFontMax") + "sectionHeaderFontOffsetMax";

ALTER TABLE "ResumePromptTemplate"
  ADD COLUMN "githubUrl" TEXT,
  ADD COLUMN "portfolioUrl" TEXT;
