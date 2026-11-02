USE `signjang`;

ALTER TABLE `users`
  ADD COLUMN `business_registration_no` VARCHAR(20) NULL AFTER `company_name`,
  ADD COLUMN `profile_image_url` VARCHAR(500) NULL AFTER `email`,
  ADD COLUMN `bank_name` VARCHAR(50) NULL AFTER `profile_image_url`,
  ADD COLUMN `bank_account` VARCHAR(50) NULL AFTER `bank_name`,
  ADD COLUMN `bank_holder` VARCHAR(60) NULL AFTER `bank_account`;

ALTER TABLE `user_equipments`
  ADD COLUMN `vehicle_no` VARCHAR(30) NULL AFTER `specification`,
  ADD COLUMN `image_key` VARCHAR(50) NULL AFTER `vehicle_no`,
  ADD COLUMN `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3) AFTER `created_at`;

ALTER TABLE `user_documents`
  MODIFY COLUMN `document_type` VARCHAR(80) NOT NULL,
  ADD COLUMN `label` VARCHAR(100) NOT NULL DEFAULT '' AFTER `document_type`,
  ADD COLUMN `original_name` VARCHAR(255) NULL AFTER `file_url`,
  ADD COLUMN `mime_type` VARCHAR(100) NULL AFTER `original_name`,
  ADD COLUMN `expires_on` DATE NULL AFTER `mime_type`,
  ADD COLUMN `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3) AFTER `created_at`;

CREATE TABLE IF NOT EXISTS `contracts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `type` VARCHAR(50) NOT NULL,
  `status` ENUM('draft', 'saved', 'completed') NOT NULL DEFAULT 'draft',
  `progress` ENUM('scheduled', 'inProgress', 'ended', 'unpaid', 'settled') NOT NULL DEFAULT 'scheduled',
  `start_date` DATE NOT NULL,
  `fee` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `payload` JSON NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_contracts_user_start` (`user_id`, `start_date`),
  KEY `idx_contracts_user_status` (`user_id`, `status`, `progress`),
  CONSTRAINT `fk_contracts_user`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `schedules` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `contract_id` BIGINT UNSIGNED NULL,
  `work_date` DATE NOT NULL,
  `status` ENUM('scheduled', 'inProgress', 'ended', 'unpaid', 'settled') NOT NULL DEFAULT 'scheduled',
  `settlement` ENUM('미수금', '정산완료') NOT NULL DEFAULT '미수금',
  `fee` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `payload` JSON NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_schedules_user_date` (`user_id`, `work_date`),
  KEY `idx_schedules_contract` (`contract_id`),
  CONSTRAINT `fk_schedules_user`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT `fk_schedules_contract`
    FOREIGN KEY (`contract_id`) REFERENCES `contracts` (`id`)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `contract_deliveries` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `contract_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `recipient_type` VARCHAR(50) NOT NULL,
  `recipient_phone` VARCHAR(20) NULL,
  `include_work_photos` TINYINT(1) NOT NULL DEFAULT 0,
  `status` ENUM('queued', 'sent', 'failed') NOT NULL DEFAULT 'queued',
  `provider_message_id` VARCHAR(100) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_contract_deliveries_contract` (`contract_id`, `created_at`),
  CONSTRAINT `fk_contract_deliveries_contract`
    FOREIGN KEY (`contract_id`) REFERENCES `contracts` (`id`)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT `fk_contract_deliveries_user`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `alliances` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `trade_name` VARCHAR(100) NOT NULL,
  `contact_name` VARCHAR(60) NOT NULL,
  `phone` VARCHAR(20) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_alliances_user_phone` (`user_id`, `phone`),
  KEY `idx_alliances_user` (`user_id`),
  CONSTRAINT `fk_alliances_user`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `inquiries` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `title` VARCHAR(150) NOT NULL,
  `content` TEXT NOT NULL,
  `answer` TEXT NULL,
  `answered_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_inquiries_user_created` (`user_id`, `created_at`),
  CONSTRAINT `fk_inquiries_user`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `notices` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug` VARCHAR(120) NOT NULL,
  `title` VARCHAR(200) NOT NULL,
  `body` MEDIUMTEXT NOT NULL,
  `published_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_notices_slug` (`slug`),
  KEY `idx_notices_published` (`published_at`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `terms_content` (
  `slug` VARCHAR(80) NOT NULL,
  `title` VARCHAR(150) NOT NULL,
  `body` MEDIUMTEXT NOT NULL,
  `version` VARCHAR(30) NOT NULL,
  `effective_on` DATE NOT NULL,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`slug`)
) ENGINE=InnoDB;

INSERT INTO `notices` (`slug`, `title`, `body`, `published_at`) VALUES
  ('signjang-update-2026-07', '싸인짱 업데이트 안내', '계약서와 일정 관리 기능이 개선되었습니다.', '2026-07-24 09:00:00.000'),
  ('basic-plan-2026-07', 'BASIC 요금제 안내', 'BASIC 요금제의 주요 기능과 이용 방법을 안내합니다.', '2026-07-10 09:00:00.000')
ON DUPLICATE KEY UPDATE `title` = VALUES(`title`), `body` = VALUES(`body`), `published_at` = VALUES(`published_at`);

INSERT INTO `terms_content` (`slug`, `title`, `body`, `version`, `effective_on`) VALUES
  ('service', '서비스 이용약관', '싸인짱 서비스 이용 조건과 절차에 관한 약관입니다.', '1.0', '2026-07-01'),
  ('privacy', '개인정보처리방침', '싸인짱은 서비스 제공에 필요한 개인정보를 안전하게 처리합니다.', '1.0', '2026-07-01'),
  ('refund', '환불 정책', '구독 상품의 환불은 결제 수단과 이용 상태에 따라 처리됩니다.', '1.0', '2026-07-01')
ON DUPLICATE KEY UPDATE `title` = VALUES(`title`), `body` = VALUES(`body`), `version` = VALUES(`version`), `effective_on` = VALUES(`effective_on`);
