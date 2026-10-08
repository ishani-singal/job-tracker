-- Hand-entered interview progress on an application.
ALTER TABLE "Application" ADD COLUMN "interviewRounds" INTEGER;
ALTER TABLE "Application" ADD COLUMN "interviewStatus" TEXT;
