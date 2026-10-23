-- Phase 2 checked the seed companies' job boards (2026-10-23).
-- 11 of 12 board tokens work. Retool's Ashby token does not, so clear it rather
-- than fetch a dead endpoint every morning. Only touches rows still holding the
-- seed values, so anything you edited in the UI is left alone.
UPDATE `companies`
SET `ats_type` = NULL, `ats_board_token` = NULL,
    `notes` = 'Job board unknown: the seeded Ashby token did not work. Find the careers page and set it here.'
WHERE lower(`name`) = 'retool' AND `ats_board_token` = 'retool';
--> statement-breakpoint
-- The "unverified" notes are superseded by the per-company fetch status column.
UPDATE `companies`
SET `notes` = NULLIF(trim(replace(replace(`notes`, 'ATS token unverified (Phase 2 checks it); ', ''), 'ATS token unverified (Phase 2 checks it)', '')), '')
WHERE `notes` LIKE 'ATS token unverified (Phase 2 checks it)%';
