-- Adds an editable day-count cutoff for the "hide roles posted before today" filter.
ALTER TABLE "AppSettings" ADD COLUMN "postedWithinDaysFilter" INTEGER NOT NULL DEFAULT 0;
