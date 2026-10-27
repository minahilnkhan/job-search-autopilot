-- Mentor prompt v2: applications run 7 days a week (70/week). Only rows still on the old default change.
UPDATE `settings` SET `targets` = json_set(`targets`, '$.daysPerWeek', 7) WHERE json_extract(`targets`, '$.daysPerWeek') = 6;
