-- Results saved before ReferralRequest.sessionId existed: link each to the chat
-- that produced it (the same contact's most recent referral session started at or
-- before the result), so a final draft can find the roles that result kept.
UPDATE "ReferralRequest" r SET "sessionId" = (
  SELECT s.id FROM "GenerationSession" s
  WHERE s.scope = 'REFERRAL' AND s."contactId" = r."contactId" AND s."createdAt" <= r."createdAt"
  ORDER BY s."createdAt" DESC LIMIT 1
)
WHERE r."sessionId" IS NULL;
