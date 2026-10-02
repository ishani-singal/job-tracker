-- Convert existing margin values from points to inches (72pt = 1in) before
-- changing the column defaults, so any custom margins a user already saved
-- keep rendering at the same physical size instead of silently becoming
-- 72x too large once the renderer starts treating the stored number as
-- inches.
UPDATE "ResumeTemplate" SET
  "marginTopMin" = "marginTopMin" / 72.0,
  "marginTopMax" = "marginTopMax" / 72.0,
  "marginBottomMin" = "marginBottomMin" / 72.0,
  "marginBottomMax" = "marginBottomMax" / 72.0,
  "marginLeftMin" = "marginLeftMin" / 72.0,
  "marginLeftMax" = "marginLeftMax" / 72.0,
  "marginRightMin" = "marginRightMin" / 72.0,
  "marginRightMax" = "marginRightMax" / 72.0;

-- AlterTable: new rows from here on default to inches (0.5in / 0.75in,
-- equal to the old 36pt / 54pt defaults).
ALTER TABLE "ResumeTemplate"
  ALTER COLUMN "marginTopMin" SET DEFAULT 0.5,
  ALTER COLUMN "marginTopMax" SET DEFAULT 0.75,
  ALTER COLUMN "marginBottomMin" SET DEFAULT 0.5,
  ALTER COLUMN "marginBottomMax" SET DEFAULT 0.75,
  ALTER COLUMN "marginLeftMin" SET DEFAULT 0.5,
  ALTER COLUMN "marginLeftMax" SET DEFAULT 0.75,
  ALTER COLUMN "marginRightMin" SET DEFAULT 0.5,
  ALTER COLUMN "marginRightMax" SET DEFAULT 0.75;
