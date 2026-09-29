-- Preserve existing yearIn/yearOut/year values by mapping them into the new
-- startYear/endYear columns before dropping the old ones (auto-diff would
-- have silently dropped this data).

-- WorkExperienceEntry: yearIn -> startYear, yearOut -> endYear
ALTER TABLE "WorkExperienceEntry"
  ADD COLUMN "location" TEXT,
  ADD COLUMN "startMonth" INTEGER,
  ADD COLUMN "startYear" INTEGER,
  ADD COLUMN "endMonth" INTEGER,
  ADD COLUMN "endYear" INTEGER,
  ADD COLUMN "isPresent" BOOLEAN NOT NULL DEFAULT false;

UPDATE "WorkExperienceEntry" SET "startYear" = "yearIn", "endYear" = "yearOut";

ALTER TABLE "WorkExperienceEntry"
  DROP COLUMN "yearIn",
  DROP COLUMN "yearOut";

-- EducationEntry: year -> startYear, add field
ALTER TABLE "EducationEntry"
  ADD COLUMN "field" TEXT,
  ADD COLUMN "location" TEXT,
  ADD COLUMN "startMonth" INTEGER,
  ADD COLUMN "startYear" INTEGER,
  ADD COLUMN "endMonth" INTEGER,
  ADD COLUMN "endYear" INTEGER,
  ADD COLUMN "isPresent" BOOLEAN NOT NULL DEFAULT false;

UPDATE "EducationEntry" SET "startYear" = "year";

ALTER TABLE "EducationEntry" DROP COLUMN "year";

-- InternshipEntry: year -> startYear
ALTER TABLE "InternshipEntry"
  ADD COLUMN "location" TEXT,
  ADD COLUMN "startMonth" INTEGER,
  ADD COLUMN "startYear" INTEGER,
  ADD COLUMN "endMonth" INTEGER,
  ADD COLUMN "endYear" INTEGER,
  ADD COLUMN "isPresent" BOOLEAN NOT NULL DEFAULT false;

UPDATE "InternshipEntry" SET "startYear" = "year";

ALTER TABLE "InternshipEntry" DROP COLUMN "year";

-- ProjectEntry: year -> startYear
ALTER TABLE "ProjectEntry"
  ADD COLUMN "location" TEXT,
  ADD COLUMN "startMonth" INTEGER,
  ADD COLUMN "startYear" INTEGER,
  ADD COLUMN "endMonth" INTEGER,
  ADD COLUMN "endYear" INTEGER,
  ADD COLUMN "isPresent" BOOLEAN NOT NULL DEFAULT false;

UPDATE "ProjectEntry" SET "startYear" = "year";

ALTER TABLE "ProjectEntry" DROP COLUMN "year";
