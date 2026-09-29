-- AlterTable
ALTER TABLE "ResumePromptTemplate" DROP COLUMN "requiredExperienceEntries",
DROP COLUMN "requiredProjectEntries",
ADD COLUMN     "matchScoreTarget" INTEGER NOT NULL DEFAULT 93;

-- CreateTable
CREATE TABLE "WorkExperienceEntry" (
    "id" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "title" TEXT,
    "yearIn" INTEGER,
    "yearOut" INTEGER,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkExperienceEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EducationEntry" (
    "id" TEXT NOT NULL,
    "school" TEXT NOT NULL,
    "degree" TEXT,
    "year" INTEGER,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EducationEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InternshipEntry" (
    "id" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "year" INTEGER,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InternshipEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectEntry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repoUrl" TEXT,
    "liveUrl" TEXT,
    "year" INTEGER,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectEntry_pkey" PRIMARY KEY ("id")
);

