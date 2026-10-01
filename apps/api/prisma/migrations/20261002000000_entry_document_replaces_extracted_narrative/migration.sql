-- Replaces the per-source, invisible ExtractedNarrative cache with one
-- user-visible, user-editable EntryDocument per entry. See
-- entries-section.tsx (Generate Detailed Document button) and
-- agent/resu/stories/ (revise-or-generate endpoint) for the new
-- generation-time flow this supports.

-- CreateTable
CREATE TABLE "EntryDocument" (
    "id" TEXT NOT NULL,
    "entryType" "StoryEntryType" NOT NULL,
    "entryId" TEXT NOT NULL,
    "contentHtml" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntryDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EntryDocument_entryType_entryId_key" ON "EntryDocument"("entryType", "entryId");

-- DropTable (old per-source narrative cache — fully replaced, see header)
DROP TABLE IF EXISTS "ExtractedNarrative";

-- DropEnum (StorySourceType was ExtractedNarrative-only)
DROP TYPE IF EXISTS "StorySourceType";
