-- Adds a filter to hide Open Roles whose location/experience mismatch or a
-- disqualifier keyword invalidates them (shown as "Conditions not valid").
ALTER TABLE "AppSettings" ADD COLUMN "hideInvalidConditionRolesFilterOn" BOOLEAN NOT NULL DEFAULT false;
