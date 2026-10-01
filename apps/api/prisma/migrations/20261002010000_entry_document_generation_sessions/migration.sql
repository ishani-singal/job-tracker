-- Adds ENTRY_DOCUMENT as a GenerationSession scope, so per-entry document
-- generation becomes a chat-style session (agent can ask a clarifying
-- question, user replies, user explicitly accepts the result) instead of a
-- one-shot stateless call. See sessions.service.ts's runEntryDocumentTurn
-- and entry-document-editor.tsx's Generate button.

-- AlterEnum
ALTER TYPE "GenerationSessionScope" ADD VALUE 'ENTRY_DOCUMENT';

-- AlterTable
ALTER TABLE "GenerationSession" ADD COLUMN "entryType" "StoryEntryType";
ALTER TABLE "GenerationSession" ADD COLUMN "entryId" TEXT;

-- CreateIndex
CREATE INDEX "GenerationSession_entryType_entryId_idx" ON "GenerationSession"("entryType", "entryId");
