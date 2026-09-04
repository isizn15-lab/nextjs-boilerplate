# GitHub 데이터 연동 설정

이 설정은 일일 업무 보고서가 지정 GitHub 저장소의 당일 커밋과 이슈를 읽도록 연결합니다. 토큰은 브라우저가 아니라 서버 환경변수에만 저장합니다.

## 1. Fine-grained personal access token 만들기

1. GitHub에서 **Settings → Developer settings → Personal access tokens → Fine-grained tokens**로 이동합니다.
2. **Generate new token**을 선택합니다.
3. 만료일을 지정하고 **Repository access**에서 보고서에 연결할 저장소만 선택합니다.
4. **Repository permissions**를 다음과 같이 지정합니다.
   - Contents: Read-only
   - Issues: Read-only
   - Metadata: Read-only(자동 포함)
5. 토큰을 생성하고 안전한 곳에 한 번만 복사합니다.

조직 저장소는 조직 정책에 따라 관리자 승인 또는 SSO 승인이 추가로 필요할 수 있습니다.

## 2. 로컬 환경 연결

프로젝트 루트의 `.env` 또는 `.env.local`에 다음 두 줄을 추가합니다.

```dotenv
GITHUB_TOKEN=github_pat_실제_토큰
GITHUB_REPO=소유자/저장소명
```

연결 점검:

```powershell
npm run check:github
```

성공하면 저장소명과 `저장소 / 커밋 / 이슈 읽기` 검증 결과만 표시하며 토큰은 출력하지 않습니다.

## 3. Vercel 운영 환경 연결

Vercel 대시보드에서 **daily-report-app → Settings → Environment Variables**를 열고 Production 환경에 다음 값을 추가합니다.

| Name | Value | 환경 |
|---|---|---|
| `GITHUB_TOKEN` | 생성한 Fine-grained token | Production |
| `GITHUB_REPO` | `소유자/저장소명` | Production |

저장 후 현재 Production 배포를 **Redeploy**해야 새 환경변수가 적용됩니다.

CLI를 사용할 경우 프로젝트 폴더에서 아래 명령을 각각 실행하고, 화면에 값 입력 요청이 나타날 때 실제 값을 붙여넣습니다.

```powershell
vercel env add GITHUB_TOKEN production
vercel env add GITHUB_REPO production
vercel --prod
```

## 4. 최종 확인

1. 배포된 대시보드를 엽니다.
2. **지금 바로 실행**을 누릅니다.
3. 출처 카드가 `GH · 0건 (GitHub 미설정)` 대신 GitHub 조회 결과를 표시하는지 확인합니다.
4. 오늘 커밋이나 이슈가 없다면 연결이 정상이어도 `GH · 0건`일 수 있습니다. 이 경우 `npm run check:github` 결과와 저장소 접근 권한을 기준으로 판단합니다.

## 문제 해결

- `401 Bad credentials`: 토큰 오타, 만료 또는 폐기 여부를 확인합니다.
- `403 Resource not accessible`: Contents 또는 Issues 읽기 권한, 조직 승인을 확인합니다.
- `404 Not Found`: `GITHUB_REPO`의 소유자/저장소명과 토큰의 Repository access 대상을 확인합니다.
- 커밋은 있는데 0건: 앱은 `Asia/Seoul` 당일 00:00 이후 기록만 수집합니다.
- 이슈가 누락됨: Pull Request는 이슈 API 응답에서 의도적으로 제외합니다.

## 보안 규칙

- 실제 토큰을 `.env.example`, README, GitHub 커밋 또는 채팅에 입력하지 않습니다.
- `.env`, `.env.local`, `.vercel`은 `.gitignore`에 포함되어 있습니다.
- 토큰이 노출되면 즉시 GitHub에서 폐기하고 새 토큰으로 교체합니다.
# 업무 관련 기록만 보고서에 포함하기

- 보고서 표시에서는 `GitHub issue` 및 `[GitHub]` 출처 태그를 `이슈로그`로 변환합니다. 상단 GitHub 수집 카드의 서비스 구분은 유지합니다.
- 당일 수집된 `report:include` 이슈는 모두 필수 반영합니다. AI 출력에 번호와 전체 제목이 누락되면 서버가 원문 제목·번호·등록 상태를 보완합니다. 열림은 이슈 항목, 종료는 결과 항목에 보완하며 종료를 실제 완료로 단정하지 않습니다.

- 이슈: `report:include` 라벨을 붙인 이슈만 수집합니다. `report:exclude`가 함께 있으면 제외가 우선입니다.
- 라벨 없는 기존 이슈도 자동 제외됩니다. 기존 #4 등의 업무 이슈를 계속 보고하려면 `report:include`를 붙이세요.
- 커밋: 첫 줄이 `[report] `로 시작하는 메시지만 수집합니다. 예: `[report] 신청 중복 제출 방지 구현`.
- 현재 수집 시간 범위(당일 갱신 이슈·당일 커밋)와 제목·상태 중심 수집은 유지됩니다. 이슈 본문과 댓글은 AI 입력에 포함하지 않습니다.
- 제외한 제목과 본문은 GitHub 수집 결과·AI의 오늘 GitHub 입력에 전달하지 않습니다. 업무 여부를 AI가 임의 추측하는 방식이 아니라 사람이 라벨로 승인하는 방식입니다.
- 기존 보고서 이력은 수정하지 않습니다. 새 보고서를 생성해야 새 정책이 적용됩니다.
- `node scripts/seed-github-report-demo.js`는 실제 GitHub에 업무 2개/비업무 3개 샘플을 등록하는 명시적 실행 명령입니다. 같은 제목은 중복 생성하지 않습니다. 실행에는 Issues 쓰기 권한이 필요합니다.
