# Still

Still은 떨어져 지내는 연인·가족·친구가 3초 영상과 최대 10초 음성으로 일상을 나누는 비공개 기록 공간입니다. 초대받은 사람끼리 각자의 하루를 남기고, 가능한 시간에 보고 듣습니다. 처음 온라인에서 로그인하고 기록 공간에 가입한 뒤에는 인터넷이 끊겨도 기록할 수 있습니다. 공유를 선택한 기록은 연결이 돌아오고 앱을 열어 두었거나 다시 열었을 때 업로드됩니다.

`Still` 화면은 작성자와 기록 시각을 중심으로 보여 줍니다. 기본 정렬은 **최근 업데이트순**으로, 늦게 업로드하거나 텍스트를 수정한 기록이 위로 올라옵니다. **기록 날짜순**을 선택하면 촬영·녹음 날짜가 최신인 날부터 묶고, 같은 날 안에서는 최근 업데이트가 먼저 나옵니다. 화면의 날짜와 시각은 원래 촬영·녹음 시각을 서울 기준 24시간제로 표시합니다. 목록의 영상 미리보기를 누르면 재생합니다. 내보내기 순서는 정렬 메뉴와 관계없이 촬영·녹음 시각순입니다.

화면은 짙은 회색과 올리브색의 기록 테마입니다. 버튼은 기본적으로 ‘영상 기록’, ‘음성 기록’처럼 짧게 표시합니다. 마우스 커서를 올리면 ‘박현준’을 타이핑한 뒤 잠시 멈추고 ‘영상 남겨줘’ 같은 나머지 이스터에그 문구를 보여 줍니다. 동작 줄이기 설정에서는 타이핑을 생략하고, 터치 화면에서는 기본 문구를 유지합니다. 보관·공유 동의와 삭제 확인에는 실제 동작을 그대로 적었습니다. 시각적 참고: [Call of Duty: Modern Warfare II](https://www.callofduty.com/en/store/games/modernwarfare2). 게임 로고·화면·음원은 포함하지 않았습니다.

기본 실행은 **Supabase를 사용하는 클라우드 모드**입니다. 계정은 Supabase Auth, 공간·기록 정보와 주소는 PostgreSQL, 영상·음성 원본은 비공개 Storage에 저장합니다. Node.js 서버가 로그인과 권한 확인, Whisper 음성 인식, FFmpeg 내보내기를 처리합니다. 다른 PC에서 소스를 받아도 같은 Supabase 프로젝트에 연결하고 같은 공간에 가입하면 공유된 기록을 볼 수 있습니다. 기기에만 보관한 기록과 업로드 대기 기록은 그 브라우저의 IndexedDB에 남습니다.

**현재 배포 상태:** 서울 리전의 Supabase `Still` 프로젝트를 생성하고 초기 SQL과 조회 인덱스 마이그레이션을 적용했습니다. `shared-backend.json`에 실제 프로젝트 URL과 공개 publishable 키가 들어 있어, 저장소를 내려받아 실행하면 별도 백엔드 설정 없이 같은 저장소에 연결합니다. 기록을 보려면 자기 계정으로 로그인하고 해당 공간에 소속되어 있어야 합니다.

**공개 시연 서버는 [still-jeonghanah.onrender.com](https://still-jeonghanah.onrender.com)에서 가동 중입니다.** Render 무료 512MB 배포가 `live` 상태이며 실제 HTTPS 기본 동작·접근 제한 점검 14개를 통과했습니다. Supabase Auth 연결과 이메일 가입·확인 설정, 익명 요청의 테이블·RPC 접근 차단도 확인했습니다.

**가입부터 기록 공유까지의 실제 사용자 흐름은 아직 검증 전입니다.** Gmail SMTP를 발송 방법으로 선택했으며 현재 SMTP는 미설정 상태입니다. 실제 계정 가입·로그인, 메일 수신, 멤버 간 공유, Storage 업로드와 미디어 처리 성능도 확인이 남아 있습니다. 완료한 설정과 남은 절차는 [배포 안내](DEPLOYMENT.md)에 구분했습니다.

## 구현 범위

- 이메일 가입·확인·로그인·비밀번호 재설정, 초대 코드로 가입하는 비공개 기록 공간
- 사용자당 공간 한 개, 공간당 최대 32명, 여러 공간 사이의 기록 접근 분리
- 영상 3초 자동 종료, 음성은 최대 10초 안에서 중간 종료
- 촬영·녹음 후 미리보기에서 다시 기록하기, 버리기, 기기에 보관하기, 공간에 공유하기 선택
- 사용자가 보관·공유를 선택하기 전에는 임시 메모리에만 보관하며, 공유를 선택한 기록만 업로드
- 오프라인 대기 기록의 재전송과 원래 촬영·녹음 시각 보존
- 본인 기록 삭제와 오프라인 삭제 재시도
- 기간별 MP4·M4A·TXT·ZIP 내보내기와 음성 인식 결과 수정
- UNOSAT의 서로 다른 두 관측일 자료 확인, 집 단위 근거가 없을 때 `우리 집 상태 미확인` 표시

### 해커톤 적용 사례

전쟁·피란이나 통신 장애로 떨어진 가족의 안부 공유를 시연 사례로 삼았습니다. 추가 기능인 `집 주변 관측`에서는 떠나온 동네의 두 시점 자료를 출처와 함께 확인할 수 있습니다. 동네의 피해 관측과 개별 집의 상태는 구분하며, 현재 안전 상태를 판정하지 않습니다.

## 공용 백엔드 연결

공용 프로젝트는 `qdzdqkxzqslsxtkusobu`이며 API 주소는 `https://qdzdqkxzqslsxtkusobu.supabase.co`입니다. 이 주소는 앱 접속 주소가 아닙니다. 저장소의 `shared-backend.json`에 **프로젝트 URL과 publishable 키만** 공개 연결 정보로 넣었습니다. 각 복제본은 이 파일을 그대로 사용하며, SQL을 다시 적용하거나 새 프로젝트를 만들 필요가 없습니다. 기록을 읽는 권한은 로그인과 공간 멤버십으로 결정합니다.

개별 설정을 원하면 `.env.example`을 `.env`로 복사하고 `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`를 채웁니다. 환경변수가 `shared-backend.json`보다 우선하므로 예시 값이 남은 `.env`를 함께 사용하지 마세요. `service_role`, `sb_secret_` 키는 지원하지 않습니다. `.env`와 세션 암호화 키는 GitHub에 올리지 않습니다.

## Windows에서 실행

1. [Node.js](https://nodejs.org/) 22 이상을 준비합니다.
2. 저장소를 내려받아 프로젝트 폴더에서 `npm ci`를 실행합니다. 공용 백엔드 설정을 확인하고 `start.cmd`를 실행합니다. 처음 실행하면 FFmpeg와 다국어 Whisper 모델을 프로젝트의 `.tools` 폴더에 다운로드합니다. 모델은 약 148MB이며 FFmpeg도 별도로 다운로드합니다.
3. 실행 창을 열어 둔 채 브라우저에서 [127.0.0.1:4173](http://127.0.0.1:4173)을 엽니다. 운영자의 SMTP·메일 템플릿 설정이 완료되면 **가입 → 이메일 확인 → 기록 공간 만들기** 순서로 시작합니다. 다른 사람은 자기 계정으로 가입하고 초대 코드를 입력합니다. 현재 SMTP는 미설정 상태이므로 화면 시연에는 아래 로컬 데모를 사용할 수 있습니다.

Windows PowerShell에서 직접 실행할 수도 있습니다.

```powershell
npm ci
.\start.cmd
```

Windows 외 환경에서는 `npm ci` 후 `ffmpeg`, `ffprobe`, `whisper-cli`를 실행 경로에 두고 `WHISPER_MODEL`에 다국어 모델 경로를 지정한 뒤 `npm start`를 실행합니다. Linux에서는 FFmpeg의 `drawtext`와 한글 글꼴이 필요합니다. 필요한 경우 `FFMPEG_PATH`, `FFPROBE_PATH`, `WHISPER_PATH`, `MEDIA_KOREAN_FONT`로 경로를 지정합니다. Docker 이미지에는 이 도구와 모델이 포함됩니다. [FFmpeg 다운로드](https://ffmpeg.org/download.html) · [whisper.cpp](https://github.com/ggml-org/whisper.cpp)

첫 설치에는 인터넷 연결이 필요합니다. `npm ci`는 검증에 쓰는 PGlite도 설치하며, 서버 실행 자체에는 외부 npm 패키지가 필요하지 않습니다. 개발용 클라우드 실행은 각 PC의 `.local/session.key`를 자동 생성합니다. 이 파일을 다른 PC와 공유하지 않아도 같은 공간의 기록을 볼 수 있습니다.

## 공용 서버 없이 로컬 데모 실행

공용 백엔드나 이메일 없이 시연하려면 `start.cmd --demo`를 실행합니다. 도구가 설치되어 있다면 `npm run demo`도 가능합니다. 로컬 데모는 두 시연 계정과 가상 기록을 `data`에 만들며 이 PC의 루프백 주소에서만 실행합니다. 클라우드 기록과 연결되지 않고, 공개 배포 모드에서는 사용할 수 없습니다.

### 로컬 데모 시연 순서

1. 일반 브라우저 창에서 **서연으로 들어가기**를 누릅니다. 다른 프로필이나 시크릿 창에서는 **지우로 들어가기**를 누릅니다. 일반 탭 두 개는 로그인 쿠키를 공유합니다.
2. 서연 계정에서 **영상 기록 → 촬영 시작**을 누릅니다. 촬영은 3초 뒤 자동으로 끝나고 미리보기가 열립니다. 이때 기록은 메모리에만 있으며, **버리기** 또는 창 닫기로 저장하지 않고 버릴 수 있고 **다시 촬영**도 가능합니다. **기기에 보관**을 선택해야 기기에 저장되며, **공간에 공유**를 선택하면 저장 후 업로드합니다. 결정 전에 페이지를 새로고침하거나 닫으면 임시 기록은 사라집니다.
3. 서연 쪽의 연결을 끊고 **음성 기록 → 녹음 시작**을 누릅니다. **녹음 끝내기**로 중간에 끝낼 수 있고, 10초가 되면 자동으로 끝납니다. 미리듣기 후 **공간에 공유**를 선택하면 **업로드 대기**로 표시됩니다. **기기에 보관**한 기록은 **기기에만 저장**으로 표시되며 **확인하고 공유하기**로 나중에 공유할 수 있습니다. 보관을 선택한 기록은 새로고침하거나 다시 열어도 유지됩니다. 첫 접속과 기록 공간 가입은 온라인에서 진행합니다.
4. 연결을 복구하면 지우의 타임라인에서 녹음한 날짜와 시각에 서연의 음성이 나타납니다. 앱을 열어 두거나 다시 열면 업로드됩니다. **음성 텍스트 수정**에서 인식 결과를 수정할 수 있습니다.
5. 지우가 **내보내기**에서 오늘을 포함하는 기간을 선택하고 MP4의 **영상과 음성 → 미리보기**를 누릅니다. MP4, M4A, TXT, ZIP을 내려받을 수 있고 타임라인에서 개별 M4A도 받을 수 있습니다. 날짜는 서울 시간 기준입니다.
6. **집 주변 관측**에서 7월 8일과 10월 11일의 UNOSAT 지도를 전환합니다. 지우에게는 **동네 피해 관측 · 우리 집 상태 미확인**이 표시되고, 상세 주소는 서연에게만 보입니다.
7. 본인이 남긴 기록 옆의 **휴지통 → 삭제**로 지웁니다. 삭제 전 확인창이 표시되며 다른 멤버의 기록은 삭제할 수 없습니다. 오프라인 삭제는 기기에 먼저 반영되고, 작성자 계정으로 연결되면 서버에도 반영됩니다. 삭제 대기 중에는 내보내기를 막아 삭제한 기록이 파일에 포함되지 않도록 합니다. 이미 내려받은 파일은 지워지지 않습니다.

시연 계정은 `family-a@example.test`(서연), `family-b@example.test`(지우)이고 기본 비밀번호는 둘 다 `demo2026!`입니다. 기본 영상은 생성 이미지로 만든 3초 클립이며 기본 음성은 합성 한국어 음성입니다.

초대 흐름을 처음부터 시연하려면 서버를 시작하기 전에 새 `OURDAYS_DATA_DIR`을 지정하고 `OURDAYS_EMPTY_FAMILY=1`을 설정합니다. 서연이 기록 공간을 만든 뒤 초대 코드를 확인하고, 지우가 코드를 입력해 가입합니다. 기존 시연 공간의 이름과 계정 식별자는 그대로 유지합니다.

## 다른 기기에서 접속·배포

휴대전화에서는 배포한 HTTPS 주소로 접속합니다. PC의 `127.0.0.1` 주소는 그 PC 전용입니다. 서버는 Docker를 지원하는 호스트나 Render에서 실행하고 HTTPS를 제공하는 프록시 뒤에 둡니다. `OURDAYS_ORIGIN`은 실제 외부 HTTPS 주소와 같아야 합니다. 카메라·마이크를 위해서도 신뢰할 수 있는 HTTPS가 필요합니다. 설정은 [DEPLOYMENT.md](DEPLOYMENT.md)에 정리했습니다.

GitHub는 소스를 공유하는 곳입니다. GitHub Pages만으로는 Node.js 로그인 API, 비공개 파일 접근, FFmpeg·Whisper를 실행할 수 없습니다. 클라우드 모드에는 시연 계정이나 기본 비밀번호가 생성되지 않습니다.

### 저장·처리 제한

SQL에서 파일당 16MiB, 사용자당 기록 1,000개·256MiB, 공간당 기록 2,000개·1GiB를 제한합니다. 개수와 용량 중 먼저 도달한 제한이 적용됩니다. 업로드 중인 기록은 건당 16MiB를 임시 예약하고 완료 시 실제 크기로 계산하므로 새 업로드에는 16MiB의 여유가 필요합니다. 삭제했지만 Storage 원본 정리가 끝나지 않은 기록도 한도에 포함됩니다. 초대 코드는 7일간 유효하고 공간 소유자가 재발급하면 이전 코드는 즉시 사용할 수 없습니다. 잘못된 초대 시도는 사용자당 15분에 10회까지 허용합니다.

한 번의 내보내기는 최대 100개·원본 합계 128MiB입니다. 범위를 줄여 나눠 내보낼 수 있습니다. 변환은 서버당 동시에 두 건, 사용자당 한 건으로 제한합니다. 이 값들은 앱의 제한이며 Supabase나 호스팅 서비스의 요금제 한도를 대신하지 않습니다.

## 코드 구성과 검증

- `public/app.js`: 화면과 촬영·녹음, 임시 미리보기, 보관·공유 선택
- `public/device.js`: IndexedDB에 기록, 캐시, 삭제 대기 정보 저장
- `public/record-sync.js`: 공유 동의 여부를 확인한 업로드와 삭제 재시도
- `public/record-order.js`: 최근 업데이트순·기록 날짜순 정렬과 날짜별 표시
- `public/sw.js`: 앱 파일을 캐시하는 서비스 워커
- `server/start.mjs`, `server/config.mjs`: 실행 모드·공용 연결 설정·환경변수 검증
- `server/cloud.mjs`, `server/cloud-auth.mjs`: 클라우드 API, 암호화된 HttpOnly 세션 쿠키, 로그인·갱신·이메일 확인
- `server/supabase.mjs`: 사용자 JWT로 실행하는 데이터·비공개 Storage 요청
- `supabase/migrations/`: 공간 권한, RLS, 업로드·삭제 처리, 용량 제한과 조회 인덱스. 별도 프로젝트를 만들 때 파일 이름순으로 모두 적용합니다.
- `server/index.mjs`: 명시적으로 선택하는 로컬 데모 API와 `data` 저장
- `server/media.mjs`: FFmpeg 변환·합치기, Whisper 음성 인식, 내보내기
- `public/home.js`, `server/home.mjs`: 관측 자료와 주소 공개 범위

프로젝트 폴더에서 다음 명령으로 로그인과 초대, 주소 접근 권한, 공유 동의, 삭제 권한·재시도·업로드 경합, 날짜순 조회 및 내보내기를 확인합니다. 미디어 테스트에는 FFmpeg와 FFprobe가 필요합니다.

```powershell
npm ci
npm test
```

로컬 API·미디어 테스트는 실제 FFmpeg를 사용합니다. 클라우드 HTTP·인증 테스트는 외부 Auth·저장소 응답을 모사하고, SQL 테스트는 PGlite PostgreSQL에서 RLS와 함수를 실행합니다. GitHub Actions에는 테스트와 Docker 빌드 검증을 설정했습니다.

실제 Supabase에서는 두 마이그레이션 적용, Auth 설정 HTTP 200 응답, 이메일 가입 활성화·자동 확인 비활성화, 익명 테이블·RPC 요청의 HTTP 401 차단을 확인했습니다. 공개 Render 서버에서는 실제 HTTPS 점검 14개를 통과했습니다. 앱·상태·익명 세션 응답, 비공개 API의 익명 접근 차단, 신뢰하지 않는 출처 차단, 잘못된 로그인과 확인 링크 처리, 서버 설정 파일 비공개를 점검했으며 확인한 서버 로그에는 비정상 종료나 메모리 부족 오류가 없었습니다.

배포한 웹앱의 데스크톱 화면과 가로 390px 모바일 화면에서 로그인·계정 만들기·비밀번호 찾기 화면 전환을 확인했습니다. 가로 넘침은 없었고 점검 중 브라우저 콘솔의 오류·경고도 없었습니다. 계정 생성이나 이메일 발송 성공을 확인한 것은 아닙니다.

실제 계정 두 개의 가입·로그인과 공간 격리, 멤버 간 공유, Storage 업로드·재생, SMTP 메일 수신, 서로 다른 기기에서의 촬영·동기화와 배포 서버의 미디어 처리 성능은 아직 검증하지 않았습니다. 자동 테스트·배포 상태 점검과 실제 사용 흐름 검증은 구분합니다.

## 외부 코드·도구·자료 출처

- **Node.js**: 서버 실행 환경과 기본 모듈을 사용합니다. [공식 사이트](https://nodejs.org/) · [소스와 라이선스](https://github.com/nodejs/node)
- **Supabase**: 클라우드 모드의 Auth, PostgreSQL, 비공개 Storage를 사용하며 REST API를 호출합니다. [공식 문서](https://supabase.com/docs) · **PGlite**는 SQL 정책 테스트에만 사용합니다. [소스와 라이선스](https://github.com/electric-sql/pglite)
- **FFmpeg / FFprobe**: 미디어 길이 검사, 영상·음성 변환과 합치기에 사용합니다. Windows 설치 스크립트는 Gyan Doshi의 release essentials 빌드를 내려받습니다. 프로젝트 ZIP에는 실행 파일을 포함하지 않습니다. [FFmpeg](https://ffmpeg.org/) · [Gyan Windows 빌드](https://www.gyan.dev/ffmpeg/builds/) · [FFmpeg 라이선스 안내](https://ffmpeg.org/legal.html)
- **whisper.cpp v1.8.3**: 서버에서 녹음을 텍스트로 옮기는 실행 도구입니다. MIT 라이선스입니다. [소스](https://github.com/ggml-org/whisper.cpp) · [사용한 릴리스](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.8.3) · [라이선스](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE)
- **OpenAI Whisper 다국어 base 모델**: whisper.cpp용 `ggml-base.bin`을 사용합니다. 모델은 MIT 라이선스이며, 설치 스크립트가 파일 해시를 확인합니다. [원본 모델](https://github.com/openai/whisper) · [ggml 변환 모델](https://huggingface.co/ggerganov/whisper.cpp) · [다운로드 실패 시 사용하는 동일 해시의 미러](https://www.telestream.net/download-files/ggml/ggml-base.bin)
- **브라우저 기능**: `MediaRecorder`, `getUserMedia`, IndexedDB, Service Worker를 사용합니다. 별도 프런트엔드 프레임워크나 브라우저용 npm 라이브러리를 사용하지 않습니다.
- **아이콘·글꼴**: `public/icons.js`와 `public/icon.svg`의 인라인 SVG를 사용합니다. 별도 아이콘 패키지는 없습니다. 화면은 기기에 설치된 한글 글꼴을 사용하며 웹폰트 파일을 내려받지 않습니다. 내보내기 글꼴도 운영체제의 설치 글꼴 또는 `MEDIA_KOREAN_FONT`로 지정한 파일을 사용합니다.

### 관측 자료

- 알샤티 지도는 두 UNOSAT 보고서의 같은 범위를 잘라 사용합니다. 집 단위 일치는 시연 자료에 포함되어 있지 않습니다. [2025년 7월 8일](https://unosat.org/products/4165) · [2025년 10월 11일](https://unosat.org/products/4213)
- 지도 분석 출처는 UNITAR-UNOSAT입니다. 앱에는 보고서에 기재된 영상 출처도 함께 표시합니다. 7월 자료는 Maxar·CNES, 10월 자료는 Vantor·CNES입니다. [7월 원본 PDF](https://unosat.org/static/unosat_filesystem/4165/OCHA-OPT-027_UNOSAT_A3_Gaza_Strip_OPT_CDA_08072025.pdf) · [10월 원본 PDF](https://unosat.org/static/unosat_filesystem/4213/OCHA-CBPF-OPT-031_UNOSAT_A3_GazaStrip_CDA_11October2025.pdf)
- 관측 자료는 해당 날짜의 공개 분석 자료이며 현재 집의 안전 여부를 판정하지 않습니다. 시연 거주지는 가상의 등록 항목입니다.

### AI 도구와 시연 미디어

- **OpenAI Codex**를 코드 작성·수정, 테스트, 문구와 UI 정리에 사용했습니다. 발표자는 코드 구성과 실제 동작을 직접 설명할 수 있도록 준비해야 합니다.
- **[Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill)**의 `design-taste-frontend` 지침을 UI 작업에 활용했습니다. 개발 보조 지침으로 사용했으며 앱의 실행 의존성은 아닙니다.
- **OpenAI ImageGen**으로 기본 시연 영상의 사진을 생성했습니다. 기본 음성은 합성 한국어 음성입니다. 두 미디어는 실제 피란민의 기록이나 현장 촬영 자료가 아닙니다.
- `server/demo/window.mp4`는 기본 ImageGen으로 만든 사진에 3초 확대를 적용한 시연 클립입니다. 생성 프롬프트는 아래와 같습니다.

  > Single editorial documentary photograph for a family diary 3-second demo video. Landscape, candid 35mm film texture: hand in cream knit sleeve puts a pale ceramic teacup on a honey wood table beside a bright apartment window, small vase of olive sprigs, off-white linen curtains, garden softly blurred. Warm quiet natural morning light, muted honey and cream, teacup close and recognizable center right, photographic. No text, border, logos, or identifiable people.

## 현재 한계

- 오프라인에서는 기록과 저장을 할 수 있고, 다른 멤버에게 전달하려면 서버 연결이 돌아와야 합니다. 통신망 없이 다른 기기에 즉시 전송하는 기능은 없습니다.
- 앱을 닫은 동안의 업로드는 보장하지 않습니다. 연결 복구 후 앱을 열어 두거나 다시 열어야 합니다. 기기 저장소를 지우면 아직 업로드하지 않은 기록도 사라질 수 있습니다.
- 공간 멤버 접근 권한과 주소 공개 범위를 적용했지만 종단간 암호화는 구현하지 않았습니다. 서버와 Supabase 운영자는 저장된 내용을 처리할 수 있습니다. 공유 기록은 Supabase에 남고 내보내기·음성 인식 중에는 Node 서버에서 임시 파일로 처리합니다.
- Supabase 연결과 공개 시연 서버 가동은 확인했지만 SMTP·메일 템플릿 설정 완료와 실제 계정의 전체 흐름 검증이 남아 있습니다. 새 Free 프로젝트는 기본 SMTP에서 메일 템플릿을 수정할 수 없어, 이 앱의 확인 링크를 적용하려면 custom SMTP가 필요합니다. [Supabase의 2026년 변경 안내](https://supabase.com/changelog/46599-changes-to-email-template-customisation-on-free-tier)
- 초대·참여·기록 삭제는 지원하지만 공간 탈퇴, 멤버 강제 제거, 계정 탈퇴의 사용자 화면은 아직 없습니다. 서비스 운영을 시작할 때 필요한 계정·데이터 삭제 요청 처리는 운영자가 마련해야 합니다.
- 음성 인식 결과는 틀릴 수 있어 수정 기능을 제공합니다. 연인·가족·친구의 실제 사용 흐름과 배포 서버의 미디어 처리 성능은 아직 검증하지 않았습니다.
- 거주지 시연은 한 동네의 두 시점 자료를 비교하는 범위입니다. 자동으로 집을 식별하거나 실시간 피해를 판정하지 않습니다.

## 해커톤 참가·제출 정보

- 팀명: **한아님**
- 참가 형태: 개인 참가
- GitHub: [JeongHanAh/2026COM-s-Hackathon](https://github.com/JeongHanAh/2026COM-s-Hackathon)
- 발표 계획: 약 5분. 공식 소개 방식 투표 결과는 별도 확인합니다.
- 프로젝트를 해커톤 기간 안에 새로 시작했는지 개발 이력으로 확인합니다.
- 원본 개회식 자료의 제출 마감은 **2026년 11월 15일 일요일 04:00**이며, 이후 커밋은 평가에 반영되지 않습니다.
- GitHub에는 앱 소스, SQL, 배포 설정, README와 해커톤 제출 자료를 올립니다. `shared-backend.json`에는 공개 연결 정보만 넣을 수 있습니다. 실제 기록·주소, `data`, `.qa-app-data`, 테스트 출력, `.tools`, `.local/session.key`, `.env`, 인증서와 비밀 키는 제외합니다. `.gitignore`와 `.dockerignore`를 적용하며 별도 경로의 데이터도 게시 전에 확인합니다. 소스에는 도구·모델 실행 파일을 포함하지 않고 설치 시 내려받습니다.


## 제출 자료

- [발표 자료](submission/01_발표자료.pptx)
- [프로젝트 계획서](submission/02_프로젝트_계획서.pdf)
- [소개 페이지](submission/소개페이지.html): 내려받아 브라우저에서 엽니다.
- [실행 파일 묶음](submission/our-days.zip)
