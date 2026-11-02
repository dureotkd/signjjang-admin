# 싸인짱 관리자

화이트 톤 React 관리자와 Express·MySQL API입니다. 로그인은 비밀번호만 입력합니다.

## 실행

Node.js 20.19 이상과 MySQL을 사용합니다.

```bash
npm run setup
```

`server/.env.example`을 `server/.env.local`로 복사하고 기존 싸인짱 DB 연결 정보와 `JWT_SECRET`, `SMS_CODE_PEPPER`를 설정합니다. 관리자 비밀번호의 bcrypt 해시는 서버에 기본 설정되어 있습니다.

```bash
npm run db:migrate
npm run dev
```

관리자 주소: http://127.0.0.1:5173/admin/

## 기능

- 통계·기간별 차트·CSV
- 회원·계약서·일정·장비·서류·연락처 관리
- 문의 답변·공지 등록·문자 발송 이력
- 요금제·약관 관리

통계의 계약 금액은 장비 업무에 기록된 금액입니다.

## 빌드·검증

```bash
npm run build
npm run test:server
npm run test:admin
```

운영 서버는 빌드된 화면을 `/admin/`에서 제공합니다.

```bash
npm start
```

Windows 브라우저 테스트는 Chrome을 사용합니다. 다른 환경에서는 `admin/`에서 `npx playwright install chromium`을 먼저 실행합니다. 테스트 API는 격리된 데이터를 사용합니다.

## Docker

```bash
docker build -t signjjang-admin .
docker run --env-file server/.env.local -p 4000:4000 -v signjjang-uploads:/app/server/uploads signjjang-admin
```

기존 앱과 같은 DB를 사용합니다. 컨테이너의 `DB_HOST`는 DB에 접근 가능한 주소로 지정합니다.

비밀번호를 변경하려면 `npm run admin:password`로 해시를 생성하고 서버 환경변수 `ADMIN_PASSWORD_HASH`에 저장한 뒤 서버를 재시작합니다.
