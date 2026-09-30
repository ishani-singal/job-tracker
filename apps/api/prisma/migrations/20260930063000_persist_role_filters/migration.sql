-- Persist the Open Roles page's filter preferences so they survive a reload.
ALTER TABLE "AppSettings" ADD COLUMN "minMatchScoreFilter" INTEGER;
ALTER TABLE "AppSettings" ADD COLUMN "postedBeforeTodayFilterOn" BOOLEAN NOT NULL DEFAULT false;
