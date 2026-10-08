-- Who referred the user for an application, and the resume actually submitted.
ALTER TABLE "Application" ADD COLUMN "referredByContactId" TEXT;

CREATE INDEX "Application_referredByContactId_idx" ON "Application"("referredByContactId");

ALTER TABLE "Application" ADD CONSTRAINT "Application_referredByContactId_fkey"
  FOREIGN KEY ("referredByContactId") REFERENCES "CompanyContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ApplicationAppliedResume" (
  "applicationId" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "data" BYTEA NOT NULL,
  "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApplicationAppliedResume_pkey" PRIMARY KEY ("applicationId")
);

ALTER TABLE "ApplicationAppliedResume" ADD CONSTRAINT "ApplicationAppliedResume_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
