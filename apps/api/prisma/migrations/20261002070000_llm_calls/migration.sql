-- AlterTable
ALTER TABLE "AppSettings"
  ADD COLUMN "llmDailyBudgetUsd" DOUBLE PRECISION NOT NULL DEFAULT 5;

-- CreateTable
CREATE TABLE "LlmCall" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agent" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "cachedTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "inputCostUsd" DOUBLE PRECISION NOT NULL,
    "outputCostUsd" DOUBLE PRECISION NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "LlmCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LlmCall_createdAt_idx" ON "LlmCall"("createdAt");

-- CreateTable
CREATE TABLE "LlmModelPrice" (
    "model" TEXT NOT NULL,
    "inputPer1M" DOUBLE PRECISION NOT NULL,
    "cachedInputPer1M" DOUBLE PRECISION NOT NULL,
    "outputPer1M" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "LlmModelPrice_pkey" PRIMARY KEY ("model")
);

INSERT INTO "LlmModelPrice" ("model", "inputPer1M", "cachedInputPer1M", "outputPer1M")
VALUES ('gpt-4.1', 2.00, 0.50, 8.00);
