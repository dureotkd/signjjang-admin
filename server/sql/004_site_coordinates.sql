USE `signjang`;

-- WGS84 coordinates for the saved site address. Keep the original address in
-- payload; these columns make weather lookups deterministic and indexable.
ALTER TABLE `contracts`
  ADD COLUMN `site_latitude` DECIMAL(9,6) NULL AFTER `fee`,
  ADD COLUMN `site_longitude` DECIMAL(9,6) NULL AFTER `site_latitude`,
  ADD KEY `idx_contracts_user_site_coordinates` (`user_id`, `site_latitude`, `site_longitude`);

ALTER TABLE `schedules`
  ADD COLUMN `site_latitude` DECIMAL(9,6) NULL AFTER `fee`,
  ADD COLUMN `site_longitude` DECIMAL(9,6) NULL AFTER `site_latitude`,
  ADD KEY `idx_schedules_user_site_coordinates` (`user_id`, `site_latitude`, `site_longitude`);
