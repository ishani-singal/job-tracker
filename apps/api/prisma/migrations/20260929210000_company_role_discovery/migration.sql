-- CreateEnum
CREATE TYPE "CompanyDiscoveryStatus" AS ENUM ('PENDING', 'DISCOVERING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "TrackedCompany" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "careerPageUrl" TEXT,
    "discoveryStatus" "CompanyDiscoveryStatus" NOT NULL DEFAULT 'PENDING',
    "discoveryError" TEXT,
    "lastDiscoveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackedCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveredRole" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "roleUrl" TEXT NOT NULL,
    "jobId" TEXT,
    "postedDate" TIMESTAMP(3),
    "jdText" TEXT,
    "atsScore" INTEGER,
    "atsScoreComputedAt" TIMESTAMP(3),
    "applicationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveredRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrackedCompany_name_key" ON "TrackedCompany"("name");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredRole_applicationId_key" ON "DiscoveredRole"("applicationId");

-- CreateIndex
CREATE INDEX "DiscoveredRole_companyId_idx" ON "DiscoveredRole"("companyId");

-- CreateIndex
CREATE INDEX "DiscoveredRole_applicationId_idx" ON "DiscoveredRole"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredRole_companyId_roleUrl_key" ON "DiscoveredRole"("companyId", "roleUrl");

-- AddForeignKey
ALTER TABLE "DiscoveredRole" ADD CONSTRAINT "DiscoveredRole_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "TrackedCompany"("id") ON DELETE CASCADE ON UPDATE CASCADE;
