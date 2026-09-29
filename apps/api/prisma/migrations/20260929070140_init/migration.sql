-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('NOT_APPLIED', 'APPLIED');

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "jobUrl" TEXT,
    "jdText" TEXT,
    "postedDate" TIMESTAMP(3),
    "applyByDate" TIMESTAMP(3),
    "salaryRange" TEXT,
    "experienceLevel" TEXT,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'NOT_APPLIED',
    "appliedDate" TIMESTAMP(3),
    "lastMessageReceivedDate" TIMESTAMP(3),
    "rejectedDate" TIMESTAMP(3),
    "resumeContent" TEXT,
    "resumeGeneratedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoryFile" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storedPath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoryFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResumeFile" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storedPath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResumeFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResumePromptTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'default',
    "templateBody" TEXT NOT NULL,
    "targetRoleArchetype" TEXT,
    "disqualifierKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "locationZip" TEXT,
    "maxYearsExperience" INTEGER,
    "requiredExperienceEntries" JSONB NOT NULL DEFAULT '[]',
    "requiredProjectEntries" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResumePromptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL,
    "inactivityThresholdDays" INTEGER NOT NULL DEFAULT 14,
    "deadlineThresholdDays" INTEGER NOT NULL DEFAULT 30,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Application_company_idx" ON "Application"("company");

-- CreateIndex
CREATE INDEX "Application_status_idx" ON "Application"("status");
