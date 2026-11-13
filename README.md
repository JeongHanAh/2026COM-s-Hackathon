# 우리의 일상 기록

전쟁과 피란으로 떨어져 지내는 가족이 3초 영상과 최대 10초 음성으로 하루를 남기는 비공개 기록 서비스입니다. 처음 온라인에서 로그인하고 가족 공간에 가입한 뒤에는 인터넷이 끊겨도 기록할 수 있습니다. 공유를 선택한 기록은 연결이 돌아오고 앱을 열어 두었거나 다시 열었을 때 업로드됩니다.

`생존 기록` 화면은 작성자와 기록 시각을 중심으로 보여 줍니다. 시각은 서울 기준 24시간제로 표시하며, 목록의 영상 미리보기를 누르면 재생합니다. 기록은 남긴 당시의 정보이며 현재 생존 여부나 안전 상태를 자동으로 판정하지 않습니다.

화면은 짙은 회색과 올리브색의 통신 기록 테마입니다. 버튼은 기본적으로 ‘영상 기록’, ‘음성 기록’처럼 짧게 표시하고, 마우스 커서를 올리면 ‘박현준 영상 남겨줘’ 같은 이스터에그 문구가 나타납니다. 터치 화면에서는 기본 문구를 유지합니다. 보관·공유 동의와 삭제 확인에는 실제 동작을 그대로 적었습니다. 시각적 참고: [Call of Duty: Modern Warfare II](https://www.callofduty.com/en/store/games/modernwarfare2). 게임 로고·화면·음원은 포함하지 않았습니다.

가족 공간 하나, 계정 두 개, 등록 거주지 한 곳으로 시연하는 모바일 웹앱입니다. 브라우저는 IndexedDB에 대기 중인 기록을 보관합니다. 같은 Node.js 서버에서 로그인, 공유, Whisper 음성 인식, FFmpeg 내보내기를 처리합니다. 가족 기록과 주소는 서버의 `data` 폴더에 저장됩니다.

## 구현 범위

- 초대로 가입하는 가족 공간, 서로 다른 계정 두 개, 날짜별 영상·음성 타임라인
- 영상 3초 자동 종료, 음성은 최대 10초 안에서 중간 종료
- 촬영·녹음 후 미리보기에서 다시 기록하기, 버리기, 기기에 보관하기, 가족과 공유하기 선택
- 사용자가 보관·공유를 선택하기 전에는 임시 메모리에만 보관하며, 공유를 선택한 기록만 업로드
- 오프라인 대기 기록의 재전송과 원래 촬영·녹음 시각 보존
- 본인 기록 삭제와 오프라인 삭제 재시도
- 기간별 MP4·M4A·TXT·ZIP 내보내기와 음성 인식 결과 수정
- UNOSAT의 서로 다른 두 관측일 자료 확인, 집 단위 근거가 없을 때 `우리 집 상태 미확인` 표시

## Windows에서 실행

1. [Node.js](https://nodejs.org/) 22 이상을 준비합니다.
2. 압축을 풀고 `start.cmd`를 실행합니다. 처음 실행하면 FFmpeg와 다국어 Whisper 모델을 프로젝트의 `.tools` 폴더에 다운로드합니다. 모델은 약 148MB이며 FFmpeg도 별도로 다운로드합니다.
3. 실행 창을 열어 둔 채 브라우저에서 [127.0.0.1:4173](http://127.0.0.1:4173)을 엽니다.

Windows PowerShell에서 직접 실행할 수도 있습니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File server/media-setup-ffmpeg.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File server/media-setup-whisper.ps1
node server/index.mjs
```

Windows 외 환경에서는 `ffmpeg`, `ffprobe`, `whisper-cli`를 실행 경로에 두고 `WHISPER_MODEL`에 다국어 모델 경로를 지정한 뒤 `node server/index.mjs`를 실행합니다. Linux에서는 FFmpeg의 `drawtext`와 한글 글꼴이 필요합니다. 필요한 경우 `FFMPEG_PATH`, `FFPROBE_PATH`, `WHISPER_PATH`, `MEDIA_KOREAN_FONT`로 경로를 지정합니다. [FFmpeg 다운로드](https://ffmpeg.org/download.html) · [whisper.cpp](https://github.com/ggml-org/whisper.cpp)

첫 설치에는 인터넷 연결이 필요합니다. 시연 전 `start.cmd`를 한 번 실행해 도구와 모델 설치를 마쳐 두세요. 프런트엔드와 서버는 별도 npm 패키지 설치 없이 실행됩니다.

## 시연 순서

1. 일반 브라우저 창에서 **서연으로 들어가기**를 누릅니다. 다른 프로필이나 시크릿 창에서는 **지우로 들어가기**를 누릅니다. 일반 탭 두 개는 로그인 쿠키를 공유합니다.
2. 서연 계정에서 **영상 → 촬영 시작**을 누릅니다. 촬영은 3초 뒤 자동으로 끝나고 미리보기가 열립니다. 이때 기록은 메모리에만 있으며, **버리기** 또는 창 닫기로 저장하지 않고 버릴 수 있고 **다시 촬영**도 가능합니다. **기기에 보관**을 선택해야 기기에 저장되며, **가족과 공유**를 선택하면 저장 후 업로드합니다. 결정 전에 페이지를 새로고침하거나 닫으면 임시 기록은 사라집니다.
3. 서연 쪽의 연결을 끊고 **음성 → 녹음 시작**을 누릅니다. **녹음 끝내기**로 중간에 끝낼 수 있고, 10초가 되면 자동으로 끝납니다. 미리듣기 후 **가족과 공유**를 선택하면 **업로드 대기**로 표시됩니다. **기기에 보관**한 기록은 **기기에만 저장**으로 표시되며 **확인하고 공유하기**로 나중에 공유할 수 있습니다. 보관을 선택한 기록은 새로고침하거나 다시 열어도 유지됩니다. 첫 접속과 가족 공간 가입은 온라인에서 진행합니다.
4. 연결을 복구하면 지우의 타임라인에서 녹음한 날짜와 시각에 서연의 음성이 나타납니다. 앱을 열어 두거나 다시 열면 업로드됩니다. **음성 텍스트 수정**에서 인식 결과를 수정할 수 있습니다.
5. 지우가 **내보내기**에서 오늘을 포함하는 기간을 선택하고 MP4의 **영상과 음성 → 미리보기**를 누릅니다. MP4, M4A, TXT, ZIP을 내려받을 수 있고 타임라인에서 개별 M4A도 받을 수 있습니다. 날짜는 서울 시간 기준입니다.
6. **우리 집 주변**에서 7월 8일과 10월 11일의 UNOSAT 지도를 전환합니다. 지우에게는 **동네 피해 관측 · 우리 집 상태 미확인**이 표시되고, 상세 주소는 서연에게만 보입니다.
7. 본인이 남긴 기록 옆의 **휴지통 → 삭제**로 지웁니다. 삭제 전 확인창이 표시되며 다른 가족의 기록은 삭제할 수 없습니다. 오프라인 삭제는 기기에 먼저 반영되고, 작성자 계정으로 연결되면 서버에도 반영됩니다. 삭제 대기 중에는 내보내기를 막아 삭제한 기록이 파일에 포함되지 않도록 합니다. 이미 내려받은 파일은 지워지지 않습니다.

시연 계정은 `family-a@example.test`(서연), `family-b@example.test`(지우)이고 기본 비밀번호는 둘 다 `demo2026!`입니다. 기본 영상은 생성 이미지로 만든 3초 클립이며 기본 음성은 합성 한국어 음성입니다.

초대 흐름을 처음부터 시연하려면 서버를 시작하기 전에 새 `OURDAYS_DATA_DIR`을 지정하고 `OURDAYS_EMPTY_FAMILY=1`을 설정합니다. 서연이 가족 공간을 만든 뒤 가족 공간에서 초대 코드를 확인하고, 지우가 코드를 입력해 가입합니다.

## 다른 기기에서 접속

모바일 기기 두 대를 연결하려면 같은 서버를 브라우저가 신뢰하는 HTTPS 주소로 제공해야 합니다. Node.js에서 직접 제공할 경우 `HOST=0.0.0.0`, `OURDAYS_TLS_CERT`, `OURDAYS_TLS_KEY`를 설정합니다. 인증서의 호스트 이름과 휴대전화에서 여는 주소가 일치해야 합니다. HTTPS 리버스 프록시를 쓰는 경우 `OURDAYS_SECURE_COOKIE=1`과 `OURDAYS_ORIGIN`에 외부 HTTPS 주소를 설정합니다.

시연 PC 외부에 열기 전에 새 `OURDAYS_DATA_DIR`, `OURDAYS_DEMO=0`, 각기 다른 `OURDAYS_PASSWORD_A`와 `OURDAYS_PASSWORD_B`를 설정합니다. 비밀번호는 데이터 폴더를 처음 만들 때 적용됩니다.

## 코드 구성과 검증

- `public/app.js`: 화면과 촬영·녹음, 임시 미리보기, 보관·공유 선택
- `public/device.js`: IndexedDB에 기록, 캐시, 삭제 대기 정보 저장
- `public/record-sync.js`: 공유 동의 여부를 확인한 업로드와 삭제 재시도
- `public/sw.js`: 앱 파일을 캐시하는 서비스 워커
- `server/index.mjs`: 계정·가족 권한, 기록 API, 서버 저장과 삭제
- `server/media.mjs`: FFmpeg 변환·합치기, Whisper 음성 인식, 내보내기
- `public/home.js`, `server/home.mjs`: 관측 자료와 주소 공개 범위

프로젝트 폴더에서 다음 명령으로 로그인과 초대, 주소 접근 권한, 공유 동의, 삭제 권한·재시도·업로드 경합, 날짜순 조회 및 내보내기를 확인합니다. 미디어 테스트에는 FFmpeg와 FFprobe가 필요합니다.

```powershell
node --test server/api.test.mjs server/record-sync.test.mjs
```

## 외부 코드·도구·자료 출처

- **Node.js**: 서버 실행 환경과 기본 모듈을 사용합니다. [공식 사이트](https://nodejs.org/) · [소스와 라이선스](https://github.com/nodejs/node)
- **FFmpeg / FFprobe**: 미디어 길이 검사, 영상·음성 변환과 합치기에 사용합니다. Windows 설치 스크립트는 Gyan Doshi의 release essentials 빌드를 내려받습니다. 프로젝트 ZIP에는 실행 파일을 포함하지 않습니다. [FFmpeg](https://ffmpeg.org/) · [Gyan Windows 빌드](https://www.gyan.dev/ffmpeg/builds/) · [FFmpeg 라이선스 안내](https://ffmpeg.org/legal.html)
- **whisper.cpp v1.8.3**: 서버에서 녹음을 텍스트로 옮기는 실행 도구입니다. MIT 라이선스입니다. [소스](https://github.com/ggml-org/whisper.cpp) · [사용한 릴리스](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.8.3) · [라이선스](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE)
- **OpenAI Whisper 다국어 base 모델**: whisper.cpp용 `ggml-base.bin`을 사용합니다. 모델은 MIT 라이선스이며, 설치 스크립트가 파일 해시를 확인합니다. [원본 모델](https://github.com/openai/whisper) · [ggml 변환 모델](https://huggingface.co/ggerganov/whisper.cpp) · [다운로드 실패 시 사용하는 동일 해시의 미러](https://www.telestream.net/download-files/ggml/ggml-base.bin)
- **브라우저 기능**: `MediaRecorder`, `getUserMedia`, IndexedDB, Service Worker를 사용합니다. 별도 프런트엔드 프레임워크나 npm 라이브러리를 설치하지 않습니다.
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

- 오프라인에서는 기록과 저장을 할 수 있고, 가족에게 전달하려면 서버 연결이 돌아와야 합니다. 통신망 없이 다른 기기에 즉시 전송하는 기능은 없습니다.
- 앱을 닫은 동안의 업로드는 보장하지 않습니다. 연결 복구 후 앱을 열어 두거나 다시 열어야 합니다. 기기 저장소를 지우면 아직 업로드하지 않은 기록도 사라질 수 있습니다.
- 가족 접근 권한과 주소 공개 범위를 적용했지만 종단간 암호화는 구현하지 않았습니다. 현재 서버는 파일과 JSON을 로컬에 저장하는 해커톤 시연용 구성입니다.
- 음성 인식 결과는 틀릴 수 있어 수정 기능을 제공합니다. 실제 전쟁·피란 환경의 사용자 검증과 운영 검증은 아직 수행하지 않았습니다.
- 거주지 시연은 한 동네의 두 시점 자료를 비교하는 범위입니다. 자동으로 집을 식별하거나 실시간 피해를 판정하지 않습니다.

## 해커톤 참가·제출 정보

- 팀명: **한아님**
- 참가 형태: 개인 참가
- GitHub: [JeongHanAh/2026COM-s-Hackathon](https://github.com/JeongHanAh/2026COM-s-Hackathon)
- 발표 계획: 약 5분. 공식 소개 방식 투표 결과는 별도 확인합니다.
- 프로젝트를 해커톤 기간 안에 새로 시작했는지 개발 이력으로 확인합니다.
- 원본 개회식 자료의 제출 마감은 **2026년 11월 15일 일요일 04:00**이며, 이후 커밋은 평가에 반영되지 않습니다.
- GitHub에는 앱 소스와 이 README를 올리고, 실제 기록·주소가 들어 있는 `data`, `.qa-app-data`, 테스트 데이터와 `.tools`는 올리지 않습니다. `.gitignore`에 데이터·도구·환경 설정·인증서 제외 규칙을 두었습니다. 별도 경로에 만든 데이터도 게시 전에 확인합니다. 현재 제공 패키지는 도구와 모델을 처음 실행할 때 설치하는 구성입니다.


## 제출 자료

- [발표 자료](submission/01_발표자료.pptx)
- [프로젝트 계획서](submission/02_프로젝트_계획서.pdf)
- [소개 페이지](submission/소개페이지.html): 내려받아 브라우저에서 엽니다.
- [실행 파일 묶음](submission/our-days.zip)
