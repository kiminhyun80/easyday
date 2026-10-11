# Easyday

광고 없는 개인용 날짜 카운터 앱 (아이·나·친구·기념일 / 달력 메모 / 공휴일 / 문자 연동 / 시크릿).

## 깃허브 페이지에 올리기 (아이폰에서도 가능)

1. github.com 로그인 → 오른쪽 위 **+** → **New repository**
   - Repository name: `easyday` (아무 이름이나 OK)
   - **Public** 선택 → **Create repository**
2. 만들어진 저장소 화면에서 **uploading an existing file** 링크 클릭
   - 이 폴더의 파일 전부 선택해서 올림: `index.html`, `app.js`, `manifest.json`, `sw.js`, `icon-180.png`, `icon-192.png`, `icon-512.png`
   - 아래 **Commit changes** 클릭
3. 저장소 **Settings** → 왼쪽 **Pages**
   - Source: **Deploy from a branch**
   - Branch: **main** / **/(root)** → **Save**
4. 1~2분 뒤 같은 화면 위쪽에 주소가 뜸: `https://<아이디>.github.io/easyday/`

## 아이폰 홈 화면에 앱으로 추가

1. 사파리로 위 주소 열기
2. 아래 공유 버튼(네모+화살표) → **홈 화면에 추가**
3. 홈 화면의 Easyday 아이콘으로 실행 → 전체화면 앱처럼 동작

## 아는 사람에게 주기

주소만 보내면 됩니다. 각자 자기 폰에 데이터가 저장되고 서로 섞이지 않습니다.
(받는 사람도 위 "홈 화면에 추가"를 하면 앱처럼 씁니다.)

## 주의

- 데이터는 폰 안에만 저장됩니다. 폰을 바꾸기 전에 첫 화면 **⋯ → 백업 파일 내보내기**로 받아두고, 새 폰에서 **가져오기** 하세요.
- 시크릿 PIN을 잊으면 되찾을 수 없습니다.
- 공휴일 "3년치 갱신"은 인터넷이 필요합니다. 갱신 전에는 내장 데이터(2025~2028)를 씁니다.

## 공휴일 자동 갱신 (선택)

첫 화면 **⋯ → 공휴일 자동 갱신**에 둘 중 하나를 넣으면 구글 '대한민국의 휴일' 캘린더에서 올해~2년 뒤 공휴일을 받아오고, 이후 30일마다 자동 갱신됩니다.

- **방법 A (GAS, 추천)**: `gas-holiday-proxy.gs`를 script.google.com 새 프로젝트에 붙여넣고 웹 앱으로 배포(액세스: 모든 사용자) → `/exec` 주소 입력
- **방법 B (API 키)**: console.cloud.google.com → Google Calendar API 사용 설정 → 사용자 인증 정보 → API 키 만들기 → `AIza…` 키 입력

아이폰 캘린더 앱은 웹앱에서 읽을 수 없어 지원하지 않습니다.

## 음력

항목 편집의 날짜 칸에서 **양력/음력**을 고를 수 있습니다. 음력으로 저장하면 생일·주년이 매년 음력 날짜로 계산되고, 달력에는 음력 1일·15일이 작게 표시됩니다. (한국천문연구원 기준, 2050년까지)

## 수정하고 싶을 때

`app.js`는 빌드된 파일입니다. 원본은 `src/app.jsx`이고, 수정 후 `npm i korean-lunar-calendar` → `npx esbuild src/app.jsx --bundle --loader:.jsx=jsx --format=iife --minify > app.js` 로 다시 만듭니다. 또는 그냥 클로드에게 바꿔달라고 하면 됩니다.
