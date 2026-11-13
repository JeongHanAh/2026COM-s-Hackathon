# Still 배포 안내

서울 리전의 Supabase `Still` 프로젝트(`qdzdqkxzqslsxtkusobu`)를 생성했고, `shared-backend.json`에 실제 프로젝트 URL과 공개 publishable 키를 등록했습니다. API 주소는 `https://qdzdqkxzqslsxtkusobu.supabase.co`입니다. 이 주소는 Still 웹앱 접속 주소가 아닙니다. 저장소를 내려받아 실행하는 복제본은 별도 백엔드 설정 없이 같은 프로젝트에 연결합니다.

초기 SQL과 `20261114000200_still_query_indexes.sql` 적용을 마쳤으며 Auth 설정 응답, 이메일 가입 활성화(`emailEnabled: true`)·이메일 확인 필요(`autoconfirm: false`), 익명 테이블·RPC 요청의 HTTP 401 차단을 확인했습니다. 실제 계정 로그인·Storage 업로드와 메일 수신은 아직 검증하지 않았습니다.

**Render 무료 512MB 시연 서버는 [still-jeonghanah.onrender.com](https://still-jeonghanah.onrender.com)에서 가동 중입니다.** 배포 상태는 `live`이며 실제 HTTPS 기본 동작·접근 제한 점검 14개를 통과했습니다. Gmail SMTP를 발송 방법으로 선택했으며 현재 SMTP는 미설정 상태입니다. 실제 계정 가입·메일 수신·멤버 간 공유·미디어 처리까지 검증을 마친 상태는 아닙니다. 공용 백엔드를 이용할 사람은 1번의 새 프로젝트 생성·SQL 적용을 반복하지 않습니다. 별도 백엔드를 운영하려는 경우에만 아래 설정을 처음부터 진행합니다.

구성은 브라우저 → Still Node 서버 → Supabase Auth·PostgreSQL·비공개 Storage입니다. Node 서버는 사용자 JWT로만 데이터를 요청하고, FFmpeg·Whisper를 실행합니다. 같은 Supabase 연결 정보를 쓰는 여러 복제본은 같은 데이터를 봅니다. 각 복제본의 세션 키와 브라우저의 미공유 기록은 별개입니다.

## 1. 별도 Supabase 프로젝트 만들기

[Supabase 대시보드](https://supabase.com/dashboard)에서 새 프로젝트를 만들고 준비가 끝나면 SQL Editor에서 [supabase/migrations](supabase/migrations/) 안의 **모든 SQL 파일을 파일 이름순으로** 실행합니다. 현재 순서는 다음과 같습니다.

1. [202611140001_still.sql](supabase/migrations/202611140001_still.sql): 테이블, 함수, 권한과 Storage 정책
2. [20261114000200_still_query_indexes.sql](supabase/migrations/20261114000200_still_query_indexes.sql): 조회 인덱스
3. [20261114000300_still_home_location.sql](supabase/migrations/20261114000300_still_home_location.sql): 공유 지역, 등록자 전용 수정, 주소 변경 시 지역 초기화

각 파일의 전체 내용을 적용합니다. 이 작업은 해당 백엔드 운영자가 처음 한 번 수행하며, 앱을 내려받는 사람마다 실행하지 않습니다. 공용 `Still` 프로젝트에는 위 파일들을 적용했습니다. 기존 별도 프로젝트를 업그레이드할 때는 아직 적용하지 않은 파일만 순서대로 실행합니다.

집 주변 소식에는 별도 API 키가 필요하지 않습니다. 서버에서 Open-Meteo·Google News로 HTTPS 요청이 가능해야 하며, 브라우저 지도는 OpenStreetMap을 사용합니다. 현재 제공자 설정은 개인의 비상업적 열람·시연용입니다. 제공자 변경과 캐시·조회 범위는 [README의 지역 검색과 기사](README.md#지역-검색과-기사)를 참고하세요.

마이그레이션은 `still_*` 테이블, 권한 검사 함수, RLS 정책, `still-recordings` 비공개 버킷과 Storage 정책을 만듭니다. 기존 이름의 테이블이나 정책이 있는 프로젝트에 임의로 덮어쓰지 말고 이 앱용 프로젝트에서 시작하세요. 버킷을 public으로 바꾸거나 RLS를 끄지 않습니다.

프로젝트의 URL과 **publishable 키**를 복사합니다. legacy `anon` 키도 지원하지만 `service_role` 또는 `sb_secret_` 키는 사용하지 않습니다. 앱은 관리자 키를 요구하지 않습니다. 공개 키는 앱을 식별하는 값이며, 기록 접근은 사용자 로그인과 SQL·Storage 권한으로 제한합니다. [Supabase API 키 안내](https://supabase.com/docs/guides/getting-started/api-keys)

## 2. 이메일 가입과 비밀번호 재설정 설정

Authentication에서 이메일·비밀번호 가입과 이메일 확인을 활성화합니다. 앱의 이름은 1~48자, 비밀번호는 10~128자이며 Supabase의 비밀번호 설정이 더 엄격하면 그 설정도 적용됩니다.

일반 사용자가 가입하려면 **custom SMTP 발송 설정**을 완료합니다. 사용할 발송 서비스의 요구 사항에 맞춰 발신 주소를 준비하고 SMTP host·port·사용자명·비밀번호를 Supabase Authentication의 SMTP 설정에 입력합니다. 도메인 인증 필요 여부는 선택한 발송 서비스에 따라 다릅니다. 공용 시연 서비스는 Gmail SMTP를 선택했지만 아직 설정하지 않았으며, 설정 후 실제 발송·수신 확인이 필요합니다. 개인 발신 주소와 앱 비밀번호는 공개 문서에 넣지 않습니다. 비밀번호는 Supabase 설정에만 두고 소스나 이 앱의 `.env`에 넣지 않습니다. 기본 발송 서버는 프로젝트 팀 외 주소 발송이 제한되어 공개 서비스용으로 사용할 수 없습니다. [Supabase SMTP 안내](https://supabase.com/docs/guides/auth/auth-smtp)

2026년 6월 3일 이후 생성된 Free 프로젝트는 기본 SMTP를 사용하는 동안 인증 메일 템플릿을 수정할 수 없습니다. custom SMTP를 연결하면 템플릿을 수정할 수 있습니다. 공용 `Still`은 이 제한이 적용되는 새 Free 프로젝트이므로, 아래의 서버 확인 링크를 적용하려면 **custom SMTP 연결을 먼저 완료해야 합니다.** [Supabase 변경 공지](https://supabase.com/changelog/46599-changes-to-email-template-customisation-on-free-tier)

Authentication의 URL Configuration에서 Site URL을 공개 앱 주소, 예를 들어 `https://still.example.com`으로 지정합니다. 아직 로컬에서 준비 중이면 `http://127.0.0.1:4173`으로 시작하고 배포 후 바꿉니다. 허용 Redirect URLs에는 사용할 주소를 정확히 등록합니다.

```text
https://still.example.com/auth/confirm
http://127.0.0.1:4173/auth/confirm
http://localhost:4173/auth/confirm
```

예시의 공개 도메인은 실제 주소로 바꿉니다. 로컬 주소는 GitHub 복제본에서 가입·비밀번호 재설정을 허용할 때 추가합니다. 다른 포트를 쓰면 해당 포트의 콜백도 등록해야 합니다. 로컬에서 요청한 확인 메일은 서버를 실행한 같은 PC에서 열어야 합니다. 운영 도메인은 넓은 와일드카드 대신 정확한 경로를 등록합니다. [Redirect URL 안내](https://supabase.com/docs/guides/auth/redirect-urls)

공용 시연 서비스의 Site URL에는 `https://still-jeonghanah.onrender.com`, 허용 Redirect URL에는 `https://still-jeonghanah.onrender.com/auth/confirm`을 사용합니다. Supabase 대시보드 설정과 아래 템플릿의 저장·실제 메일 동작 확인은 아직 남아 있습니다.

이 앱은 서버에서 확인 토큰을 교환하므로 **Email Templates의 링크도 변경해야 합니다.** Confirm signup 본문에는 다음 링크를 넣습니다.

```html
<h2>Still 이메일 확인</h2>
<p><a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&amp;type=signup">이메일 확인하기</a></p>
```

Reset password 본문에는 다음 링크를 넣습니다.

```html
<h2>Still 비밀번호 재설정</h2>
<p><a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&amp;type=recovery">비밀번호 바꾸기</a></p>
```

`.RedirectTo`는 Still 서버가 전달하는 `OURDAYS_ORIGIN/auth/confirm`입니다. 기본 `ConfirmationURL` 링크를 그대로 두면 이 앱의 서버 세션 설정 흐름과 맞지 않습니다. 메일 서비스의 링크 추적 기능은 끄고 실제 받은 메일로 확인하세요. 재설정 링크를 연 뒤 비밀번호 변경 권한은 15분 동안 유지됩니다. [메일 템플릿 안내](https://supabase.com/docs/guides/auth/auth-email-templates)

## 3. 공용 연결 정보 공유와 로컬 실행

현재 `shared-backend.json`에는 공용 `Still` 프로젝트의 실제 연결 정보가 이미 들어 있습니다. 그대로 사용하면 다른 사람이 복제해도 같은 백엔드에 연결합니다. 별도 프로젝트를 운영할 때만 다음 예시를 자신의 공개 연결 값으로 바꿉니다.

```json
{
  "url": "https://YOUR_PROJECT.supabase.co",
  "publishableKey": "sb_publishable_YOUR_PUBLIC_KEY"
}
```

이 파일에는 비밀번호·관리자 키·세션 키·실제 기록을 넣지 않습니다. 환경변수 `SUPABASE_URL`과 `SUPABASE_PUBLISHABLE_KEY`가 있으면 파일보다 우선합니다. 개인 프로젝트를 사용하려면 `.env.example`을 `.env`로 복사하고 실제 값으로 바꾸세요. 공용 파일을 쓸 때는 `.env`에 남은 `YOUR_PROJECT` 같은 예시 값을 지워야 합니다.

직접 JSON을 편집하는 대신 URL과 키 종류를 검사하는 명령을 사용할 수도 있습니다. 아래 두 값은 실제 **공개 연결 값**으로 바꿉니다.

```sh
node server/configure-shared.mjs https://YOUR_PROJECT.supabase.co sb_publishable_YOUR_PUBLIC_KEY
```

Node.js 22 이상에서 프로젝트 폴더를 열고 실행합니다.

```powershell
npm ci
.\start.cmd
```

`start.cmd`는 Windows용 미디어 도구와 모델을 준비하고 서버를 시작합니다. 도구가 이미 준비된 환경에서는 `npm start`를 사용할 수 있습니다. 기본 주소는 `http://127.0.0.1:4173`입니다. 기본 모드는 `supabase`이며 설정이 비어 있으면 실행을 멈춥니다. Supabase 없이 UI를 시연할 때만 `start.cmd --demo` 또는 `npm run demo`를 사용합니다.

개발용 실행은 `.local/session.key`를 자동 생성합니다. 이 키를 복제본끼리 공유할 필요는 없으며 Git에서 제외합니다. 새 계정은 로그인하고 기존 공간의 초대 코드를 입력합니다. 이미 공간에 가입한 계정은 새 PC에서도 로그인만 하면 기존 공간이 표시됩니다. 계정 하나는 현재 공간 하나에만 소속될 수 있습니다. 신규 가입과 비밀번호 재설정은 2번의 SMTP·메일 템플릿 설정을 완료한 뒤 실제 메일로 확인해야 합니다.

## 4. 공개 서버 환경변수

공개 서버에는 다음 값을 호스팅 서비스의 환경변수·비밀 설정으로 넣습니다. 예시 값은 바꿔야 합니다.

```dotenv
NODE_ENV=production
STILL_BACKEND=supabase
HOST=0.0.0.0
PORT=4173
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_PUBLIC_KEY
STILL_SESSION_SECRET=REPLACE_WITH_A_PRIVATE_RANDOM_VALUE
OURDAYS_ORIGIN=https://still.example.com
OURDAYS_SECURE_COOKIE=1
```

`STILL_SESSION_SECRET`은 최소 32자의 무작위 비밀 값입니다. 로컬 터미널에서 다음 명령으로 생성하고 호스팅의 비밀 값 입력란에 저장할 수 있습니다. 출력값을 커밋하거나 채팅에 붙이지 않습니다.

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

재시작할 때 같은 키를 유지해야 기존 로그인 쿠키를 읽을 수 있습니다. 하나의 공개 서비스가 여러 인스턴스로 실행된다면 그 인스턴스들은 같은 키를 사용합니다. 각자의 PC에서 실행하는 복제본에는 별도 키를 둡니다. 키를 교체하면 기존 사용자는 다시 로그인해야 합니다.

`OURDAYS_ORIGIN`에는 끝의 `/`나 하위 경로 없이 실제 외부 주소를 적습니다. 브라우저가 여는 주소, 이 설정, Supabase의 허용 콜백 주소가 일치해야 합니다. HTTPS 종료는 호스팅 서비스나 리버스 프록시에서 담당합니다. `server/start.mjs`는 HTTP 서버를 실행하며 TLS 인증서 환경변수를 직접 읽지 않습니다. 로컬 데모는 외부 호스트나 `NODE_ENV=production`에서 실행하지 못하도록 막았습니다.

## 5. Docker 또는 Render에서 실행

[Dockerfile](Dockerfile)은 Node.js 22, FFmpeg·FFprobe, 고정된 whisper.cpp 소스, 해시를 검사한 다국어 base 모델과 한글 글꼴을 포함합니다. 모델 다운로드와 빌드 때문에 첫 빌드에는 시간이 걸립니다. 런타임은 root가 아닌 사용자로 실행합니다.

```sh
docker build -t still .
docker run --rm --env-file .env -p 127.0.0.1:4173:4173 still
```

이 명령의 `.env`에는 앞의 **공개 서버 환경변수**를 넣습니다. 호스트의 HTTPS 프록시가 `127.0.0.1:4173`으로 전달하도록 설정합니다. 브라우저는 `OURDAYS_ORIGIN`의 HTTPS 주소로 접속합니다. 프록시는 최소 16MiB 업로드와 변환 작업 시간을 허용해야 합니다.

Render에서는 저장소를 연결해 [render.yaml](render.yaml)을 사용하는 Blueprint로 만듭니다. `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `OURDAYS_ORIGIN`을 입력하고 생성되는 `STILL_SESSION_SECRET`을 유지합니다. Docker 이미지가 `0.0.0.0`과 호스트의 `PORT`에서 실행되고 Render가 HTTPS를 제공합니다. 공개 주소가 정해지면 `OURDAYS_ORIGIN`과 Supabase URL Configuration을 그 주소로 맞추고 다시 배포합니다. [Render Docker 안내](https://render.com/docs/docker) · [Web Service 안내](https://render.com/docs/web-services)

현재 공용 서비스는 **Render 무료 512MB 인스턴스를 사용하는 시연 배포**이며 [still-jeonghanah.onrender.com](https://still-jeonghanah.onrender.com)에서 `live` 상태로 가동 중입니다. Docker Command는 `node server/start.mjs`이고 `OURDAYS_ORIGIN`은 `https://still-jeonghanah.onrender.com`으로 설정했습니다. 실제 HTTPS 응답과 접근 제한을 확인했으며 점검한 서버 로그에는 비정상 종료나 메모리 부족 오류가 없었습니다. 이 크기에서 실제 Whisper 음성 인식과 내보내기의 처리 성능, Supabase 대시보드의 이메일 설정과 실제 계정 두 개를 이용한 검증은 남아 있습니다.

기록 원본은 Supabase에 저장하므로 Node 서버의 영구 데이터 디스크는 필요하지 않습니다. 서버에는 미디어 처리용 임시 디스크와 CPU·메모리가 필요합니다. 실제 음성 인식과 긴 내보내기를 실행해 사용할 호스팅 크기를 결정하세요. 처리 중 재시작되면 진행 중 작업은 중단될 수 있고, 음성 인식의 `처리 중` 기록은 다음 목록 조회 때 다시 시도합니다.

`GET /api/health`는 Node 서버가 요청을 받는지 확인하는 경로입니다. 응답은 `{"status":"ok","backend":"supabase"}`이며 **SQL 적용, Supabase 연결, 메일 수신, 미디어 변환 성공까지 확인하지 않습니다.** Render와 Docker의 상태 확인은 이 경로를 사용합니다.

GitHub Pages는 정적 호스팅이므로 이 서버를 실행할 수 없습니다. `public` 폴더만 올리면 로그인과 공유·변환 API가 동작하지 않습니다. [GitHub Pages 안내](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

## 6. 실제 연결 확인

실제 Supabase에서는 프로젝트 생성, 두 SQL 파일 적용, Auth 설정 HTTP 200 응답(`emailEnabled: true`, `autoconfirm: false`), 익명 REST 테이블·RPC 접근의 HTTP 401 차단을 확인했습니다.

실제 Render HTTPS 주소에서 기본 동작·접근 제한 점검 14개를 통과했습니다.

- 앱 루트·`/api/health`·`/api/session`: HTTP 200
- 익명 기록·거주지·내보내기·미디어 요청: HTTP 401
- 신뢰하지 않는 `Origin` 또는 `Sec-Fetch-Site` 요청: HTTP 403
- 형식이 잘못된 로그인: HTTP 400, 실제 Supabase에 전달한 가짜 계정 로그인: HTTP 401
- 확인 토큰 없는 이메일 콜백: HTTP 303 오류 안내 리다이렉트
- `/server/config.mjs`와 `/.env` 요청: HTTP 404

배포한 웹앱의 데스크톱·가로 390px 모바일 화면에서 로그인·계정 만들기·비밀번호 찾기 화면 전환을 확인했습니다. 가로 넘침은 없었고, 점검 중 브라우저 콘솔의 오류·경고는 0건이었습니다.

이 점검은 실제 계정의 정상 가입·로그인, SMTP 메일 수신, 공간 멤버 간 공유나 미디어 처리 성능을 확인한 것은 아닙니다. SMTP·URL·메일 템플릿 설정 저장을 확인한 뒤 다음 흐름을 진행합니다.

먼저 서로 다른 이메일 두 개로 가입해 확인 메일을 받고 로그인합니다. 한 사람이 공간을 만들고 다른 사람은 초대 코드로 가입합니다. 별도 브라우저 프로필이나 다른 기기를 사용해야 로그인 쿠키가 섞이지 않습니다.

한쪽에서 영상을 공유한 뒤 다른 쪽에서 재생하고, 오프라인에서 음성을 남겨 공유를 선택한 뒤 연결을 복구합니다. 원래 녹음 날짜가 유지되는지 확인합니다. 두 기록을 포함한 MP4·M4A·TXT·ZIP과 본인 기록 삭제를 확인하고, 다른 공간 계정에서는 보이지 않아야 합니다. GitHub 복제본의 로컬 서버에서도 같은 계정으로 로그인해 같은 기록을 확인합니다. 마지막으로 비밀번호 재설정 메일을 열어 변경 후 다시 로그인합니다.

저장소의 `npm test`는 로컬 미디어 처리, 모사된 클라우드 HTTP·인증, PGlite의 PostgreSQL 정책을 검사합니다. 실제 Supabase Auth·Storage와 SMTP 전체를 대신 검증하지는 않습니다. [SQL 테스트 설명](supabase/tests/README.md)을 함께 참고하세요.

## 저장과 운영 범위

공간당 최대 32명, 초대 코드 유효기간은 7일입니다. 소유자가 코드를 재발급하면 이전 코드는 무효가 됩니다. 사용자당 잘못된 초대 시도는 15분에 10회로 제한됩니다.

마이그레이션의 보관 한도는 파일당 16MiB, 사용자당 1,000개·256MiB, 공간당 2,000개·1GiB입니다. 개수 또는 용량 중 먼저 도달한 한도가 적용됩니다. 업로드 예약은 선언한 크기와 무관하게 건당 16MiB를 먼저 확보하고 완료할 때 Storage의 실제 크기를 검사해 그 크기로 계산합니다. 따라서 새 업로드에는 16MiB의 여유 공간이 필요합니다.

삭제 표시는 지연된 업로드가 기록을 되살리지 않도록 남깁니다. 삭제 API는 Storage 원본 제거까지 성공해야 완료 처리하며 실패하면 재시도합니다. 삭제 표시 후에도 원본이 남아 있으면 건당 16MiB로 한도에 포함되어, 삭제 정리 실패로 용량 제한을 우회할 수 없습니다. 이 한도는 Supabase 전체 사용량·요금제 한도나 백업 용량과 별개입니다.

기본 내보내기는 한 번에 최대 100개·원본 합계 128MiB이며 서버당 두 건, 사용자당 한 건만 동시에 실행합니다. 임시 파일은 처리 후 제거합니다. 앱을 강제 종료한 경우 남은 운영체제 임시 파일의 정리와 서버·Supabase의 백업·복구는 운영 환경에서 관리해야 합니다. DB 데이터와 Storage 원본을 함께 복구할 수 있는 운영 절차를 준비하세요.

전송 구간 HTTPS와 접근 권한을 적용하지만 종단간 암호화는 없습니다. 음성 인식과 변환을 위해 서버가 내용을 읽습니다. 기기에만 보관한 기록은 업로드하지 않으며, 이미 내려받은 파일은 앱에서 삭제해도 회수할 수 없습니다. 계정 탈퇴·멤버 제거·공간 탈퇴 화면과 운영자용 관리 화면은 현재 없습니다.

`.gitignore`와 `.dockerignore`는 `.env`, `.local`, 인증서, 시연·시험 데이터와 도구를 제외합니다. 실제 기록, 주소, 사용자 토큰, SMTP 비밀번호와 관리자 키를 소스·이미지·로그에 넣지 않습니다. 공유 가능한 연결 정보와 개발용 가상 미디어·공개 관측 자료의 출처는 [README](README.md)에 남깁니다.
