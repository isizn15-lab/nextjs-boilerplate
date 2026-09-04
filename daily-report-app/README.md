# AI 일일 업무 보고서 — 솔버톤 제출 소스

배포 URL: https://daily-report-app-rouge.vercel.app/

이 폴더가 일일 업무 보고서 앱의 소스입니다. 저장소 루트의 Next.js 기본 프로젝트와는 별개의 Node.js/Express 앱입니다. 상위 저장소의 이슈는 업무 기록 수집 예시로 활용합니다.

## 주요 기능

- GitHub·Notion 본문·Slack 기록 수집 및 AI 보고서 생성
- `report:include` GitHub 이슈 선별과 누락 보완, 일반적인 ‘이슈로그’ 명칭 사용
- 반복 이슈 탐지 및 이전 계획 대비 진행률 분석
- 최우선 처리 / 놓치기 쉬운 리스크 / 다음 단계 제안
- 대시보드, 실행 이력, Slack 게시

## 로컬 실행

Node.js 24 환경에서 이 폴더로 이동해 실행합니다.

```powershell
cd daily-report-app
npm ci
Copy-Item .env.example .env
# .env에 본인 서비스의 인증 정보 입력
npm start
```

http://localhost:3000 으로 접속합니다. 3000 포트가 사용 중이면 기존 실행을 확인하거나 `.env`의 PORT를 변경하세요. 토큰이나 실제 보고서 데이터는 커밋하지 마세요.

```powershell
npm test
npm run check:github
```

제출 준비 시 외부 API 없이 수행되는 테스트 14개가 통과했습니다. `check:tracking`은 실제 AI API를 사용하므로 비용이 발생할 수 있습니다. 실행 버튼은 AI API 호출과 Slack 게시를 수행할 수 있습니다.

## 배포

Vercel의 앱 Root Directory는 이 소스를 기준으로 `daily-report-app`입니다. Node.js/Express 구성과 이 폴더의 `vercel.json`을 사용합니다. 기존 루트 Next.js 프로젝트와 혼동하지 마세요. 이번 소스 게시 자체는 기존 서비스의 배포 연결 설정을 바꾸지 않습니다.

로컬은 node-cron 스케줄을 사용하고, Vercel은 `vercel.json`의 예약 호출을 사용합니다. 예약 설정은 UTC 기준 평일 09:00(한국 18:00)입니다. 실제 예약 사용 가능 여부는 배포 플랜과 환경 설정을 확인하세요. Vercel 이력 보존에는 Blob 연결과 필요한 환경변수 설정이 필요합니다.

## 보안 및 한계

- `.env*` 비밀 파일, 배포 인증 정보, 실제 보고서 이력은 제출 소스에 포함하지 않았습니다.
- `.env.example`에는 본인의 환경값을 입력해야 합니다.
- 현재 사용자 로그인·권한 관리 및 실행 중복 방지는 구현 완료 기능이 아닙니다. 공개 운영에는 추가 보완이 필요합니다.
- AI 추천은 확정 사실이 아니며 사람이 검토해야 합니다. ‘확인 불가’는 ‘미처리 확정’이 아닙니다.
- 반복 일수는 연속 보고일 기준입니다. 실제 절감 시간은 아직 측정하지 않았습니다.
- 공개 시연에는 가상 데이터만 사용하세요.

발표자료와 시연영상 링크는 업로드 후 추가할 예정입니다.
