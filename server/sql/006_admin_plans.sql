USE `signjang`;

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
