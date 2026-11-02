# 싸인짱 관리자

React + TypeScript 관리자 웹입니다. 기존 Express API와 MySQL을 사용합니다.

로그인은 비밀번호만 입력합니다. 지정한 비밀번호의 bcrypt 해시가 서버에 설정되어 있습니다.

## 실행

프로젝트 루트에서 실행합니다.

```powershell
npm --prefix server install
npm run admin:install
```

비밀번호를 변경할 때만 `npm run admin:password`를 실행하고 출력된 bcrypt 해시를 `server/.env.local`에 저장합니다. 입력은 숨김 처리하며 UTF-8 기준 72바이트까지 지원합니다.

```env
ADMIN_PASSWORD_HASH=생성한_bcrypt_해시
ADMIN_NAME=관리자
```

기존 DB 연결 정보와 `JWT_SECRET`도 `server/.env.local`에 설정해야 합니다. 관리자 비밀번호 원문과 해시를 프론트 환경변수에 넣지 마세요.

```powershell
npm run db:migrate
npm run server:dev
```

마이그레이션에는 관리자 요금제 저장용 테이블이 포함됩니다. 별도 터미널에서 프론트를 실행합니다.

```powershell
npm run admin:dev
```

터미널에 표시되는 주소에서 관리자 비밀번호로 로그인합니다.

## API 주소

개발 서버는 `/api` 요청을 `http://127.0.0.1:4000`으로 전달합니다. 대상 서버를 바꾸려면 `admin/.env.local`을 사용합니다.

```env
ADMIN_API_PROXY=http://127.0.0.1:4000
VITE_ADMIN_API_URL=/api/admin
```

`ADMIN_API_PROXY`는 개발 서버 전용입니다. 운영 환경은 같은 출처의 `/api/admin`을 사용합니다.

## 빌드와 확인

```powershell
npm run admin:typecheck
npm run admin:build
npm run server:test
npm run admin:test
```

빌드 결과는 `admin/dist/`에 생성됩니다. 서버와 함께 배포하면 `/admin/`에서 접속할 수 있습니다. 관리자 환경변수 변경 후에는 API 서버를 다시 시작하세요.

통계의 계약 금액·수금·미수금은 앱에 저장된 업무 데이터입니다. 서비스의 구독 결제 매출을 뜻하지 않습니다. 실제 결제·환불 처리는 제공하지 않습니다.

개발 검증에는 격리된 테스트 데이터를 사용하며, 운영 DB 마이그레이션·데이터 수정·배포는 실행하지 않았습니다.

Windows의 브라우저 검증은 Chrome을 사용합니다. API 요청은 테스트 내부에서 차단하고 대체하므로 운영 데이터에 접근하지 않습니다. Chrome이 없는 환경에서는 `admin/` 폴더에서 `npx playwright install chromium`으로 브라우저를 설치하고 `PLAYWRIGHT_CHANNEL=chromium` 설정을 사용합니다.

## Docker

루트 디렉터리에서 API와 관리자 웹을 함께 빌드합니다.

```powershell
docker build -t signjjang-admin .
docker run --env-file server/.env.local -p 4000:4000 -v signjjang-uploads:/app/server/uploads signjjang-admin
```

컨테이너에서 `DB_HOST`는 접근 가능한 DB 주소로 설정해야 합니다. 컨테이너 빌드는 Docker 설치 환경에서 확인해야 합니다.
