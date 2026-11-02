# MySQL 스키마

## 새 DB에 한 번에 설치

수동으로 설치할 때는 저장소 루트의 `signjang_database_setup.sql` 하나만 전체 실행하세요.
이 파일에는 아래 `001`, `002`의 최종 구조가 모두 합쳐져 있습니다.

```sql
SOURCE signjang_database_setup.sql;
```

이미 `001_auth_schema.sql`을 실행한 DB라면 통합 파일 대신 `002_app_schema.sql`만 실행하세요.

`001_auth_schema.sql`은 다음 테이블을 생성합니다.

- `users`: 로그인 계정과 기본 회원정보
- `user_equipments`: 회원별 사용 장비
- `user_documents`: 차량등록증 등 회원 서류 URL
- `sms_verifications`: 회원가입·비밀번호 재설정 SMS 인증 이력
- `schema_migrations`: 적용된 SQL 파일 기록

`002_app_schema.sql`은 다음 기능을 확장합니다.

- 회원 프로필, 사업자번호, 계좌정보
- 장비 차량번호와 이미지 키
- 계약서, 일정, 계약서 전송 이력
- 연합사, 1:1 문의, 공지사항, 약관
- 사용자 서류의 파일 메타데이터

`003_repair_schedules.sql`은 기존에 `latin1`로 만들어진 MariaDB의 문자셋을
`utf8mb4`로 보정하고, 생성에 실패한 일정 테이블과 초기 공지·약관을 복구합니다.

`004_site_coordinates.sql`은 계약서와 일정에 `site_latitude`, `site_longitude`
WGS84 열을 추가합니다. 앱의 현장 날씨는 저장된 좌표를 우선 사용합니다. 기존 주소의
좌표 보정은 migration 이후에만 `npm run backfill:site-coordinates -- --apply`로 실행하며,
Kakao REST API 키가 필요합니다. 기본 backfill 명령은 읽기 전용 dry run입니다.
운영 DB에는 `npm run migrate`를 사용하세요. 이 migrator는 004가 중간에 멈춘 경우에도
이미 추가된 열과 인덱스를 확인한 뒤 남은 부분만 재시도합니다.

`005_remove_sky_equipment.sql`은 2026-09-14 스카이 항목 복구 요청에 따라
삭제 작업을 중단한 no-op 마이그레이션입니다. 회원가입과 보유장비 저장 API는
스카이 등록을 허용합니다. 이미 적용된 마이그레이션 기록은 유지하며,
과거에 삭제된 개별 보유장비 행은 이 파일로 재생성하지 않습니다.

## 자동 적용

서버의 `.env.local`에 DB 정보를 입력한 뒤 저장소 루트에서 실행합니다.

```bash
npm run db:migrate
```

마이그레이션은 파일명을 기준으로 한 번만 적용됩니다.

## 기존 마이그레이션 파일을 수동 적용

MySQL 클라이언트에서 아래 파일을 실행해도 됩니다.

```sql
SOURCE server/sql/001_auth_schema.sql;
SOURCE server/sql/002_app_schema.sql;
SOURCE server/sql/003_repair_schedules.sql;
SOURCE server/sql/004_site_coordinates.sql;
SOURCE server/sql/005_remove_sky_equipment.sql;
```

운영 서버에서는 root 계정 사용을 피하고 `000_create_app_user.sql.example`을 복사해 전용 계정을 생성하세요.
