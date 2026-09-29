-- CreateEnum
CREATE TYPE "GenerationSessionStatus" AS ENUM ('RUNNING', 'WAITING_FOR_INPUT', 'DONE', 'ACCEPTED', 'ERROR');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'TOOL');

-- CreateTable
CREATE TABLE "GenerationSession" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "status" "GenerationSessionStatus" NOT NULL DEFAULT 'RUNNING',
    "errorMessage" TEXT,
    "messageHistoryJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GenerationSession_applicationId_idx" ON "GenerationSession"("applicationId");

-- CreateIndex
CREATE INDEX "GenerationSession_createdAt_idx" ON "GenerationSession"("createdAt");

-- CreateIndex
CREATE INDEX "SessionMessage_sessionId_idx" ON "SessionMessage"("sessionId");

-- AddForeignKey
ALTER TABLE "SessionMessage" ADD CONSTRAINT "SessionMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "GenerationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

