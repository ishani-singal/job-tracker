-- CreateTable
CREATE TABLE "LinkedinImport" (
    "id" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkedinImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkedinConnection" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "url" TEXT,
    "emailAddress" TEXT,
    "company" TEXT,
    "position" TEXT,
    "connectedOn" TIMESTAMP(3),

    CONSTRAINT "LinkedinConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkedinMessageThread" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "fromName" TEXT,
    "toName" TEXT,
    "content" TEXT,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "LinkedinMessageThread_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LinkedinConnection_importId_idx" ON "LinkedinConnection"("importId");

-- CreateIndex
CREATE INDEX "LinkedinMessageThread_importId_idx" ON "LinkedinMessageThread"("importId");

-- CreateIndex
CREATE INDEX "LinkedinMessageThread_conversationId_idx" ON "LinkedinMessageThread"("conversationId");

-- AddForeignKey
ALTER TABLE "LinkedinConnection" ADD CONSTRAINT "LinkedinConnection_importId_fkey" FOREIGN KEY ("importId") REFERENCES "LinkedinImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkedinMessageThread" ADD CONSTRAINT "LinkedinMessageThread_importId_fkey" FOREIGN KEY ("importId") REFERENCES "LinkedinImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

