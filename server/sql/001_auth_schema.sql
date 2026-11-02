CREATE DATABASE IF NOT EXISTS `signjang`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `signjang`;

CREATE TABLE IF NOT EXISTS `users` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `phone` VARCHAR(20) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `company_name` VARCHAR(100) NOT NULL,
  `full_name` VARCHAR(60) NOT NULL,
  `gender` ENUM('male', 'female', 'other') NOT NULL DEFAULT 'other',
  `birth_year` SMALLINT UNSIGNED NULL,
  `email` VARCHAR(190) NULL,
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
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
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
  `document_type` ENUM('vehicle_registration', 'business_registration', 'bankbook', 'profile') NOT NULL,
  `file_url` VARCHAR(500) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
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

CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `filename` VARCHAR(255) NOT NULL,
  `executed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`filename`)
) ENGINE=InnoDB;
