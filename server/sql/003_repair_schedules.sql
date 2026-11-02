USE `signjang`;

ALTER DATABASE `signjang`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 0;

ALTER TABLE `schema_migrations` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `users` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `user_equipments` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `user_documents` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `sms_verifications` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `contracts` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `contract_deliveries` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `alliances` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `inquiries` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `notices` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `terms_content` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

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
