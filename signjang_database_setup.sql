-- 싸인짱 MySQL 전체 설치 스크립트
-- 대상: 비어 있는 MySQL 서버 또는 아직 싸인짱 테이블을 만들지 않은 signjang DB
-- 이 파일 하나만 전체 실행하세요. 001_auth_schema.sql, 002_app_schema.sql을 추가 실행할 필요가 없습니다.

CREATE DATABASE IF NOT EXISTS `signjang`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `signjang`;

-- signjang DB가 미리 만들어져 있었더라도 한글을 저장할 수 있도록 기본 문자셋을 보정합니다.
ALTER DATABASE `signjang`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `filename` VARCHAR(255) NOT NULL,
  `executed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`filename`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `users` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `phone` VARCHAR(20) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `company_name` VARCHAR(100) NOT NULL,
  `business_registration_no` VARCHAR(20) NULL,
  `full_name` VARCHAR(60) NOT NULL,
  `gender` ENUM('male', 'female', 'other') NOT NULL DEFAULT 'other',
  `birth_year` SMALLINT UNSIGNED NULL,
  `email` VARCHAR(190) NULL,
  `profile_image_url` VARCHAR(500) NULL,
  `bank_name` VARCHAR(50) NULL,
  `bank_account` VARCHAR(50) NULL,
  `bank_holder` VARCHAR(60) NULL,
  `marketing_agreed` TINYINT(1) NOT NULL DEFAULT 0,
  `referral_code` VARCHAR(20) NOT NULL,
  `referred_by_user_id` BIGINT UNSIGNED NULL,
  `status` ENUM('active', 'inactive', 'withdrawn') NOT NULL DEFAULT 'active',
  `last_login_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `deleted_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_phone` (`phone`),
  UNIQUE KEY `uq_users_email` (`email`),
  UNIQUE KEY `uq_users_referral_code` (`referral_code`),
  KEY `idx_users_identity_lookup` (`company_name`, `full_name`),
  KEY `idx_users_referred_by` (`referred_by_user_id`),
  CONSTRAINT `fk_users_referred_by`
    FOREIGN KEY (`referred_by_user_id`) REFERENCES `users` (`id`)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `user_equipments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `category` VARCHAR(50) NOT NULL,
  `specification` VARCHAR(50) NULL,
  `vehicle_no` VARCHAR(30) NULL,
  `image_key` VARCHAR(50) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_user_equipment` (`user_id`, `category`, `specification`),
  KEY `idx_user_equipments_user` (`user_id`),
  CONSTRAINT `fk_user_equipments_user`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `user_documents` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `document_type` VARCHAR(80) NOT NULL,
  `label` VARCHAR(100) NOT NULL DEFAULT '',
  `file_url` VARCHAR(500) NOT NULL,
  `original_name` VARCHAR(255) NULL,
  `mime_type` VARCHAR(100) NULL,
  `expires_on` DATE NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_user_documents_user_type` (`user_id`, `document_type`),
  CONSTRAINT `fk_user_documents_user`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `sms_verifications` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `phone` VARCHAR(20) NOT NULL,
  `purpose` ENUM('signup', 'password_reset') NOT NULL,
  `code_hash` CHAR(64) NOT NULL,
  `attempts` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `provider_message_id` VARCHAR(100) NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `verified_at` DATETIME(3) NULL,
  `consumed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_sms_lookup` (`phone`, `purpose`, `created_at`),
  KEY `idx_sms_expiry` (`expires_at`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `contracts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `type` VARCHAR(50) NOT NULL,
  `status` ENUM('draft', 'saved', 'completed') NOT NULL DEFAULT 'draft',
  `progress` ENUM('scheduled', 'inProgress', 'ended', 'unpaid', 'settled') NOT NULL DEFAULT 'scheduled',
  `start_date` DATE NOT NULL,
  `fee` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `site_latitude` DECIMAL(9,6) NULL,
  `site_longitude` DECIMAL(9,6) NULL,
  `payload` JSON NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_contracts_user_start` (`user_id`, `start_date`),
  KEY `idx_contracts_user_status` (`user_id`, `status`, `progress`),
  KEY `idx_contracts_user_site_coordinates` (`user_id`, `site_latitude`, `site_longitude`),
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
  `site_latitude` DECIMAL(9,6) NULL,
  `site_longitude` DECIMAL(9,6) NULL,
  `payload` JSON NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_schedules_user_date` (`user_id`, `work_date`),
  KEY `idx_schedules_contract` (`contract_id`),
  KEY `idx_schedules_user_site_coordinates` (`user_id`, `site_latitude`, `site_longitude`),
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
ON DUPLICATE KEY UPDATE
  `title` = VALUES(`title`),
  `body` = VALUES(`body`),
  `published_at` = VALUES(`published_at`);

INSERT INTO `terms_content` (`slug`, `title`, `body`, `version`, `effective_on`) VALUES
  ('service', '서비스 이용약관', '싸인짱 서비스 이용 조건과 절차에 관한 약관입니다.', '1.0', '2026-07-01'),
  ('privacy', '개인정보처리방침', '싸인짱은 서비스 제공에 필요한 개인정보를 안전하게 처리합니다.', '1.0', '2026-07-01'),
  ('refund', '환불 정책', '구독 상품의 환불은 결제 수단과 이용 상태에 따라 처리됩니다.', '1.0', '2026-07-01')
ON DUPLICATE KEY UPDATE
  `title` = VALUES(`title`),
  `body` = VALUES(`body`),
  `version` = VALUES(`version`),
  `effective_on` = VALUES(`effective_on`);

CREATE TABLE IF NOT EXISTS `membership_plans` (
  `id` VARCHAR(120) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `price` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `currency` CHAR(3) NOT NULL DEFAULT 'KRW',
  `billing_period` ENUM('monthly', 'yearly') NOT NULL DEFAULT 'monthly',
  `features` JSON NOT NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 1,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;

INSERT IGNORE INTO `membership_plans` (`id`, `name`, `price`, `currency`, `billing_period`, `features`, `active`)
VALUES ('basic-monthly', 'BASIC', 99000, 'KRW', 'monthly', JSON_ARRAY('계약서 작성 무제한', '계약서 관리', '일정 관리'), 1);

-- 통합 스크립트 실행 후 자동 마이그레이션이 같은 변경을 다시 적용하지 않도록 기록합니다.
INSERT IGNORE INTO `schema_migrations` (`filename`) VALUES
  ('001_auth_schema.sql'),
  ('002_app_schema.sql'),
  ('003_repair_schedules.sql'),
  ('004_site_coordinates.sql'),
  ('006_admin_plans.sql');
