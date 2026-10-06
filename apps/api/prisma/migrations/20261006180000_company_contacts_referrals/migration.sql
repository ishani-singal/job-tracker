-- Scan confidence on tracked companies
ALTER TABLE "TrackedCompany"
  ADD COLUMN "lastScanConfidence" TEXT,
  ADD COLUMN "lastScanConfidenceNote" TEXT;

-- REFERRAL generation-session scope + its inputs
ALTER TYPE "GenerationSessionScope" ADD VALUE 'REFERRAL';
ALTER TABLE "GenerationSession"
  ADD COLUMN "contactId" TEXT,
  ADD COLUMN "referralTone" TEXT,
  ADD COLUMN "referralRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Contacts at tracked companies
CREATE TABLE "CompanyContact" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "linkedinUrl" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyContact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CompanyContact_companyId_idx" ON "CompanyContact"("companyId");

ALTER TABLE "CompanyContact"
  ADD CONSTRAINT "CompanyContact_companyId_fkey" FOREIGN KEY ("companyId")
  REFERENCES "TrackedCompany"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Generated referral asks
CREATE TABLE "ReferralRequest" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "tone" TEXT NOT NULL,
    "roles" JSONB NOT NULL,
    "message" TEXT NOT NULL,
    "resumeContent" JSONB NOT NULL,
    "scores" JSONB NOT NULL,
    "targetMet" BOOLEAN NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReferralRequest_contactId_idx" ON "ReferralRequest"("contactId");

ALTER TABLE "ReferralRequest"
  ADD CONSTRAINT "ReferralRequest_contactId_fkey" FOREIGN KEY ("contactId")
  REFERENCES "CompanyContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
