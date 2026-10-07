ALTER TABLE "ReferralRequest" ADD COLUMN "sessionId" TEXT;
CREATE INDEX "ReferralRequest_sessionId_idx" ON "ReferralRequest"("sessionId");
