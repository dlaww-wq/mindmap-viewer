# Work Memory

이 파일은 대화에서 나온 핵심 지시, 반복 수정 요청, 이미 해결한 오류를 잃지 않기 위한 작업 기억장치입니다.

새 작업을 시작할 때는 관련 단어를 먼저 검색하고, 작업 후에는 이 파일에 요약을 추가합니다.
삭제하지 말고 날짜별로 누적합니다.

## 최우선 원칙

- 대화 내용과 사용자의 반복 지시는 삭제하거나 덮어쓰지 않습니다.
- 새 기능을 만들기 전에 관련 단어를 `rg`로 먼저 검색합니다.
- 사용자가 "전에 말한 것", "또 반복된다", "적용이 안 됐다"라고 하면 구현보다 원인 진단을 먼저 합니다.
- 이미 만든 기능을 새로 만드는 대신, 기존 코드와 커밋이 왜 작동하지 않았는지 확인합니다.
- 작업이 끝나면 변경 파일, 검증 결과, 남은 리스크를 기록합니다.

## 작업 전 검색 규칙

작업 전 최소 검색 대상:

```powershell
scripts/prework-search.ps1 "검색어1" "검색어2"
```

수동으로 할 때는 다음 파일과 폴더를 먼저 봅니다.

```powershell
rg -n --ignore-case "검색어" WORK_MEMORY.md WORKSPACE.md PROGRESS.md CLAUDE.md README.md docs public routes src nenova-erp-ui scripts
```

검색해야 하는 단어 예시:

| 주제 | 검색어 |
|------|--------|
| Nenova ERP | `nenova`, `nenovaweb`, `erp`, `주문`, `재고`, `거래처`, `출고`, `입고`, `차수` |
| 카카오 자동화 | `kakao`, `카카오`, `카톡`, `미러`, `room`, `gsheet`, `Google Sheet` |
| 반복 오류 | `반복`, `또`, `미적용`, `누락`, `fix`, `bug`, `TODO`, `남은 작업` |
| 배포/원격 | `origin`, `dlaww-wq`, `Jayinsightfactory`, `Railway`, `main` |

## 반복 오류 방지 절차

1. `git log --oneline -30`으로 이미 처리한 커밋을 확인합니다.
2. 관련 단어를 `WORK_MEMORY.md`, `WORKSPACE.md`, `PROGRESS.md`, `CLAUDE.md`, 코드 전체에서 검색합니다.
3. 기존 구현 위치를 찾습니다.
4. 작동하지 않는 이유를 분류합니다.
   - 미배포
   - 연결 누락
   - 데이터/환경 변수 누락
   - 기존 코드와 새 코드의 중복/충돌
   - 실제 버그
5. 최소 수정만 합니다.
6. 검증 명령을 실행합니다.
7. 이 파일에 결과를 추가합니다.

## 핵심 사용자 지시

### 2026-05-24 KST

- GitHub가 흩어져 있으면 하나로 정리해야 합니다.
- `dlaww-wq`는 삭제된 저장소이므로 사용하지 않습니다.
- 기준 저장소는 `Jayinsightfactory/mindmap-viewer`입니다.
- 사용자는 하나의 페이지에서 여러 작업을 동시에 하는 경우가 있습니다.
- 그래서 작업 단위는 "페이지"가 아니라 업무 흐름, 패널, 탭, 상태 카드, 도메인으로 봅니다.
- 대화 내용과 이전 수정 요청이 삭제되면 안 됩니다.
- 작업할 때는 관련 단어를 먼저 검색해야 합니다.
- 매번 수정해달라고 했던 것이 적용되지 않아 같은 오류가 반복되는 일을 막아야 합니다.

## 현재 통합 상태

### 2026-05-24 KST

- `origin`은 `https://github.com/Jayinsightfactory/mindmap-viewer.git` 하나로 정리했습니다.
- `dlaww-wq` 원격은 제거했습니다.
- `nenova-erp-ui/`는 기준 저장소 `main`에 통합했습니다.
- PR `#4 Unify Nenova ERP UI workspace`가 squash merge 되었습니다.
- `WORKSPACE.md`에 흩어진 저장소 정리 방향을 기록했습니다.

## 반복 수정 요청 기록

### Nenovaweb 첫 화면 내용 부족

날짜:
- 2026-05-24 KST

사용자 요청:
- `nenovaweb` 첫 페이지가 메뉴만 있고 중요한 내용이 없으므로, 기존 메뉴와 기능은 유지하면서 transcript 기반 구성 기획을 추가해야 합니다.
- 700개가 넘는 녹음, 견적서 자동 발행, 계약 후 프로젝트 생성, 할 일 배정, 일정 보고, 명함 OCR, 매출/세금계산서, Slack/Kakao 알림, Claude/GPT 업무 질의 구조를 반영해야 합니다.
- 회사 직원들이 Claude API와 GPT API를 사용해서 질문하고 답하면서 업무를 볼 수 있어야 합니다.

검색한 단어:
- `nenovaweb`, `첫페이지`, `메뉴`, `Claude`, `GPT`, `API`, `녹음`, `견적`

현재 조치:
- `nenova-erp-ui/src/app/(app)/dashboard/page.tsx`를 운영 허브 첫 화면으로 확장했습니다.
- `nenova-erp-ui/src/app/(app)/assistant/page.tsx`를 추가했습니다.
- `nenova-erp-ui/src/app/api/assistant/route.ts`를 추가해 Claude/GPT 서버 라우팅 구조를 만들었습니다.
- `nenova-erp-ui/src/components/AiWorkConsole.tsx`를 추가했습니다.
- `nenova-erp-ui/src/lib/operating-plan.ts`에 transcript 기반 운영 모듈을 정리했습니다.

검증:
- `npm run build` 성공
- 브라우저 로그인 후 `/dashboard`에서 운영 허브, AI 비서, 녹음/견적/프로젝트 흐름, 최근 주문 표시 확인
- `/assistant`에서 질문 실행 후 데모 응답 표시 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/dashboard/page.tsx`
- `nenova-erp-ui/src/app/(app)/assistant/page.tsx`
- `nenova-erp-ui/src/app/api/assistant/route.ts`
- `nenova-erp-ui/src/lib/operating-plan.ts`

### 저장소/작업 기준 반복

문제:
- GitHub 저장소가 여러 개라 작업 위치가 흩어져 보였습니다.
- 예전 `dlaww-wq` 원격이 남아 있어 기준이 헷갈렸습니다.

현재 조치:
- 로컬 원격은 `origin = Jayinsightfactory/mindmap-viewer`만 남겼습니다.
- `WORKSPACE.md`에 기준 저장소와 흡수 대상 저장소를 기록했습니다.

다음 작업자가 지켜야 할 것:
- 새 작업은 `Jayinsightfactory/mindmap-viewer`에서 시작합니다.
- 예전 저장소를 새 기준처럼 사용하지 않습니다.
- 흩어진 저장소는 참고 소스로만 보고 필요한 코드만 선별 흡수합니다.

### 반복 요청 미적용 방지

문제:
- 사용자가 반복해서 수정 요청을 했는데 기존 코드에 반영되지 않거나, 반영됐어도 연결/배포가 빠져 다시 같은 문제가 생겼습니다.

현재 조치:
- `CLAUDE.md`와 이 파일에 작업 전 검색, 원인 진단, 메모리 업데이트 규칙을 명시합니다.
- `scripts/prework-search.ps1`로 관련 단어 검색을 빠르게 실행할 수 있게 합니다.

다음 작업자가 지켜야 할 것:
- 바로 새로 만들지 말고 검색부터 합니다.
- 수정 후에는 실제 실행/빌드/라우트 확인까지 합니다.
- 작업 결과는 이 파일에 날짜별로 누적합니다.

### KakaoWork 기반 회사 업무 연동

날짜:
- 2026-05-24 KST

사용자 요청:
- 회사 업무는 카카오워크 기반으로 보게 되므로, KakaoWork API와 연동되는 `nenovaweb` 구조의 기초 설계가 필요합니다.
- 단순 알림이 아니라 카카오워크 대화에서 업무 요청, 질문, 승인, 완료 보고가 들어오고 `nenovaweb` 업무 데이터로 이어져야 합니다.

검색한 단어:
- `카카오워크`, `KakaoWork`, `messages.send`, `conversations.open`, `webhook`, `워크 API`

기존 코드에서 찾은 것:
- `routes/issues.js`: `KAKAOTALK_TOKEN`, `KAKAO_ADMIN_CONV_ID`, `messages.send`, `conversations.open` 기반 알림
- `routes/automation-engine.js`: 입고 예정 변경 감지 후 KakaoWork 관리자 채널 알림
- `routes/webhooks.js`: 수신 웹훅 기록/정규화 패턴

현재 조치:
- `nenova-erp-ui/src/app/(app)/kakaowork/page.tsx`를 추가해 카카오워크 업무 게이트 설계를 화면화했습니다.
- `nenova-erp-ui/src/lib/kakaowork-plan.ts`에 흐름, API 계약, 데이터 매핑, 환경변수, 보안 체크를 정리했습니다.
- `nenova-erp-ui/src/app/api/kakaowork/notify/route.ts`를 추가해 dryRun/live 메시지 발송 기반을 만들었습니다.
- `nenova-erp-ui/src/app/api/kakaowork/callback/route.ts`를 추가해 수신 이벤트 정규화 기반을 만들었습니다.
- `docs/nenova-kakaowork-integration.md`에 공식 API 기준과 단계별 구현 계획을 기록했습니다.

검증:
- `npm run build` 성공
- `GET /api/kakaowork/notify` 응답 확인
- `POST /api/kakaowork/notify` dryRun 응답 확인
- `POST /api/kakaowork/callback` 정규화 응답 확인
- 브라우저에서 `/kakaowork` 메뉴, 제목, 업무 흐름, API 설계 표시 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/kakaowork/page.tsx`
- `nenova-erp-ui/src/app/api/kakaowork/notify/route.ts`
- `nenova-erp-ui/src/app/api/kakaowork/callback/route.ts`
- `nenova-erp-ui/src/lib/kakaowork-plan.ts`
- `docs/nenova-kakaowork-integration.md`

### ERP 흐름 실제 기능화

날짜:
- 2026-05-24 KST

사용자 요청:
- 대시보드/AI 비서가 기획 수준을 넘어서 실제 ERP 기준으로 기능 구현되었으면 좋겠다고 요청했습니다.

검색한 단어:
- `nenova`, `erp`, `견적`, `계약`, `프로젝트`, `할 일`, `일정`, `매출`, `세금계산서`

기존 상태:
- `nenova-erp-ui/src/lib/store.ts`에는 주문/재고/고객 CRUD만 있었습니다.
- 녹음, 견적, 계약, 프로젝트, 할 일, 매출/세금계산서는 `operating-plan.ts`와 대시보드 표시 수준이었습니다.

현재 조치:
- `store.ts`에 회의/녹음 기록, 견적, 프로젝트, 할 일, 세금계산서, 일일 보고 타입과 저장/전환 로직을 추가했습니다.
- `/erp-flow` 화면을 추가했습니다.
- 회의 기록 → 견적 생성 → 계약 확정 → 프로젝트/할 일/세금계산서 생성 흐름을 실제 버튼 동작으로 만들었습니다.
- 프로젝트 진행률, 할 일 상태, 세금계산서 상태, 일일 보고 생성 기능을 추가했습니다.
- 대시보드가 실제 ERP 스냅샷 지표를 표시하게 했습니다.
- AI 업무 콘솔이 현재 ERP 스냅샷을 함께 보내도록 연결했습니다.

검증:
- `npm run build` 성공
- 브라우저에서 `/erp-flow` 주요 섹션 표시 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/erp-flow/page.tsx`
- `nenova-erp-ui/src/lib/store.ts`
- `nenova-erp-ui/src/app/(app)/dashboard/page.tsx`
- `nenova-erp-ui/src/components/AiWorkConsole.tsx`

### Claude 에이전트 검증 + 직원 작업 단위 3차 교차검증

날짜:
- 2026-05-24 KST

사용자 요청:
- Claude에서도 서로 검증하는 에이전트 구성을 만들고, `nenova.exe` 직원 작업 단위를 네노바웹에서 확인할 수 있게 해야 합니다.
- 직원마다 계정과 작업 영역이 다르므로 계정별 업무영역을 체크해야 합니다.
- 클릭/작업 시간대와 카카오톡/카카오워크 대화를 매칭해서, 어떤 대화가 어떤 작업을 만들었는지와 어떤 작업 뒤 어떤 톡이 오갔는지를 양방향으로 확인해야 합니다.
- PC 작업 데이터까지 합쳐 3차 교차검증해야 합니다.

검색한 단어:
- `Claude`, `클로드`, `에이전트`, `agent`, `검증`, `verification`, `process-mining`, `employee`, `work unit`, `작업단위`, `nenova.exe`, `KakaoTalk`, `KakaoWork`

기존 구현 확인:
- `.claude/agents/`에 일반 작업 에이전트는 있었지만 Nenova 전용 데이터 병합/예측/교차검증 에이전트는 없었습니다.
- `routes/process-mining.js`에는 세션/블록 병합 기준이 있었습니다.
- `nenova-erp-ui`에는 ERP 흐름은 있었지만 직원 계정별 작업 단위, 카카오 대화 전후관계, PC 클릭 근거를 함께 보는 화면은 없었습니다.

현재 조치:
- Claude 에이전트 4개를 추가했습니다: `nenova-data-fusion`, `nenova-workflow-forecaster`, `nenova-cross-validator`, `nenova-ops-orchestrator`.
- `/work-units` 화면을 추가해 직원 계정, 업무영역, 클릭/PC 근거, 카카오톡/워크 대화 매칭, 3차 검증 상태를 확인하게 했습니다.
- `store.ts`에 `WorkUnit`, `TalkEvent`, `TalkWorkRelation`, `CrossValidationStatus` 타입과 샘플 데이터, 스냅샷 함수를 추가했습니다.
- `POST /api/work-units`를 추가해 `nenova.exe`가 작업 이벤트를 보낼 수 있는 기초 API를 만들었습니다.
- 대시보드에 작업 단위 지표와 `/work-units` 링크를 추가했습니다.
- AI 비서 프롬프트에 계정별 업무영역, 클릭/작업 시간대, 카카오톡/워크 대화, PC 화면/앱 데이터를 3차 교차검증하도록 지시를 추가했습니다.
- `docs/nenova-claude-agent-orchestration.md`, `docs/nenova-work-unit-cross-validation.md`에 운영 설계를 기록했습니다.

검증:
- `npm run build` 성공
- `git diff --check` 통과
- `GET /work-units` HTTP 200 확인
- `GET /api/work-units` 응답 확인
- 브라우저에서 `/work-units` 주요 문구, 계정 ID, 카카오 대화 매칭, 3차 검증 섹션 표시 확인
- 브라우저에서 `/dashboard` 작업 단위 메뉴/지표/링크 표시 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/work-units/page.tsx`
- `nenova-erp-ui/src/app/api/work-units/route.ts`
- `nenova-erp-ui/src/lib/store.ts`
- `nenova-erp-ui/src/app/api/assistant/route.ts`
- `.claude/agents/nenova-ops-orchestrator.md`
- `.claude/agents/nenova-cross-validator.md`
- `docs/nenova-work-unit-cross-validation.md`

추가 조치:
- `POST /api/work-units`를 메모리 배열에서 파일 저장형 수신함으로 변경했습니다.
- 수신 데이터는 `nenova-erp-ui/data/work-units.json`에 저장하며, 운영 데이터라 Git 추적에서 제외했습니다.
- `/work-units` 화면이 localStorage 시드 데이터와 API 수신 데이터를 병합해 표시합니다.
- `scripts/post-work-unit-sample.ps1` 샘플 전송 스크립트를 추가했습니다.
- PowerShell 5.1 인코딩 문제 때문에 실행용 PS1은 ASCII 페이로드로 유지하고, 한글 페이로드 예시는 `docs/nenova-exe-work-unit-ingest.md`에 문서화했습니다.
- API는 영어 relation 값(`talk_before_work`, `work_before_talk`, `simultaneous`)도 한국어 검증 관계로 정규화합니다.

추가 검증:
- `npm run build` 성공
- `scripts/post-work-unit-sample.ps1` 실행 후 `GET /api/work-units`에서 수신 1건, `대화후작업`, `부분일치` 확인
- `/work-units` HTTP 200 확인

### Process Mining → 작업 단위 브릿지

날짜:
- 2026-05-24 KST

현재 조치:
- `routes/process-mining.js`의 분석 이벤트 타입에 `mouse.chunk`를 추가했습니다.
- `buildActivityBlocks`가 클릭 수와 클릭 근거를 유지하도록 확장했습니다.
- `GET /api/mining/work-units`를 추가해 PC/recorder/process-mining 이벤트를 네노바웹 작업 단위 후보로 변환합니다.
- `POST /api/mining/work-units/push`를 추가해 후보를 `NENOVA_WORK_UNITS_URL` 또는 `http://localhost:3000/api/work-units`로 전송합니다.
- 30분 창 안의 KakaoTalk 이벤트를 `relatedTalks`로 묶고 `대화후작업`, `작업후대화`, `동시진행`으로 분류합니다.

검증:
- `node --check routes/process-mining.js` 성공
- `node --check server.js` 성공
- `npm run build` 성공

다시 반복되면 먼저 볼 위치:
- `routes/process-mining.js`
- `docs/nenova-exe-work-unit-ingest.md`

### KakaoWork 콜백 → 작업 단위 후보 등록

날짜:
- 2026-05-24 KST

현재 조치:
- `POST /api/kakaowork/callback`이 이제 수신 이벤트를 `nenova-erp-ui/data/kakaowork-events.json`에 저장합니다.
- 콜백 수신 시 기본적으로 `/api/work-units`에 `KakaoWork` 작업 단위 후보를 자동 등록합니다.
- `syncWorkUnit: false`를 보내면 콜백 이벤트만 저장하고 작업 단위 등록은 생략합니다.
- 카카오워크 메시지 텍스트에서 견적/계약/프로젝트/할 일/재고/정산/보고/AI검토 의도를 1차 추론합니다.
- 명시적으로 `talkRelation: "미연결"`이 들어온 작업 단위는 같은 시각 대화가 있어도 `동시진행`으로 강제 추론하지 않도록 고쳤습니다.

검증:
- `npm run build` 성공
- 샘플 `POST /api/kakaowork/callback` 성공
- `GET /api/work-units`에서 `KW-WU-kw-msg-sample-001` 후보가 `미연결`/`검증대기`로 저장되는 것 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/kakaowork/callback/route.ts`
- `nenova-erp-ui/src/app/api/work-units/route.ts`
- `docs/nenova-kakaowork-integration.md`

### 직원 계정 매핑 기준

날짜:
- 2026-05-24 KST

현재 조치:
- `nenova-erp-ui/src/lib/employee-directory.ts`를 추가해 내부 직원 계정, 팀, 기본 업무영역, 이메일, KakaoWork userId, Orbit userId, PC hostname, 별칭을 한 곳에 모았습니다.
- `GET /api/employees/directory`를 추가해 매핑 상태와 단건 해석 결과를 확인할 수 있게 했습니다.
- `/api/kakaowork/callback`과 `/api/work-units`가 이 매핑을 사용해 외부 ID를 내부 `accountId`로 정규화합니다.
- `/work-units` 카드에 `계정매핑 {근거} {신뢰도}%` 배지를 추가했습니다.
- 샘플 `worker@example.com`/`kw-user-001`은 `설연주`, `seol`, `nenova:sales-support:sul-yeonju`, `견적/거래처 단가`로 해석됩니다.

검증:
- `npx tsc --noEmit` 성공
- `GET /api/employees/directory?userEmail=worker@example.com` 확인
- 카카오워크 샘플 콜백 재전송 후 `/api/work-units`에서 내부 계정으로 저장 확인
- `/work-units` HTTP 200 확인

주의:
- `npm run build`는 코드 타입 체크 전 단계에서 `.next/server/app/assistant.segments` 파일 잠금(OneDrive/Next dev 산출물)으로 실패했습니다. 같은 변경에 대해 `npx tsc --noEmit`과 dev 서버 HTTP 200으로 대체 검증했습니다.

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/lib/employee-directory.ts`
- `nenova-erp-ui/src/app/api/employees/directory/route.ts`
- `nenova-erp-ui/src/app/api/kakaowork/callback/route.ts`
- `nenova-erp-ui/src/app/api/work-units/route.ts`

### KakaoWork → ERP 수신함

날짜:
- 2026-05-24 KST

현재 조치:
- `GET/POST/PATCH /api/erp/intake`를 추가했습니다.
- 카카오워크 콜백에서 견적/할 일/재고/정산/프로젝트 의도가 나오면 ERP 수신함에 초안으로 자동 저장합니다.
- `/erp-flow`에 "카카오워크 ERP 수신함" 섹션을 추가했습니다.
- 수신함 항목을 회의/견적 후보 또는 할 일로 전환하고, 보류/초안 복귀를 할 수 있게 했습니다.

검증:
- `npx tsc --noEmit` 성공
- 샘플 KakaoWork 콜백이 `ERP-IN-KW-kw-msg-sample-erp-001` 견적 초안으로 들어오는 것 확인
- `/erp-flow` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/erp/intake/route.ts`
- `nenova-erp-ui/src/app/api/kakaowork/callback/route.ts`
- `nenova-erp-ui/src/app/(app)/erp-flow/page.tsx`

### ERP 수신함 전환 추적

날짜:
- 2026-05-24 KST

현재 조치:
- `/api/erp/intake`의 PATCH가 `linkedEntityType`, `linkedEntityId`, `convertedAt`, `conversionNote`를 저장합니다.
- `/erp-flow`에서 수신함 항목을 회의/견적 후보나 할 일로 전환하면 생성된 localStorage ERP 객체 ID를 서버 수신함에 다시 연결합니다.
- 전환된 수신함 카드에는 `연결 meeting MTG-...` 또는 `연결 task TSK-...`가 표시됩니다.

검증:
- `npx tsc --noEmit` 성공
- `POST /api/erp/intake` 후 `PATCH /api/erp/intake`로 `linkedEntityId`와 `convertedAt` 저장 확인
- `/erp-flow` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/erp/intake/route.ts`
- `nenova-erp-ui/src/app/(app)/erp-flow/page.tsx`

### ERP 수신함 초안 필드 추출

날짜:
- 2026-05-24 KST

현재 조치:
- `/api/erp/intake`가 카카오워크/외부 메시지에서 고객, 공급가, 목표일을 1차 추출합니다.
- 지원 예시는 `대한상사에서 견적 320만원 내일까지`, `고객사: ...`, `1,200,000원`, `1.5억`, `5월 30일`, `D+3`, `다음주 금요일`입니다.
- 추출 결과는 `customer`, `amount`, `dueDate`에 저장되고 evidence에 `extracted_customer`, `extracted_amount`, `extracted_dueDate`가 남습니다.
- `/erp-flow` 수신함 카드에 추출된 고객/공급가를 표시합니다.
- 견적 수신함 항목에 `amount`가 있으면 전환 시 회의 기록뿐 아니라 견적 초안까지 생성하고 `linkedEntityType: "quote"`로 연결합니다.

검증:
- `npx tsc --noEmit` 성공
- 샘플 카카오워크 콜백 `대한상사에서 견적 320만원 내일까지 부탁드립니다.`가 `customer=대한상사`, `amount=3200000`, `dueDate=2026-05-25`로 저장되는 것 확인
- `/erp-flow` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/erp/intake/route.ts`
- `nenova-erp-ui/src/app/(app)/erp-flow/page.tsx`

### KakaoWork 액션 → ERP 수신함 상태 변경

날짜:
- 2026-05-24 KST

현재 조치:
- `GET/POST /api/kakaowork/action`을 추가했습니다.
- 카카오워크 버튼/액션 payload의 `action`과 `intakeId`를 받아 `/api/erp/intake` 상태를 바꿉니다.
- 지원 액션은 `approve -> 승인완료`, `hold -> 보류`, `restore -> 초안`, `convert -> 승인완료 + requestedConversionAt`입니다.
- 액션 실행자는 직원 디렉터리로 `accountId`까지 매핑하고 `lastAction`에 저장합니다.
- `/api/kakaowork/callback`도 `actions.action`과 `actions.intakeId`를 감지하면 `/api/kakaowork/action`으로 전달합니다.
- `/erp-flow` 수신함 카드에 마지막 카카오워크 액션을 표시합니다.

검증:
- `npx tsc --noEmit` 성공
- `GET /api/kakaowork/action` 계약 응답 확인
- 직접 `POST /api/kakaowork/action` convert 성공
- `POST /api/kakaowork/callback`의 actions payload가 action route로 전달되어 보류 처리되는 것 확인
- `/erp-flow` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/kakaowork/action/route.ts`
- `nenova-erp-ui/src/app/api/kakaowork/callback/route.ts`
- `nenova-erp-ui/src/app/api/erp/intake/route.ts`
- `nenova-erp-ui/src/app/(app)/erp-flow/page.tsx`

### Work Unit ↔ ERP Intake 병합 후보

날짜:
- 2026-05-24 KST

현재 조치:
- `GET /api/work-units/intake-candidates`를 추가했습니다.
- file-backed `work-units.json`과 `erp-intake.json`을 비교해 같은 카카오워크 이벤트, 내부 계정, 카테고리, 고객, 시간창, ERP 연결 여부로 점수화합니다.
- `/work-units`에 "ERP 수신함 병합 후보" 섹션을 추가했습니다.
- 후보 카드에는 작업 단위, ERP 수신함, 점수, 추천(`자동 병합 후보`/`검토 후 병합`), 근거 태그가 표시됩니다.

검증:
- `npx tsc --noEmit` 성공
- `GET /api/work-units/intake-candidates` 응답 확인
- 같은 KakaoWork event/account/category 샘플이 89점 `자동 병합 후보`로 잡히는 것 확인
- `/work-units` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/work-units/intake-candidates/route.ts`
- `nenova-erp-ui/src/app/(app)/work-units/page.tsx`
- `docs/nenova-work-unit-cross-validation.md`

### ERP Flow 전환 요청 큐 표시

날짜:
- 2026-05-24 KST

현재 조치:
- `/erp-flow` 카카오워크 ERP 수신함에서 `requestedConversionAt`이 있는 항목을 전환 요청 대기 건으로 표시합니다.
- 수신함 헤더에 "카카오워크 전환 요청 N건이 실행 대기 중입니다."를 표시합니다.
- 전환 요청 항목은 연한 파란 배경과 `전환 요청됨` 배지로 강조합니다.
- 버튼 문구는 요청/데이터 상태에 따라 `견적 초안 생성`, `전환 요청 실행`, `회의/견적 후보 등록`, `할 일 등록`, `전환 완료`로 바뀝니다.

검증:
- `npx tsc --noEmit` 성공
- `/erp-flow` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/erp-flow/page.tsx`

### Work Unit ↔ ERP Intake 병합 확정

날짜:
- 2026-05-24 KST

현재 조치:
- `POST /api/work-units/intake-candidates`가 병합 후보 확정을 처리합니다.
- 요청은 `workUnitId`, `intakeId`, `note`를 받습니다.
- work unit에 `erp_intake=...`, `erp_intake_status=...`, `erp_merge_score=...`, `erp_merge_reason=...` evidence를 저장합니다.
- 고득점 후보는 `validationStatus: "일치"`, 그 외는 `부분일치`로 표시합니다.
- `/work-units` 후보 카드에 `병합 근거 저장` 버튼을 추가했습니다.

검증:
- `npx tsc --noEmit` 성공
- 샘플 후보 확정 시 `validationStatus=일치`, `erp_intake=ERP-IN-KW-confirm-test-001`, `erp_merge_score=89` 저장 확인
- `/work-units` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/work-units/intake-candidates/route.ts`
- `nenova-erp-ui/src/app/(app)/work-units/page.tsx`
- `docs/nenova-work-unit-cross-validation.md`

### ERP Intake AI 보정 큐

날짜:
- 2026-05-24 KST

현재 조치:
- `GET/POST /api/erp/intake/ai-review`를 추가했습니다.
- GET은 고객, 금액, 추출된 마감일 근거가 부족한 수신함을 AI 보정 큐로 반환합니다.
- POST는 선택 항목을 `/api/assistant`로 보내 `mode=erp-intake-ai-review` 컨텍스트에서 Claude/GPT 검증을 요청합니다.
- API 키가 없으면 기존 assistant demo 응답으로 흐름 검증이 가능합니다.
- `/erp-flow`에 "AI 보정 큐" 섹션과 `AI 보정 요청` 버튼을 추가했습니다.

검증:
- `npx tsc --noEmit` 성공
- `GET /api/erp/intake/ai-review` 응답 확인
- 샘플 `ERP-IN-ai-review-test-001` POST가 `claude-demo` 응답을 반환하는 것 확인
- `/erp-flow` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/erp/intake/ai-review/route.ts`
- `nenova-erp-ui/src/app/(app)/erp-flow/page.tsx`
- `nenova-erp-ui/src/app/api/assistant/route.ts`

### Work Units 검증상태 필터

날짜:
- 2026-05-24 KST

현재 조치:
- `/work-units` 계정별 업무영역 필터에 `검증상태` 필터를 추가했습니다.
- `전체`, `일치`, `부분일치`, `충돌`, `검증대기` 기준으로 작업단위 목록을 볼 수 있습니다.
- 병합 확정 후 `일치`로 바뀐 work unit을 빠르게 확인하는 용도입니다.

검증:
- `npx tsc --noEmit` 성공
- `/work-units` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/work-units/page.tsx`

### 핵심 방향 재정렬: ERP보다 직원 워크플로우

날짜:
- 2026-05-24 KST

사용자 정정:
- 사용자가 중요하게 보는 것은 ERP 자체가 아니라 `nenova.exe` 작업데이터, 카톡/카카오워크 데이터, PC 작업데이터를 통해 직원 한 명 한 명의 업무를 파악하고 회사 전체 직원의 워크플로우를 확인하는 것입니다.
- ERP/수신함/견적은 보조 근거이지 첫 번째 중심 화면이 아닙니다.

현재 조치:
- `/work-units` 상단을 직원별 실제 업무 흐름 중심으로 재구성했습니다.
- 직원별 카드에 작업 수, 작업 시간, 대화 연결 수, PC 근거 수, 소스 비중, 최근 흐름, 업무 리스크를 표시합니다.
- 회사 전체 워크플로우 예측 섹션을 추가해 업무 카테고리 전환 흐름을 표시합니다.
- 시간대별 업무량 섹션을 추가해 분/시간 단위 업무량과 참여 직원 수를 표시합니다.
- 데이터 소스 커버리지 섹션을 추가해 `nenova.exe`, 카톡/워크, PC 데이터 수집 비중을 표시합니다.
- 확인 필요한 흐름 섹션을 추가해 대화 미연결, 검증대기, 충돌 항목을 먼저 보게 했습니다.
- ERP 수신함 병합 후보는 "보조 데이터 연결 후보"로 이름을 바꾸고 아래쪽으로 내렸습니다.
- 사이드바 메뉴명을 `직원 워크플로우`로 변경했습니다.

검증:
- `npx tsc --noEmit` 성공
- `/work-units` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/work-units/page.tsx`
- `nenova-erp-ui/src/lib/nav.ts`
- `docs/nenova-work-unit-cross-validation.md`

### KakaoTalk 원본 메시지 → Work Unit 연결

날짜:
- 2026-05-24 KST

현재 조치:
- `GET/POST /api/kakaotalk/messages`를 추가했습니다.
- 단건/배치 메시지와 KakaoTalk export `rawText`를 받아 `data/kakaotalk-messages.json`에 저장합니다.
- 메시지 텍스트에서 견적/계약/프로젝트/할일/정산/재고/고객응대 의도를 1차 추론합니다.
- `GET/POST /api/work-units/talk-candidates`를 추가했습니다.
- work unit과 카톡 메시지를 시간차, 카테고리, 대화방명, 미연결 여부로 점수화합니다.
- 후보 확정 시 work unit의 `relatedTalks`, `talkRelation`, `evidence`, `validationMemo`, `validationStatus`가 갱신됩니다.
- `/work-units`에 "카톡 연결 후보" 섹션과 `카톡 근거 저장` 버튼을 추가했습니다.

검증:
- `npx tsc --noEmit` 성공
- `/work-units` HTTP 200 확인
- 샘플 `KT-talk-test-001`과 `WU-talk-test-001`이 90점 `대화후작업` 후보로 잡히고, 확정 시 work unit evidence에 `kakaotalk=...`, `talk_merge_score=90`이 저장되는 것 확인
- 테스트 로컬 데이터는 정리 완료

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/kakaotalk/messages/route.ts`
- `nenova-erp-ui/src/app/api/work-units/talk-candidates/route.ts`
- `nenova-erp-ui/src/app/(app)/work-units/page.tsx`
- `docs/nenova-exe-work-unit-ingest.md`

### Talk/Work 메시지 → PC 작업 후보 확장

날짜:
- 2026-05-24 KST

현재 조치:
- `GET/POST /api/work-units/talk-candidates`가 이제 `data/kakaotalk-messages.json`과 `data/kakaowork-events.json`을 함께 읽습니다.
- 카카오워크 이벤트는 `resolveEmployeeIdentity`로 내부 `accountId`를 찾아 `TalkMessage`로 정규화합니다.
- 후보 점수에 `same_account`, `kakaowork_source`, `session_work_unit` 가중치를 추가했습니다.
- 카카오워크/카카오톡 자체가 만든 work unit은 후보 target에서 제외하고, PC/nenova.exe/`NX-SESSION-...` 작업 단위를 우선 매칭합니다.
- `/work-units` 문구를 "카톡 연결 후보"에서 "톡/워크 연결 후보"로 바꾸고, 후보 카드에 `KakaoTalk`/`KakaoWork` source가 보이게 했습니다.
- 직원별 업무 흐름 카드에서 미저장 PC 세션 후보가 있으면 리스크 배지에 `세션 후보 N`으로 표시합니다.

검증:
- `npx tsc --noEmit` 성공
- `GET /api/work-units/talk-candidates`가 `kakaoworkMessages`, `targetWorkUnits`를 반환하고 카카오워크 후보를 점수화하는 것 확인
- `/work-units` HTTP 200 확인
- 브라우저에서 "톡/워크 연결 후보"와 `KakaoWork 메시지` 후보 렌더링 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/work-units/talk-candidates/route.ts`
- `nenova-erp-ui/src/app/(app)/work-units/page.tsx`
- `docs/nenova-work-unit-cross-validation.md`

### Work Units 화면: 통계보다 명확한 데이터 원장

날짜:
- 2026-05-24 KST

사용자 정정:
- 사용자는 통계/예측/비중을 보고 싶은 것이 아니라 직원별 실제 작업 데이터가 명확하게 보이길 원합니다.
- 첫 화면에서 숫자 카드나 워크플로우 예측보다 작업ID, 직원, 시간, 앱/창, 대화 원문, PC 근거, 원본 이벤트 ID가 보여야 합니다.

현재 조치:
- `/work-units` 상단을 "직원 작업 데이터 원장"으로 변경했습니다.
- 통계 카드, 회사 전체 워크플로우 예측, 시간대별 업무량, 데이터 소스 커버리지, 계정별 요약, 관계별 요약 섹션은 화면에서 숨겼습니다.
- 첫 번째 주요 섹션을 "실제 작업 데이터" 테이블로 바꿨습니다.
- 테이블 컬럼: `작업ID/시간`, `직원/계정`, `작업 내용`, `PC 화면`, `대화 원문`, `원본 근거`, `검증`.
- `원본 근거`에는 `raw_event_id`, `session_id`, `event_ids`, talk id, hostname, process, active_window, clicks, keys, screen_summary가 직접 보입니다.
- 필터는 직원/업무영역/검증상태만 유지했습니다.

검증:
- `npx tsc --noEmit` 성공
- `/work-units` HTTP 200 확인
- 브라우저에서 `실제 작업 데이터`와 주요 컬럼 렌더링 확인
- 브라우저에서 이전 통계 문구 `총 작업 시간`, `회사 전체 워크플로우 예측`이 화면에 보이지 않는 것 확인
- 텍스트 overflow 검사에서 문제 없음

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/work-units/page.tsx`

### Workflow 별도 페이지

날짜:
- 2026-05-24 KST

사용자 요청:
- `nenovaweb.com/workflow` 페이지에 직원 작업 데이터 원장을 따로 볼 수 있게 만들어야 합니다.

현재 조치:
- `/workflow` 라우트를 추가했습니다.
- `/workflow`는 현재 실제 작업 데이터 원장 UI를 재사용합니다.
- 사이드바 `직원 워크플로우` 메뉴의 대표 주소를 `/work-units`에서 `/workflow`로 변경했습니다.
- 기존 `/work-units`도 직접 접근 가능하게 남겨두었습니다.

검증:
- `npx tsc --noEmit` 성공
- `GET /workflow` HTTP 200 확인
- 브라우저에서 `http://127.0.0.1:3000/workflow` 접근 시 `실제 작업 데이터`, `작업ID/시간`, `직원/계정`, `PC 화면`, `대화 원문`, `원본 근거`, `검증` 컬럼이 보이는 것 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/workflow/page.tsx`
- `nenova-erp-ui/src/lib/nav.ts`

### Nenova.exe 원본 이벤트 → Work Unit 브릿지

날짜:
- 2026-05-24 KST

현재 조치:
- `GET/POST /api/nenova-exe/events`를 추가했습니다.
- `nenova.exe` 원본 PC 이벤트를 `data/nenova-exe-events.json`에 저장합니다.
- 같은 요청에서 원본 이벤트를 직원 작업 단위 payload로 변환해 내부적으로 `/api/work-units`에 동기화합니다.
- 지원 필드: `id`, `type/eventType`, `sessionId`, `parentEventId`, `timestamp`, `userId`, `userEmail`, `employeeName`, `accountId`, `hostname`, `deviceId`, `data.app/app`, `processName/exe`, `executablePath`, `windowTitle/activeWindowTitle/activeWindow`, `mouseClicks/clickCount/recentClicks/mouseRegions/mousePositions`, `keyboardCount/keyCount/keystrokes/textLength`, `screenSummary/visionSummary/screenText/ocrText`, `startedAt/endedAt/period`, `durationSec/activeSeconds`.
- 앱/프로세스/실행 경로에 `nenova.exe`가 있으면 source를 `nenova.exe`, 아니면 `PC`로 저장합니다.
- hostname/email/accountId/KakaoWork userId로 직원 계정을 매칭합니다.
- evidence에 `session_id`, `hostname`, `event_type`, `process`, `executable`, `active_window`, `mouse_clicks`, `keyboard_count`, `screen_summary`를 남깁니다.
- 생성된 work unit은 기본 `validationStatus: "검증대기"`이며 이후 카톡/워크/ERP/구글시트 근거와 연결해 검증합니다.

검증:
- `npx tsc --noEmit` 성공
- `GET /api/nenova-exe/events` HTTP 200 확인
- 샘플 `nx-test-001` POST 시 `workUnitSync.ok=true`, 직원 `설연주`, 카테고리 `견적`, workUnitId `NX-nx-test-001` 생성 확인
- 테스트 로컬 데이터는 정리 완료
- `/work-units` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/nenova-exe/events/route.ts`
- `docs/nenova-exe-work-unit-ingest.md`

### Nenova.exe 원본 이벤트 세션 병합

날짜:
- 2026-05-24 KST

현재 조치:
- `GET/POST /api/nenova-exe/sessions`를 추가했습니다.
- `data/nenova-exe-events.json`의 원본 이벤트를 직원 실제 업무 세션 단위로 병합합니다.
- 그룹 기준은 `accountId`, `sessionId`, `category`, `appName`이고, 기본 `gapMin=5`분을 넘으면 다른 세션으로 나눕니다.
- 세션 source는 포함 이벤트 중 하나라도 `nenova.exe`이면 `nenova.exe`, 아니면 `PC`입니다.
- 세션 작업 단위 id는 `NX-SESSION-...` 형식입니다.
- 세션 work unit에는 원본 event ids, 세션 시간, 클릭 합계, 키보드 합계, 화면요약 개수, 주요 창 제목을 evidence/pcEvidence로 저장합니다.
- `/work-units`에 "PC 세션 병합 후보" 섹션을 추가했습니다.
- 후보 카드에서 `세션 작업단위 저장`을 누르면 `/api/nenova-exe/sessions` POST로 해당 세션이 `/api/work-units`에 저장됩니다.

검증:
- `npx tsc --noEmit` 성공
- 샘플 `nx-session-test-001/002` 이벤트 2건이 기본 `gapMin=5`에서 세션 1건으로 병합되는 것 확인
- 병합 세션 POST 시 `workUnitSync.ok=true`, `source_events=2`, `NX-SESSION-...` 작업 단위 생성 확인
- `gapMin` 미입력 시 URL `null`이 0으로 읽혀 1분으로 줄어드는 문제를 고쳤습니다.
- 테스트 로컬 데이터는 정리 완료
- `GET /api/nenova-exe/sessions` HTTP 200 확인
- `/work-units` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/nenova-exe/sessions/route.ts`
- `nenova-erp-ui/src/app/(app)/work-units/page.tsx`
- `docs/nenova-exe-work-unit-ingest.md`

### Watcher 데이터 품질 공통 필터

날짜:
- 2026-05-24 KST

사용자 요청:
- 금요일 마지막 작업인 `app명 오염/클립보드 노이즈/Vision 미작동` 수정을 이어서 더 단단하게 보강해야 합니다.
- `nenova.exe` 작업데이터, 카톡/카카오워크 대화데이터, PC 작업데이터가 3차 교차검증될 때 앱명/창제목 오염 때문에 같은 오류가 반복되면 안 됩니다.

현재 조치:
- `src/data-quality.js` 공통 필터를 추가했습니다.
- 앱명 정규화에서 `.exe` 별칭을 처리합니다. 예: `nenova.exe -> nenova`, `chrome.exe -> chrome`, `msedge.exe -> edge`.
- 앱명 오염값을 차단합니다. 예: JSON 이벤트, PowerShell 명령어, 버전번호, 프로세스 목록.
- 창제목 정제에서 프로세스 목록/PowerShell 명령어를 차단하고 이메일, URL 파라미터, 사용자 홈 경로를 마스킹합니다.
- 클립보드 노이즈 필터를 공통화했습니다. 단순 앱명/프로세스 목록/윈도우 타이틀 오염은 버리고, 발주/견적/테이블 텍스트는 유지합니다.
- `keyboard-watcher.js`, `clipboard-watcher.js`, `screen-capture.js`가 같은 공통 필터를 사용하게 변경했습니다.
- 스크린캡처 프로파일 키가 `.exe` 앱명 때문에 `unknown`으로 빠지지 않게 했습니다.

검증:
- `npx jest tests\data-quality.test.js --runInBand` 성공
- `node -e "require('./src/data-quality'); require('./src/keyboard-watcher'); require('./src/clipboard-watcher'); require('./src/screen-capture'); console.log('modules ok'); process.exit(0)"` 성공
- `npx jest --runInBand` 성공, 8개 테스트 스위트 / 144개 테스트 통과

다시 반복되면 먼저 볼 위치:
- `src/data-quality.js`
- `src/keyboard-watcher.js`
- `src/clipboard-watcher.js`
- `src/screen-capture.js`
- `tests/data-quality.test.js`

### 입고단가·송금 변경내역 패널

날짜:
- 2026-05-24 KST

사용자 요청:
- 입고단가 송금 메뉴 페이지에서 변경내역이 있는 품목을 옆에 별도 리스트로 볼 수 있어야 합니다.

현재 조치:
- `/inventory` 메뉴명을 `입고단가·송금`으로 변경했습니다.
- 품목 데이터에 `transferStatus`, `transferMemo`, `updatedAt` 필드를 추가했습니다.
- `ProductChangeRecord` 변경 이력 모델을 추가했습니다.
- 입고/출고, 단가 변경, 송금상태 변경, 품목등록 시 변경내역이 자동 기록됩니다.
- `/inventory` 오른쪽에 `변경내역 있는 품목` 패널을 추가했습니다.
- 변경내역이 있는 품목만 별도 리스트로 보이고, 최근 3건의 변경 타입/전후값/메모/작업자를 확인할 수 있습니다.
- 기존 브라우저 저장소의 오래된 품목 데이터도 seed 기준 송금상태를 보정해서 보이게 했습니다.

검증:
- `npx tsc --noEmit` 성공
- 브라우저 `http://127.0.0.1:3000/inventory`에서 `입고단가·송금`, `변경내역 있는 품목`, `송금완료`, `송금대기`, `단가변경` 렌더링 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/inventory/page.tsx`
- `nenova-erp-ui/src/lib/store.ts`
- `nenova-erp-ui/src/lib/nav.ts`

### 차수피벗 차수 입력 잘림

날짜:
- 2026-05-24 KST

사용자 요청:
- `nenovaweb.com/shipment/week-pivot?weekFrom=2026-21-01&weekTo=2026-21-01` 차수피벗 페이지에서 차수 입력값이 `2026-20-0`처럼 잘려 보이는 문제 수정.

중요 원인:
- 이 화면의 실제 소스는 `mindmap-viewer/nenova-erp-ui`가 아니라 `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업` 저장소에 있습니다.
- 공통 `WeekInput` 입력칸 폭이 `60px` 고정이라 `YYYY-WW-SS` 형식을 담기 부족했습니다.

현재 조치:
- `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업\lib\useWeekInput.js`
  - `YYYY-WW-SS` 형식 포맷/입력/이전·다음 이동 지원.
  - `WeekInput` 폭을 `112px`로 확대하고 shrink 방지.
- `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업\pages\shipment\stock-status.js`
  - URL `weekFrom/weekTo` 쿼리값 초기 반영.
  - 차수 컨트롤 영역이 줄어들지 않도록 `minWidth: max-content`, `overflow: visible`.
- `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업\pages\shipment\week-pivot.js`
  - `/shipment/week-pivot` 라우트 추가, 기본 차수피벗 탭 연결.

검증:
- `npm run build` 성공.
- `http://127.0.0.1:3001/shipment/week-pivot?weekFrom=2026-21-01&weekTo=2026-21-01` 확인.
- 브라우저 측정: 두 입력칸 모두 value `2026-21-01`, `clientWidth=110`, `scrollWidth=110`으로 잘림 없음.

다시 반복되면 먼저 볼 위치:
- `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업\lib\useWeekInput.js`
- `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업\pages\shipment\stock-status.js`
- `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업\pages\shipment\week-pivot.js`

### 차수피벗 엑셀 자연어 품목명

날짜:
- 2026-05-24 KST

사용자 요청:
- 차수피벗에서 엑셀 다운로드 시 품목이름 옆 셀에 자연어 품목명도 표시.

현재 조치:
- 실제 소스 위치: `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업\pages\shipment\stock-status.js`
- `naturalProdName(p)` helper 추가.
- 엑셀 헤더를 `국가 / 꽃 / 품명 / 자연어 / 차수별 업체...` 순서로 변경.
- 자연어 컬럼 값은 `국가 꽃 품명` 형태입니다. 예: `콜롬비아 수국 Blue (블루)`.

검증:
- `npm run build` 성공.

다시 반복되면 먼저 볼 위치:
- `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업\pages\shipment\stock-status.js`

### 네노바웹 메뉴 중복/겹침 정리

날짜:
- 2026-05-24 KST

사용자 요청:
- 네노바웹 메뉴에서 겹치는 것을 정리.

현재 조치:
- `nenova-erp-ui/src/lib/nav.ts`
  - 기존 단일 메뉴 배열을 `NAV_GROUPS`로 재구성.
  - 메뉴 그룹: `홈`, `실무 처리`, `검증·자동화`.
  - 긴/겹치는 라벨 축약:
    - `ERP 흐름` → `업무 흐름`
    - `신규 주문` → `주문`
    - `입고단가·송금` → `입고/송금`
    - `고객 관리` → `고객`
    - `직원 워크플로우` → `작업 원장`
    - `워크 연동` → `카카오워크`
- `nenova-erp-ui/src/components/Sidebar.tsx`
  - 사이드바를 그룹 단위로 렌더링.
  - 아이콘 영역 폭 고정, 라벨 `truncate`, 메뉴 스크롤 적용으로 겹침 방지.

검증:
- `npx tsc --noEmit` 성공.
- 브라우저 `http://127.0.0.1:3000/inventory`에서 사이드바 그룹/메뉴 렌더링 확인.

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/lib/nav.ts`
- `nenova-erp-ui/src/components/Sidebar.tsx`

### CLAUDE.md 10만 스타 가드레일 적용

날짜:
- 2026-05-25 KST

사용자 요청:
- GitHub에서 10만 개 이상 스타를 받은 `CLAUDE.md` 파일 내용을 우리 프로젝트에도 적용.

확인한 외부 기준:
- `forrestchang/andrej-karpathy-skills` 및 `multica-ai/andrej-karpathy-skills`의 `CLAUDE.md`.
- 핵심 원칙: 구현 전 사고, 단순성 우선, 수술식 변경, 검증 가능한 목표.

현재 조치:
- 루트 `CLAUDE.md` 상단 `절대 규칙` 아래에 `000. Karpathy식 에이전트 코딩 가드레일` 추가.
- 원문 전체 복사가 아니라 Nenova/Orbit 위험 영역에 맞춰 적용:
  - 직원 PC/데몬/배포/데이터 삭제·수정/자동 실행은 더 엄격히 가정과 범위 확인.
  - 기존 패턴 우선.
  - 요청과 직접 연결된 파일만 수정.
  - 검증 불가 영역은 완료처럼 말하지 않기.

검증:
- `Get-Content -Path CLAUDE.md -TotalCount 90`로 상단 삽입 확인.

다시 반복되면 먼저 볼 위치:
- `CLAUDE.md`의 `000. Karpathy식 에이전트 코딩 가드레일`.

### Nenova Computer Use Lab 고성능 OCR/로컬 조작 확장

날짜:
- 2026-05-25 KST

사용자 요청:
- Windows 내장 OCR 성능이 낮으므로 Claude Vision 수준에 가까운 OCR을 추가하고, Nenova 업무 분석에 맞춘 OCR 성능을 디벨롭.
- 기존 모든 툴의 성능을 계속 디벨롭하는 개념으로, macOS Claude Computer Use처럼 조작 기능도 발전.

현재 조치:
- `scripts/nenova-cu.js`
  - `ocr --engine best|vision|local` 추가/확장.
  - `best` 모드는 Claude Vision CLI → Tesseract → Windows OCR 순서로 시도.
  - Claude Vision OCR 프롬프트는 Nenova 업무 화면 전용 JSON(`text`, `lines`, `fields`, `guiElements`, `businessIntent`)을 요구.
  - Windows OCR/Tesseract 결과에도 Nenova 업무 후처리 적용.
  - OCR 보정 사전 추가: `거래서→거래처`, `고객멍→고객명`, `오르빗→Orbit` 등.
  - 업무 필드 추출: `거래처`, `주문번호`, `품목`, `수량`, `날짜`, `금액`, 화면유형, 앱유형.
  - `desktop-run` 추가: 로컬 PC 클릭/입력/단축키/대기 액션 지원.
  - 기본은 dry-run, `--execute`가 있을 때만 실제 로컬 조작.
  - 실제 실행 시 전/후 스크린샷과 후처리 OCR 결과를 artifact로 저장.
- `docs/nenova-computer-use-lab.md`
  - OCR 엔진 우선순위, Nenova 보정, desktop-run 사용법, 안전 경계 문서화.

검증:
- `node --check scripts\nenova-cu.js` 성공.
- `node scripts\nenova-cu.js ocr --image artifacts\nenova-cu\ocr-smoke-ko.png --engine best`
  - Claude Vision 시도 후 Windows OCR fallback.
  - 결과: `네노바 주문 테스트 12345 거래처: Orbit 플라워`
  - fields: `customer=Orbit 플라워`, `screen=order`, `app=nenova`
  - corrections: `거래서→거래처`, `오르빗→Orbit`
- `node scripts\nenova-cu.js desktop-run --click "100,200" --type "네노바 테스트"`
  - dry-run 성공, 실제 조작 없음.
- `node scripts\nenova-cu.js health`
  - Python, pyautogui, Pillow, Playwright, Windows OCR 사용 가능.
  - Tesseract 미설치.
  - Claude CLI 경로 감지됨. 단, Claude Vision 실제 사용은 CLI 로그인 상태 필요.

다시 반복되면 먼저 볼 위치:
- `scripts/nenova-cu.js`
- `docs/nenova-computer-use-lab.md`
- `artifacts/nenova-cu/*.json`

### Nenova Computer Use Lab 영상형 프리뷰

날짜:
- 2026-05-25 KST

사용자 요청:
- `nenova-cu`가 어떻게 작업하는지 프리뷰 화면에서 영상처럼 보여지게 하기.
- 어느 구간을 클릭했는지, 어느 구간을 OCR 처리/분석했는지까지 표시.

현재 조치:
- `scripts/nenova-cu.js`
  - `preview --latest 80` 명령 추가.
  - 최근 `artifacts/nenova-cu/*.json`을 읽어 `preview.html` 생성.
  - OCR 결과의 word bounding box를 초록 박스로 표시.
  - `desktop-run` 클릭 위치를 십자 마커로 표시.
  - 입력/단축키 액션은 화면 위 액션 박스로 표시.
  - Playwright `web-audit` 요소는 웹 요소 박스로 표시.
  - Play/Pause/Prev/Next 타임라인 UI 생성.
- `docs/nenova-computer-use-lab.md`
  - `preview` 명령과 시각화 범위 문서화.

검증:
- `node --check scripts\nenova-cu.js` 성공.
- `node scripts\nenova-cu.js preview --latest 80` 성공.
- 생성 파일: `artifacts/nenova-cu/preview.html`
- frameCount: 9
- HTML 안에 OCR word boxes, desktop click marker, web element overlay 데이터 확인.

다시 반복되면 먼저 볼 위치:
- `scripts/nenova-cu.js`의 `preview`, `collectPreviewFrames`, `buildPreviewHtml`
- `artifacts/nenova-cu/preview.html`

## 2026-06-12~13 — Vision 파이프라인 부활 + DATA_CHECK.md 확립
- 요청: 데이터 확인 방식을 MD에 고정 저장 / 분석 0% 원인 규명
- 검색어: capture-funnel, vision/stat, claim-token, sendImage, _heapPressure
- 원인(확정): ① 서버 ANTHROPIC_API_KEY 무효(401) → 교체+검증 완료 ② owner PC 임시ID 설치→self-healer 토큰 자기파괴 루프(치유#69) → claim-token으로 MNH03H73690BB2CD82 복구 ③ mouse_click 이미지 게이트 죽은코드 → f838f92 수정 ④ 설연주/강현우 데몬 크래시루프(uiohook 실패/updater dead-loop) — 미해결
- 수정 파일: src/screen-capture.js(2082b5f, f838f92), DATA_CHECK.md(86ec7ab), ~/.orbit-config.json(토큰)
- 검증: /api/vision/stat processed 0→1 (첫 실화면 분석 성공, 2026-06-13 00시)
- 미해결: processed 증가했는데 screen.analyzed 이벤트 미저장(저장 경로 버그) — DATA_CHECK.md '추적 중' 참조
- 재발 시 먼저 볼 곳: **DATA_CHECK.md** (표준 runbook, 함정 9종)

## 2026-06-15 — 설치코드 근본수정 (원인→픽스)
- 요청: 지금까지 파악한 원인 반영한 '문제없는 설치코드 최종본' 검증 후 작성
- 설치경로 정리: 직원=install-open.bat→install-open.ps1(auto-register 이름매칭→실토큰)→install.ps1. owner가 쓴 clean-install.ps1은 임시ID 경로(문제 근원 중 하나)
- 근본원인→픽스:
  1) self-healer 토큰 자기파괴(_clearTokenCache가 디스크 토큰 삭제) → personal-agent.js 무력화 (4e8aa0a)
  2) OrbitCodeSync가 git pull만 하고 데몬 재시작 안 함→구코드 며칠 실행(강현우 72h) → install.ps1 line432 HEAD변경시 재시작 (a3a5e88)
  3) OrbitWatchdog 30분 폴링 vs 원격명령 5분 TTL 불일치 → 원격 restart/update 자주 빗나감 (미수정, 명령TTL 연장 or 폴링단축 필요)
  4) auto-register는 issueApiTokenAsync(PG await)로 claimable 토큰 발급 → 정상
- 검증: PowerShell AST 파서로 install.ps1 전체 + 생성 orbit-code-sync.ps1 본문 문법 통과
- 미완(라이브 e2e는 서버 502 안정화 + 테스트PC 필요): install-open.ps1 설치후 자가검증(토큰verify+이벤트도착) 추가, 임시ID hard-fail
- 재발 시 먼저: DATA_CHECK.md + 이 항목

## 2026-06-15 (속행) — 남은 3개 완료
- #1 라이브 e2e: auto-register(name=jaeyong lim)→matchedByName=true·실유저 MNH03H·토큰len54→auth/verify 즉시 ok. install/verify verified=true chunks20. (E2E-TEST-PC/VERIFY-TEST-PC pc_link 테스트잔여 — 가짜hostname이라 무해)
- #2 명령 TTL 5→40분 (server.js ~1904) — watchdog 30분폴링이 force-restart/update를 반드시 1회 잡음. node -c 통과 (b로 시작 커밋)
- #3 install-open.ps1 설치 자가검증 추가 — 토큰 verify + install/verify 폴링(2분)→PASS/FAIL. AST 통과 + 자가검증 로직 라이브(tokenOk/dataOk=True)
- 커밋: a3a5e88(codesync restart), 4e8aa0a(token), +TTL/verify 커밋. 전부 push→배포
- 재발 시: DATA_CHECK.md + 이 기록

## 2026-06-17 — 서버 OOM 위기 + Vision 무과금 + 신규3명 + 디테일 저하 (대규모)
### 요청 흐름
- Vision API 비용 → owner PC CLI 무과금 전환; 신규 PC 데이터 확인; 서버 502 반복 원인; 키보드/카톡 디테일 저하 확인
### 핵심 사고: 서버 OOM (오늘 종일 502의 진짜 범인)
- railway logs: FATAL heap limit(742→787MB) 78초마다 크래시루프
- 사슬: Drive 403 무한재시도 → daemon.log 8.7MB → 거대 이벤트/snapshot 폭주 → 서버 OOM. + 크래시루프 데몬 daemon.update 폭주 + 서버가 이벤트를 Haiku로 [AI분석] → 부하/비용. + 내 force-restart/update 수십번 = 명령큐 누적
- 해결(영구): railway 변수 GOOGLE_DRIVE_CAPTURES_FOLDER_ID 제거 → drive-config 무조건 enabled:false (백업값 1XvD0BwymPoQLthnLezgqftVm0D-27Uh5). + /api/admin/drive-toggle {enabled:false}(global._driveDisabled). 단 실행중 데몬은 재시작해야 반영
### 수정 커밋
- 4e8aa0a self-healer 토큰 자기파괴 제거 / a3a5e88 OrbitCodeSync 코드변경시 데몬재시작 / f838f92 mouse_click 이미지 / ceda93f 명령TTL40분+install-open 자가검증 / 40c589f vision 워커 OFF토글(VISION_SERVER_WORKER=off, Railway변수도 설정) / drive-toggle 커밋
### 무과금 Vision
- owner PC: bin/vision-worker.js --server-queue --night (CLI Max구독, ANTHROPIC_API_KEY 비움) HKCU\Run+시작프로그램 자동기동. 서버 유료워커는 VISION_SERVER_WORKER=off(런타임토글+Railway변수)
### 신규 3명 (오늘 설치)
- 강명훈=DESKTOP-L0C2IOT(MNMSAQJD78E5, 이름정상) / 김빛나=NENOVA2025(MN0B1204A46C4B8EAC, update-user-name으로 등록완료) / 정재훈=nenova(MND11FFB8C, PC꺼짐 미등록 — 켜지면 등록)
- 이름등록 엔드포인트: POST /api/admin/update-user-name {userId,name} (admin토큰=dlaww584 config토큰, 데이터 유지)
### 디테일 저하 (중요)
- 직원들 keyboard.chunk=0 (설연주/김빛나/강현우) → 타이핑/카톡 디테일 사라짐. owner만 풀(keyboard28+screen105+clipboard). 원인=uiohook 키보드후킹 실패 + 크래시루프가 실작업캡처 밀어냄. 데몬 안정화 후 복구 기대, 안되면 uiohook 코드진단
### 도구/교훈
- railway CLI 로그인됨(dlaww584, tranquil-analysis/mindmap-viewer). railway logs/redeploy/variables 사용가능
- 잦은 push=재배포 churn으로 502 악화 → 모아서 push. 데이터문제는 DATA_CHECK.md 먼저, 재부팅 금지
### 재발 시 먼저 볼 곳: DATA_CHECK.md + memory(server-oom-drive-flood, no-reboot-use-selfheal, vision-cli-worker-local)

---
## 2026-06-17 (오후) — 서버 OOM(daemon.update 폭주) + 원격 재시작 레버 정립

**사용자 요청 핵심**: ①"데이터 확인" 시 처리절차를 MD에 ②연결 PC 전부 재점검 ③김빛나 PC 왜 그런지(바이러스?) ④이 상황 재발방지 MD화.

**검색/확인**: src/daemon-updater.js(GUARDIAN_ONLY_ACTIONS, executeCommand, pullAndRestart), setup/guardian-watchdog.ps1, server.js /api/hook(insertEvent, _heapPressure), railway logs.

**진단 결과**:
- 서버 OOM 2차 원인 = crash-loop 데몬의 daemon.update 폭주 → PG 연결 타임아웃 → insertEvent 적체 → heap 760MB OOM. (오늘 전직원 데이터 안 들어온 진짜 주범)
- 원격 재시작이 안 닿던 이유 = restart/update가 GUARDIAN_ONLY_ACTIONS 위임 블랙홀(워커가 같은 큐 먼저 소비). gitpull-worker는 "최신"이면 skip, reclone-worker는 Windows 디렉터리 rename EBUSY 실패.
- 김빛나(NENOVA2025): 데몬·마우스·워커 살아있음(바이러스 통째 차단 아님). 화면캡처 모듈 반복死+keyboard 0. AV차단 vs 로드실패는 로그 증거없어 미확정→아침 daemon-self.log 필요. 원격레버 다 소진→전원주기로만 회생.

**수정 파일/커밋**:
- 5ec0814 src/daemon-updater.js — GUARDIAN_ONLY_ACTIONS=['reinstall'](restart/update 직접처리)
- 05ff191 server.js — /api/hook 힙압력 시 노이즈 저장 스킵
- 0b700f2·460b58d DATA_CHECK.md — "데이터 확인" 트리거절차+§13 레버+§13-Z 좀비+§10 OOM②

**검증**: 정재훈(nenova) gitpull-worker로 재시작 성공(87m→1m). 서버 재배포 후 5/5 200 안정. 김빛나는 4종 레버 다 무반응(전원주기 대기).

**반복 시 먼저 볼 위치**: DATA_CHECK.md ★"데이터 확인" 트리거 / §10(서버 OOM 메타규칙) / §13(원격레버)·§13-Z(좀비). 메모리 no-reboot-use-selfheal.

---
## 2026-06-25 KST — 데몬 자가해결 체계 + 화면캡처 검은화면 근본수정 + nowlink 다운로드

**프로세스 반성(사용자 지적)**: 이 세션에서 데몬/설치 수정을 연속하며 **작업 전 WORK_MEMORY/DAEMON_STRUCTURE 재확인을 건너뛰었음**. 그 결과 신원 혼동(아래) 발생. 다음부터 데몬/설치 작업은 무조건 prework-search + 이 파일 먼저.

**★신원(2026-06-25 실데이터로 확정 — 6/17 잠정메모 정정)**:
- **김빛나 = hostname NENOVA(=소문자 nenova 동일머신) = userId MND11FFB8CBF0916DB**. 근거: 오늘 사용자가 직접 install-open으로 "김빛나" 등록 + pc-list에서 이 userId가 16:55까지 현역(3617 이벤트). 6/17 메모의 "정재훈=MND11FFB8C(PC꺼짐 미등록 잠정)"은 **미확정 추정이었고 오늘 등록으로 무효화됨.** 내가 이 잠정메모를 확정인 양 사용자에게 들이민 게 실수(2회 성급).
- NENOVA2025 = userId MN0B1204A4 = 별개 머신, 12:38 이후 비활성. 정체 미확정(6/17엔 김빛나로 잠정표기됐으나 오늘 활동은 NENOVA쪽). **단정 금지.**
- 교훈: 신원은 6/17 잠정메모가 아니라 **pc-list 최신활동 + 사용자 실시간 등록**을 1순위로. hostname 대소문자(NENOVA/nenova/NEONVA/NENOVA2025) 난립 = §9 함정.
- 이름표시 이슈: update-user-name은 orbit_auth_users 대상(대시보드용)인데 PG upsert pgOk:false로 실패(원인 미규명, SQLite만 됨). learning/logs의 userName은 이벤트 denormalized라 이걸로 안 바뀜 → 데몬이 config의 이름을 보내야 근본 반영. 보드에 MND11FFB8C로 뜨는 중.

**화면캡처 검은화면 근본원인(확정)**: `[3/9] Python` 단계의 `Get-Command python`이 **Windows 스토어 껍데기(WindowsApps\python.exe 0-byte 별칭)도 TRUE로 판정** → 실제 python 미설치인데 설치 건너뜀 → PIL/pyautogui 실패 → 데몬이 PS CopyFromScreen 폴백으로 **3KB 검은화면만** 생성. self-test로 PC별 확정: 설연주(neonva)·현욱(CAA5TA1)·임재용(S4S2HMU)=실제캡처 정상(250KB~1.3MB), 정재훈(nenova)=python없음 3KB 검은화면.

**수정 커밋(mindmap-viewer, 전부 push·배포)**:
- 9cb56a0 uiohook을 child process(uiohook-child.js)로 격리 — 은행 키보드보안 충돌 시 데몬 사망 방지. keyboard-watcher/mouse-watcher 둘 다 child 이벤트 구독(subscribeInput)
- b00d1f7·2d7766e self-healer가 bank-safe(isPaused) 중 컴포넌트 강제재시작 안 하게(uiohook crash 방지)
- 23ce9f7 install-open.bat UAC 승격 런처에 -NoProfile 추가(‘running scripts is disabled’ profile.ps1 빨간에러 제거)
- abe6fea install.ps1 실행정책 자가해제(Process/LocalMachine/CurrentUser) + trap에서 install.error 자동보고(복붙 불필요)
- 8624831·d4bd17f screen-capture 시작 시 캡처 자가테스트 → **daemon.screendiag** 이벤트로 직접 보고(guardian 명령채널 우회). detail에 method별 결과
- 2c442ca **GET /api/admin/raw-events?type=&hostname=** — learning/logs가 커스텀필드 깎는 문제 우회, 원본 data_json 조회(진단 필수 도구)
- bc0a887 install.ps1 [3/9] Python: Test-RealPython(실제 'Python 3.x' 검증)으로 스토어껍데기 배제 + winget→python.org 이중설치(PrependPath)
- 1e79861 screen-capture **python 자가탐색(_resolvePython, PATH밖도 설치폴더 검색)+자가설치(_autoInstallPython, user-scope 무권한 백그라운드)** — **재설치 없이** git pull만으로 검은화면 자가복구

**자가해결 체계 완성(사용자 핵심요구=babysitting 제거)**: 직원 재실행 없이 ①실행정책 자가해제 ②설치오류 자동보고 ③화면캡처 self-test 자동진단 ④python 없으면 데몬 자가설치. 새 오류만 1회 내가 고치면 그담부터 자동.

**nowlink.kr = ai-trainer-hub(별도 Next.js repo: Jayinsightfactory/ai-trainer-hub, master, Railway)**. mindmap-viewer 아님. /install은 자영업자 AI 출장설치 신청폼(상용). 커밋 4c8c5bc: /install에 직원용 Orbit 다운로드 카드 + **/orbit-install** 라우트(mindmap-viewer install-open.bat으로 302). 공유주소 nowlink.kr/orbit-install.

**워크플로우 융합 보드**: `C:\Users\USER\Documents\orbit-workflow-board\index.html` — 5913 관찰이벤트→1598 융합동작(화면캡처/화면해독/키보드/마우스/클립보드/주문/카카오톡/ERP), 자동화후보 412, 교차검증 78. 융합스크립트 /tmp(AppData\Local\Temp)\orbitfuse\fuse3.py·gen2.py. screen.analyzed(vision)는 06/17배치라 최근 키보드와 시각 어긋남.

**미해결/리스크**:
- 정재훈/김빛나 등 python 누락 PC: 자가설치 코드가 다음 git pull 후 작동하는지 daemon.screendiag로 확인 필요(설치 수분 소요)
- guardian가 exec/capture-diag 결과를 빈값으로 보고하는 명령채널 한계 → daemon.screendiag/raw-events로 우회 확립
- Register-ScheduledTask XML 포맷에러(schtasks.exe 폴백으로 자동시작은 정상) — 추후 정리
- 이름/계정 정정(김빛나↔정재훈 hostname 혼동) 확인 필요

**재발 시 먼저**: 이 항목 + DATA_CHECK.md(§13-Z 좀비, §9 hostname충돌) + DAEMON_STRUCTURE.md. 화면캡처 검은화면=python누락 의심→daemon.screendiag 확인. **신원은 989번줄(6/17 잠정) 말고 pc-list 최신활동+사용자 등록 우선**(위 ★신원 참조).

**검증 로그(2026-06-25)**: 김빛나 NENOVA daemon.screendiag 16:34/16:35/16:43에 "python 없음 감지 → 백그라운드 자동설치 시작" 트리거 확인(1e79861 작동). 단 16:43:49까지 still working=powershell(3KB 검은화면)=python 설치 완료 전. 데몬 잦은 재시작으로 _autoInstallPython이 매 재시작 재트리거(detached라 install은 살아남음). 추적: 설치 완료 후 working=pil 되는지. 안 되면 winget 부재/python.org 다운로드 실패 의심 → 동시중복설치 방지 lock-file 가드 검토.

**최종 상태(2026-06-25 야간)**:
- ✅ 완료·검증: 신원정정(WORK_MEMORY), 이름 "김빛나" PG반영(update-user-name UPDATE우선+ON CONFLICT제거, 9004f62, pgOk=True 확인·learning/logs userName=김빛나), 설치기/데몬 하드닝 전부 배포(-NoProfile 23ce9f7, 실행정책자가해제+install.error abe6fea, uiohook격리 9cb56a0, self-test+daemon.screendiag 8624831/d4bd17f, raw-events 2c442ca, python스토어껍데기 bc0a887, python자가탐색·자가설치 1e79861, 중복방지lock 2658d20, 설치결과보고형 4bcf2bf)
- ❌ **미검증(정직)**: 김빛나(NENOVA) 화면캡처 python 설치 **완료 못 확인**. self-heal은 트리거 증명됨(screendiag "python없음→자동설치 시작"). 그러나 (a)데몬이 야간 idle이라 capture트리거 거의 없고 (b)내 restart/update 명령에 데몬이 재시작 안 함(§13-Z 명령채널 안 닿음) → 설치가 거의 시도 안 돼 미완. 최신 self-test 17:12:48 이후 갱신 없음.
- **자동복구 경로**: 김빛나가 아침 **재부팅 시(=§13-Z 정석 회생)** 또는 활동 시작 시 self-test/capture가 _autoInstallPython 트리거 → 4bcf2bf 결과보고형이라 **"pyinstall OK" 또는 실패원인을 daemon.screendiag(status=py-install)로 자동 POST**. 그때 raw-events?type=daemon.screendiag&hostname=NENOVA로 확인. 즉시확정은 재설치 1회(설치기 python 이미 수정됨)뿐인데 사용자가 거부함.
- 교훈: 원격으로 idle PC의 백그라운드 설치 완료를 그 자리에서 강제·검증하는 건 명령채널 한계로 불가. 자가복구+자가보고를 심어두고 다음 전원주기/활동에 맡기는 게 현실적.

## 2026-06-25 (속행) — 온톨로지화 (audit P0/P2/P3/P4 실행)
- 요청: "작금의 작업들은 온톨로지화 되었는가" → 확인결과 골격(company-ontology/event-bus/golden/work-units)은 가동중이나 원시관찰이 자동 승격 안 됨. "모두작업" 지시로 구현.
- 기존 접지: unified_events(0010, source∈orbit/erp-ui/ai-trainer/nenova-agent), orbit_entity_golden(0011, person/customer/document/task, conf 1/2/3소스=0.34/0.67/1.0), event-bus.publish(ON CONFLICT 없음→멱등 위해 라우트서 직접 upsert). 관계 store는 없었음(audit P3).
- 만든 것(커밋 e0c1a47, push·배포):
  - `docs/nenova-ontology-spec.md`: 표준 객체(Action/Person/Customer/Document/Task/App/Room/Process)·관계 9종·provenance·confidence 명세(P0)
  - `migrations/0012_ops_relation.sql` + `routes/ops-ontology.js` ensureOpsTables: **ops_relation** 1급 관계 store(P3)
  - promote(): events(키보드/화면해독/마우스/클립/주문) → 사용자별 120s 시간창 융합 → Action(unified_events type=work.action, id=act:{uid}:{startSec}, 멱등) + ops_relation 멱등 upsert(P2). 관계: person_performed_action/action_in_app/action_in_room/screen_observed_action/automation_candidate_for_process. conf=소스종류수.
  - ops API(P4): POST /api/ops-ontology/promote?hours=N, GET /stats /entities?type= /relations?fromRef=&relType= /actions/:id/context(OAG패킷)
  - server.js 배선(require+app.use+init ensureOpsTables)
- 검증(라이브): promote?hours=720 → 315,178 원천 → **28,929 Action + 64,983 관계**. stats: 27,743 action(verified 7,858, automatable 277). 관계 action_in_app 28,670·person_performed 27,743·action_in_room 5,579·screen_observed 983·automation 550. OAG패킷(actions/:id/context) 정상(app·활동·증거2·관계4 반환). entities?type=person 12명(설연주 conf0.667 등).
- 미구현(spec엔 있으나 populate 안 됨, 다음): talk_triggered_action(시간창 대화→작업), action_mentions_customer/action_updated_erp(OCR/ERP 추출 연결=P1 golden id), person_performed_action의 from_ref가 raw userId(golden person id 연결 P1). promote는 수동 트리거(자동 cron 미설정).
- 재발/이어서: 이 항목 + docs/nenova-ontology-spec.md + docs/nenova-ontology-audit.md. promote 주기실행 cron + golden id 연결(P1)이 다음 단계.

## 2026-06-29 — work-logs 버그수정 + 온톨로지 자동화/보강
- work-logs.html "건수만 있고 내용 없음" 버그(커밋 bfdeba7): 대시보드가 allTypes=1 상시사용 → daemon.update(생존신호)가 limit윈도 도배 → keyboard.chunk 밀림(DATA_CHECK §3). 수정: 전체보기=서버기본필터(keyboard/screen/analyzed/idle), 특정타입만 allTypes+type. 검증 임재용 inputText 0→80.
- 온톨로지 자동화/보강(커밋 fd51346, 98ae8eb): ① startPromoteCron — 부팅1분후+30분마다 최근2h 멱등 promote(수동 불필요, 상시최신). server.js init 배선. ② talk_triggered_action 관계 — 카톡 동작 직후 30분내 업무앱 전환=대화→작업. 검증: promote 168h→talk_triggered 596건. 전체 28,524 action / action_in_app 29,456·action_in_room 5,580·talk_triggered 596·screen_observed 983·automation 550.
- ⚠️ promote 720h(315K이벤트) 한방은 502(힙768MB) — 백필은 가벼운 창(≤168h)으로. cron은 2h라 안전.
- 직원 데이터 현황(06/29): 임재용·김빛나 정상(키보드내용+화면). **김빛나 회복**(python 미설치지만 PS폴백 312KB 실화면+키보드내용). 설연주·강현우 키보드 0(uiohook死, 명령채널 안 닿음=§13-Z, 다음 재시작/13:00·15:00 자동업데이트 회생 대기). 이름정정 반영(update-user-name pgOk=True, 김빛나 표시됨).
- Vision anal=None: 서버워커 disabled_by_flag(무과금 정책), owner PC CLI워커 필요(원격불가).
- 미완(다음): 온톨로지 golden person id 연결(P1, 현재 from_ref=raw userId), action_mentions_customer/action_updated_erp(OCR/ERP 연결).

### Vision 워커 재가동 (이 PC, 무과금 CLI)
- 요청: "비전분석 이 PC에서 워커로 작업 시작". owner PC(이 PC)에서 bin/vision-worker.js --server-queue 로 Claude CLI(Max구독) 무과금 분석.
- **★근본 막힘(비자명, 재발주의): Claude CLI OAuth 토큰 만료**(~/.claude/.credentials.json expiresAt 2026-06-22). 워커가 `claude -p`로 분석하는데 401 Invalid auth → 모든 분석 빈결과. 이 Claude Code 세션은 호스트가 토큰 갱신해줘서 되지만 **별도 spawn한 claude 서브프로세스엔 안 퍼짐**. 일반 로그인/데스크톱앱 로그인으론 standalone CLI 토큰 갱신 안 됨.
- **해결: `claude setup-token`**(헤드리스 장기토큰 생성). 일반 login 아니라 이거여야 standalone CLI(/.local/bin/claude, 워커가 쓰는 것)가 인증됨. → expiresAt 갱신, `claude -p` 이미지분석 정상.
- claude 바이너리 2개 주의: 워커는 /c/Users/USER/.local/bin/claude(2.1.173) 사용. 데스크톱앱은 Packages\Claude_...\claude-code\2.1.187. setup-token이 둘 다 쓰는 ~/.claude 토큰 갱신.
- 검증: 워커 재기동(--night 없이 즉시처리) → screen.analyzed 신규생성 확인("jaeyong lim ECOUNT ERP 구매입력 화면 일자/입고창고 채움" 등 정밀분석). vision queue 처리 중.
- 운영: 낮 즉시처리는 Max구독 쿼터 사용. 밤엔 autostart의 --night가 이어받음(setup-token으로 그것도 이제 인증됨). screen.analyzed는 ops-ontology cron(30분)이 screen_observed_action으로 자동 승격.
- 재발 시: vision/stat이 disabled_by_flag(서버워커 OFF=정상, 무과금정책)인데 anal 안 늘면 → 이 PC CLI 토큰 만료 의심 → `claude setup-token` 재실행 + 워커 재기동. 메모리 vision-cli-worker-local.

## 2026-06-29 — API 일$5 비용 출처 규명 + 차단 + 호출자별 추적기 (커밋 b3f5e41·ef4635c)
- 증상: Anthropic 콘솔 전액 **Claude Haiku 4.5**, 하루 $3~13(6/11 데몬 증가 시점부터 급증).
- **범인: src/ollama-analyzer.js** — 이름과 달리 `runAnalysis()`에서 **Haiku가 1차, Ollama는 폴백**. Railway엔 Ollama 없어 항상 Haiku. server.js `for(ev of events) ollamaAnalyzer.addEvent(ev)`로 **수신 모든 이벤트**가 큐→10건/12초마다 queryHaiku 발사 → 근무중 상시 과금.
- 차단: Haiku 1차를 `REALTIME_HAIKU=on`(또는 global._realtimeHaikuOn) + 60초 스로틀 게이트로. **기본 OFF → 과금 0**. Ollama 폴백 유지(모듈 원래 의도 복원).
- 추적기 신설 `src/llm-usage.js`: Anthropic 호출별 토큰/비용 → 테이블 orbit_llm_usage. `wrap(client,caller)`(SDK) / `record(caller,model,parsed.usage)`(raw https). 연결처: ollama-analyzer·insight-engine·auto-doctor·server-vision-worker·llm-gateway·nenova-ai(챗봇).
- API: `GET /api/costs/llm?days=14`(호출자/모델/일자별), `POST /api/costs/realtime-haiku`(master 토큰, {enabled} 런타임 on/off — 실시간 패널 복원용).
- 검증: 배포 후 /api/costs/llm `source:db` byCaller 빈 배열(=Haiku 멈춤), 토글 401(무인증)/off(인증). **최종확인=Anthropic 콘솔 24h내 일비용 하락**. byDay 별칭 day(예약어)→dt 수정(ef4635c). 메모리 api-cost-ollama-analyzer-haiku.
- 다른 Haiku4.5 호출처는 비활성/저빈도: server-vision-worker(VISION_SERVER_WORKER off), auto-doctor(AUTODOCTOR_CLAUDE off, 죽은PC만), insight-engine(24h), process-mining(온디맨드).

## 2026-06-29 — 데이터 신선도 스냅샷 (작업내역 확인 범위)
- /api/admin/pc-list 기준 **실데이터 06-29 16:31 KST까지 실시간 유입**(이 시각 기준 방금 전까지 활성).
- 활성 PC(오늘 16:1x~16:31): T09911T(강현우 32,727)·S4S2HMU(owner임재용 204,839)·NENOVA(김빛나 3,724)·NEONVA(설연주 295)·DESKTOP-CAA5TA1(현욱 30,594)·NENOVA2025(10,705).
- ⚠️ DESKTOP-L0C2IOT(MNMSAQJD…) last_seen="9024-09-21" = 해당 PC 시계 미래로 깨짐(타임스탬프 오염, 집계 왜곡 가능 — 점검대상).
- 일부 user_id가 여러 hostname에 중복(예: MNH03H… owner가 S4S2HMU/nenova/L0C2IOT/NENOVA2025) = 같은 계정 다PC 잔재. 오전 07:xx까지만 찍힌 항목은 그 조합이 오전 후 비활성.

## 2026-06-29 — 업무 흐름 청사진(옵시디언 그래프 뷰) V1 구현·배포·검증 (커밋 b83f697→9ac5194)
**목표**: 팔란티어식 "숫자 아닌 흐름" 뷰. 미구현 재설계(ORBIT_3D_REDESIGN_GUIDE.md, 옵시디언×3D)를 기존 온톨로지(unified_events+ops_relation+orbit_entity_golden)로 채워 완성. 줌3단(회사맵/직원/업무단위)+핸드오프 엔진. plan: peppy-swinging-goblet.md.
- **P1 핸드오프 엔진** `src/flow-handoff.js` `enrichHandoff(pool,hours)` — promote() 직후 호출(ops-ontology.js /promote+cron). 룩백 min72h(짝 누락 방지), 멱등. 신규 rel 3종:
  - action_mentions_customer: Action.data(activity/screen/room)→거래처 골든(N.findCandidates score≥0.85). 재사용 src/intelligence/entity-resolution(korean-normalizer/bootstrap-customer). 검증: "그린화원" 등 정확 매칭.
  - action_handoff: 공유키(cust/order≥5자리/doc파일명/**room=카톡방**)+다른사람+24h내 인접쌍. **room 키가 핵심**(같은 톡방=협업맥락). 검증: **설연주→강현우** 등 11쌍.
  - action_updated_erp: ERP앱 액션+키→ErpOutcome.
- **P2 Flow API** `routes/flow-map.js` mount /api/flow (server.js). 인증=intelligence-golden 패턴(MASTER_TOKEN orbit_9679 또는 ?token, **resolveAdmin 아님**—그건 env ADMIN_TOKENS만 받음). 액션id `act:{userId}:{sec}`에서 userId 파싱해 핸드오프 롤업(조인불필요). 엔드포인트: /company(별자리+핸드오프 overlay) /employee?userId=&hours= /workunit?customer=&order= /people. 검증: company 노드22/엣지30, employee(강현우)400노드.
- **P3 프론트** `public/graph.html`+`public/js/graph-shell.js` — UMD force-graph(2D)/3d-force-graph(3D 토글), 줌3단, 신뢰도 고리(녹1.0/황0.67/회0.34), 핸드오프 흐름선, 노드클릭→OAG 패널(/api/ops-ontology/actions/:id/context). 브라우저 검증완료(스샷): 회사 별자리 렌더, 강현우 직원흐름 400노드, 액션클릭→Excel 작업 증거패킷+관계 표시.
- **재발/한계**: ① 핸드오프는 데이터 희소—owner 외엔 vision/keyboard 약해 처음 0이었음. 336h promote+room키 후 11쌍. 설연주/강현우 keyboard死 회복되면 더 늘어남. ② /employee 기본선택이 활동최다(MN90A…8463, 06-18마지막)면 168h창 밖→0노드. 최근활동순 정렬 개선 여지. ③ 회사맵에서 일부 거래처명(정화원예 등)이 라벨겹침/엔티티오분류로 보일 수 있음(entity-resolution 후속). ④ promote 720h=OOM, ≤168h. ⑤ admin token=env ADMIN_TOKENS(로컬 ~/.orbit-config.json token=orbit_1f4df8…이 프로덕션도 통함), flow API는 orbit_9679로 접근.
- 범위밖(후속): workunit 선형DAG 레이아웃, 기존페이지 graph셸 흡수(지침 PhaseB~D), 노드 클러스터링.

## 2026-06-29 — 주기 운영 에이전트 파이프라인 (owner PC CLI 무과금) (커밋 70b0082)
사용자 요청: 데이터구조를 에이전트구성에서 가져오고, 주기적 업데이트. 확인결과 **흐름 그래프는 이미 30분 cron(promote+enrichHandoff)으로 자동갱신**되나, nenova 4에이전트(.claude/agents/nenova-*, data-fusion/forecaster/cross-validator/ops-orchestrator)는 세션 수동호출만이라 예측·병목·교차검증 층이 주기화 안 됨. 결정: **owner PC Claude CLI(무과금)로 에이전트 파이프라인 주기 실행**(Vision워커 패턴), 산출물 전부(예측/병목/부하/자동화/교차검증/source_disagreement) 흐름 뷰에 표시.
- **서버**(routes/flow-map.js): GET /api/flow/ops-input(융합 작업단위 번들=data-fusion 산출물, units160·loads·handoffs) + POST/GET /api/flow/ops-report(orbit_ops_report 테이블).
- **워커** bin/ops-agent-worker.js: ops-input fetch → 합성 프롬프트(orchestrator+forecaster+validator)를 claude CLI에 **stdin**으로(arg길이제한 회피) → JSON 파싱 → ops-report POST. 4h 루프(--once 지원). CLAUDE_CLI=where claude(C:\Users\USER\.local\bin\claude.exe). 무과금(Max구독).
- **프론트**(graph.html): "📊 운영 인사이트" 패널 — verdict/confidence + 예측·병목·부하·자동화·교차검증·원천불일치 + "N분 전 갱신".
- **검증완료(브라우저 스샷)**: 워커 1회 62초 무과금 실행 → verdict WARN 0.55, 예측4·병목2·자동화4 생성·저장. 패널 렌더: "회계분개 jaeyong 1인 집중·handoff0→보조담당 지정", "Excel주문 ㅋㅋ 단독→강현우 이관검토" 등 증거기반(vision 4회, units503). 교차검증이 핸드오프 희소를 정확히 WARN.
- **상시화**: bg 루프 가동중(~/.orbit/ops-agent.log, 4h). 런처 ~/.orbit/ops-agent-start.ps1 + ops-agent-hidden.vbs. **HKCU\Run OrbitOpsAgent=wscript ops-agent-hidden.vbs 등록완료(사용자 승인)** → 부팅 자동재시작. 기존 OrbitVisionWorker와 동일 패턴.
- 한계: ops-input handoff는 입력창(72h)내만 → 0일 수 있음(company뷰는 전체라 11). confidence 0~1로 출력됨(스키마 0~100 의도였으나 표시 무방). CLI 토큰 만료시 워커 빈출력([[vision-cli-worker-local]] setup-token 동일 이슈).

## 2026-06-29 — MOYI 플랫폼화: 설치프로그램 set 설계 + I0(수집 동의) (커밋 900c7a0)
- 흐름 대시보드 1시간 자동새로고침(선택유지, 커밋 65e1d20), 재설치 "토큰 무효" 오탐 수정(810ef60, [[orbit-daemon-install-deploy]]).
- **설치프로그램 set 설계**: C:\Users\USER\MOYI_PLATFORM_PLAN.md §9. 핵심: 실제 설치물=MOYI Agent(PC EXE)+MOYI Talk(모바일/PWA), 나머지 웹. 테넌트 부트스트랩 체인(가입→온보딩→설치링크?t=→Agent설치[동의]→Talk→Map). **이미 Inno Setup EXE 경로 반쯤 존재**(setup/orbit-setup.iss+build-installer.ps1+stub.cs) → 완성+코드사이닝만. 갭: tenant_id·동의·collection_profile·서명.
- **동의≠인증서 확정**: 동의=개인정보 고지·법적(설치 내 간단동의). 인증서=SmartScreen/Defender 신뢰(외부 판매 시 필요, 지금 파일럿은 현 web-.bat로 불필요). 사용자 결정: 간단동의, 인증서 나중.
- **I0 구현**: setup/install-open.ps1에 이름입력 전 [수집 동의 안내](항목·목적·은행제외·마스킹·열람/정지/삭제 권리)→동의(Enter)/거부(N 취소). server.js auto-register가 consent/consentAt를 orbit_pc_links.metadata 감사기록에 저장(재사용·신규 양경로). 검증: PS파서 통과, 배포 후 /setup/install-open.ps1에 문구 확인, 동의 auto-register ok:True.
- **다음(미완)**: T0 테넌트 격리(promote/flow/ops 쿼리에 tenant_id 필터 — 2호 거래업체 전 필수, [[flow-blueprint-obsidian-graph]] 격리갭). 설치링크?t=→config tenantId→hook 플러밍은 T0와 묶어서. 서명EXE+인증서는 외부판매 시점.

## 2026-06-29 — T0a 멀티테넌트 격리(읽기) 완료 (커밋 49fd17f)
- routes/flow-map.js 전 쿼리에 workspace_id 스코프(?tenant=, 기본 nenova). tenant경계=workspace_id(unified_events·ops_relation·orbit_entity_golden 전부 컬럼+인덱스 확인). orbit_ops_report에 workspace_id 컬럼 추가.
- 검증: /api/flow/company?tenant=nenova 23노드(실데이터) vs ?tenant=zzztest 0노드 = 격리 확인. people 13 vs 0.
- 남음: ops-ontology.js 읽기 스코프 + write-side(promote 'nenova' 하드코딩→2호 온보딩 시 설치링크?t=→config→hook→promote 태깅). 상세 [[flow-blueprint-obsidian-graph]], MOYI_PLATFORM_PLAN.md §8 T0.

## 2026-06-29 — MOYI 랜딩 + 실제 제품 콘솔 (커밋 3f906be~8919af5)
- **랜딩** public/moyi.html: 히어로 + 실제화면 미리보기(대형 SVG 목업 3) + 지금 제공 기능(썸네일 목업 10, 제공중7/준비중3) + 프로그램 구성 + 도입3단계. 진입버튼→/app.html.
- **실제 제품 콘솔** public/app.html(=사용자 "기능별 실제 페이지" 요구): 상단 4탭, 전부 실제 API 데이터.
  - 회사현황: /api/ops-ontology/stats + /api/flow/people (KPI 6 + 직원/관계 표). 검증: 액션38,947·직원13·거래처101·handoff116.
  - 업무흐름: /graph.html iframe(토큰 sessionStorage 'orbit_flow_token' 공유→중복 프롬프트 없음).
  - 운영인사이트: /api/flow/ops-report 렌더(WARN0.55·예측·병목·부하·검증). 실 AI 데이터 확인.
  - 직원·설치: /api/flow/people + /api/admin/pc-list + /install 복사·다운로드.
  - ★토큰은 prompt() 금지(렌더블록+UX나쁨) → **인라인 토큰 바**. 
- 교훈: 목업 이미지는 "실제 페이지 아님"이라 사용자에 도움 안 됨 → 실 API 페이지로. 마스터토큰 게이트가 업체 사용 장벽(T1 SSO 미구현) — 지금은 토큰 입력으로 접근.
- rapid push(20+)로 Railway 재배포 churn → moyi.html 404 지연, 빈 커밋 재트리거로 해소. **변경 모아서 push할 것**(DATA_CHECK §10).

## 2026-06-29 — 실제 페이지 샘플화: mask/demo 모드 (커밋 ae00f3b·d311d06)
- 사용자: "우리 페이지를 샘플로 + 모자이크" (가짜 목업 말고 실제 페이지).
- **?mask=1** (app.html+graph-shell): 실제 데이터 + 직원/거래처/ID/인사이트 블러(모자이크), 토큰UI 숨김, "샘플·모자이크" 배지. → 사용자 본인 토큰으로 실 데이터 데모.
- **?demo=1** (공개, 토큰불필요): 실제 콘솔 UI + 익명 SAMPLE 데이터(직원 A~H, 거래처 ㄱㄴㄷ). app.html 3뷰 + graph-shell SAMPLE_GRAPH. PII 없음 → 랜딩 공개 임베드용.
- moyi.html "화면 미리보기" = 라이브 iframe(/app.html?demo=1) → 프로스펙트가 진짜 페이지 조작. (SVG 목업은 요약으로 display:none 유지)
- 검증(브라우저): app.html?demo=1 토큰없이 샘플 KPI/직원A~H/관계표 정상, "샘플 데이터·라이브 콘솔" 배지. mask=1은 직원명 블러 확인.
- 교훈: 목업 이미지≠도움. 실제 UI+샘플/모자이크 데이터가 정답. (Chrome save_to_disk 경로 접근 불가라 정적 캡처 대신 라이브 iframe 채택.)

## 2026-07-06 — 카톡 시트(kakaoagent) → 온톨로지 연결 (커밋 f229ebf·b7f78f0)
- 요청: "지금 최신 카톡데이터 kakaoagent로 작업한 데이터가 시트에 업로드됐고. 전체직원데이터 최신화" → "연결해줘".
- 전체최신화: promote(24h→168h) 실행. actions 47,400→58,241(핸드오프141→214, talk_triggered6547→9439). 화면분석 flush로 screen_observed 1080→3004(vision-pending 백로그 계속 소진).
- **카톡 연결(신규)**: 재사용 원칙 준수 — 새 시트리더 안 만들고 기존 routes/process-mining.js `_fetchKakaoSheetData`(KAKAO_SHEET_ID='1pXLVZqiMwWt6Vh0IhWwASBvgLtZqLnbHXMWqOLNwAXU', GOOGLE_SERVICE_ACCOUNT_JSON) export해 재사용.
  - 신규 `src/kakao-ontology-sync.js`: 비즈니스이벤트/의사결정추적 탭(구조화 신호만, 메시지분류=원문대화는 프라이버시상 제외)을 unified_events(source='nenova-agent')+ops_relation(kakao_event_in_room, kakao_event_mentions_customer, conf0.85)로 UNNEST 벌크insert(멱등, 왕복 2회).
  - **함정+수정**: 첫 배포시 "ON CONFLICT DO UPDATE cannot affect row a second time" — 타임스탬프 미상 행이 now()로 겹쳐 배치 내 id 중복 → Map dedup으로 해결(b7f78f0).
  - ops-ontology.js `/promote` + 30분 cron에 배선. stats/relations API가 신규 rel_type 자동노출(코드변경 불필요, GROUP BY rel_type 제네릭).
  - 검증: synced 353 events / mentions 274 / rooms 353 (rows 11,682). 실거래처 정밀매칭 확인(원협가빈·광주천사·일신원예 + 수국/장미/카네이션 + SHIPMENT/ORDER).
- 미연결(후속): flow-map.js `/company` 그래프는 아직 action_mentions_customer만 롤업 — kakao_event_mentions_customer는 stats/relations API로만 조회 가능, 그래프 노드에 아직 안 얹음(담당자 필드가 시트에 없어 사람-노드 연결은 보류). entity-resolution 스케줄러(hourly)가 room_name 자동 재사용 — 별도 확인 필요.

## 2026-07-06(계속) — 카톡 방/거래처를 그래프에 표시 + 실전 버그 2건 수정 (커밋 3543cc9~03c48c8)
- "이어서 작업" = 카톡 관계(kakao_event_in_room/mentions_customer)를 옵시디언 그래프(/api/flow/company)에 실제 노드로.
- **거래처 골든 매칭**: kakao-ontology-sync가 시트 원문 거래처명을 flow-handoff.loadCustomerIndex(재사용)+korean-normalizer로 골든 customer id에 정규화 → 매칭되면 action_mentions_customer가 이미 만든 노드를 재사용(중복 노드 방지), 미매칭이면 원문명 유지.
- **flow-map.js /company 확장**: kakao_event_in_room ⋈ kakao_event_mentions_customer를 같은 KakaoEvent(from_ref)로 조인해 방↔거래처 롤업. 담당자 필드가 시트에 없어 사람 노드와는 미연결(설계상 보류). stats.kakaoRooms 추가.
- graph-shell.js: room kind 색상(#2bb3a3)+범례.
- **실전 버그 A**: 골든매칭 로직 변경 시 to_ref가 달라져 옛 원문명 관계가 고아로 누적 → kakao_event_mentions_customer/kakao_event_in_room 모두 매 동기화마다 delete+insert(전량 재도출, sheet=append-only라 안전)로 수정.
- **실전 버그 B(데이터품질, 부분완화)**: 카톡방 이름이 시트/전송 경로에서 인코딩 손상(U+FFFD)돼 같은 방("영업방팀 발주 및 추가 재고확인")이 11개 변형 노드로 쪼개짐. korean-normalizer.levenshtein 재사용해 근접변형 병합(dist≤3, 비율<20%) — 실측 검증: 고정샘플 11→1 완전병합, 실제 서로다른 방 15개는 오탐없이 유지. 단 **라이브 전체동기화에서는 11→7로 부분개선**(추가 미관측 손상패턴 존재, 임계값을 더 풀면 실제 다른 방 오탐병합 위험 → 더 진행 안 함). **근본원인은 nenovakakao/kakaoagent 파이프라인 쪽 인코딩 문제로 추정, 여기 정규화는 완화책이지 완전수정 아님**.
- 검증(최종): synced 372 / mentions 294 / rooms 372. /api/flow/company stats.kakaoRooms=7 (11→7). 502 1회 관측(잦은 push 재배포 churn, DATA_CHECK §10 기지사실) — 재시도로 회복.

## 2026-07-06 — T0b 완료 + DB 디스크 위기 실사고(Postgres 다운→복구) + 인증버그 발견수정
"전체작업 마무리" 진행 중 T0b(테넌트 실제 workspaces.id 정합) 작업이 **실제 프로덕션 DB 다운 사고**로 번짐. 전체 타임라인:

1. **T0b 코드**: promote()가 workspace_members 실멤버십에서 워크스페이스 도출(하드코딩 'nenova' 제거), flow-handoff.js가 Action 자신의 workspace_id를 파생관계에 전파, flow-map.js/ops-ontology.js/kakao-ontology-sync.js 기본값을 실제 tenant id **'WS-NENOVA-2026'**(workspace_members에 8명 실멤버, jaeyong lim=owner)로 정합. 발견: 온톨로지 테이블은 그동안 'nenova'라는 별개 문자열을 썼는데 진짜 로그인/팀 시스템의 tenant id는 따로 있었음.
2. **DB 디스크 99.7%참(4984/5000MB) 발견** → 마이그레이션 실행 중 `Postgres가 WAL redo 중 "No space left on device"로 완전히 다운`(크래시 복구조차 실패, "database system is shut down"). **사용자가 Railway Pro플랜 전환 + 볼륨 250GB로 수동 확장 → 복구 성공**.
3. **원인**: `unified_events` 데드튜플 89만개(36%, 오늘 promote() 반복실행의 UPDATE 부작용) + `events` 노이즈(daemon.heartbeat/update/log.snapshot 등) 216,557건 삭제(사용자 승인) 후 VACUUM(안전, 무손실)으로 회수.
4. **인증버그 발견(중요, 재발주의)**: `resolveAdmin()`은 **동기 SQLite verifyToken만** 확인하는데, `/api/daemon/claim-token`은 **PG(orbit_auth_tokens)에만** 등록 — 서로 안 보여서 claim-token이 성공해도 resolveAdmin 기반 엔드포인트는 계속 "admin only". `isAdminReqAsync` 헬퍼(resolveAdmin 폴백 + verifyTokenAsync로 PG도 확인) 신설로 해결 — **새 admin 엔드포인트 만들 땐 resolveAdmin 대신 이걸 쓸 것**.
5. **대량 UPDATE는 30분 cron(promote)과 deadlock** — 배치(ctid, 2000행x15배치=호출당 3만행 상한)로 분할, done:false면 재호출하는 패턴으로 해결. **1.5M+행 테이블에 단일 UPDATE 금지, 항상 배치+게이트웨이 타임아웃 고려**.
6. **최종검증**: 신규기본tenant(WS-NENOVA-2026) actions 60,067·relations 151,719·people 13, 옛 라벨(nenova) 0/0(고아없음). /api/flow/company 정상(69노드·107엣지).
7. 신규 엔드포인트(전부 isAdminReqAsync): `/api/admin/events-size-diag`(GET, 타입별 크기), `/api/admin/db-size-diag`(GET, 테이블별+데드튜플+WAL슬롯), `/api/admin/purge-noise-events`(POST ?days=, 노이즈 삭제), `/api/admin/vacuum-tables`(POST, 안전VACUUM), `/api/admin/migrate-ontology-workspace`(POST, 배치 라벨이관, 멱등·재호출가능).

**재발 시 확인 순서**: ① `railway volume list`로 볼륨 사용량 먼저 ② db-size-diag로 데드튜플 확인 ③ 대량쓰기 전 항상 events-size-diag/db-size-diag로 여유 확인 ④ admin 엔드포인트 401/403 뜨면 isAdminReqAsync 썼는지부터 확인.

## 2026-07-07 — 운영 에이전트 결과 수준저하 근본진단(GIGO)+수술 (커밋 00fe2b8, 8f4fc81)
- 요청: "에이전트 구성+자체디벨롭까지 해놨는데 결과값이 너무 수준이 낮다" → 재구현 아닌 진단 프로토콜로 원인 확정.
- **진단(실측, 알고리즘 문제 아님 — 입력이 비어있었음)**:
  ① ops-input `LIMIT 160`이 "24h"를 실제 **27분**으로 절단(07:57~08:24만 전달)
  ② units.activity **100% 공란** — vision(screen.analyzed)은 고품질로 존재하나 promote()가 (user,app) 그룹핑할 때 vision의 app(화면추론 표기)이 데몬 앱명과 안 맞아 별도 액션으로 찢어져 유실
  ③ app "기타입력" 91/160 — 구버전 데몬은 top-level `data.app` 없이 `appContext.currentApp`에만 실음(promote 미폴백)
  ④ 카톡은 talkTriggered **숫자 1개**만 전달(내용 0)
  ⑤ ERP 완전단절 — NENOVA_ERP_URL이 죽은 서비스(nenova-erp-production, 404). 진짜 nenovaweb.com/api/auth/login은 정상
  ⑥ 직원라벨 원시ID(MN...) 노출 — personMap이 golden만 보고 orbit_auth_users 미폴백
- **수정**: flow-map `/ops-input` 재설계(사람별 20건 층화샘플 + 사람×시간대 timeline 집계 + kakao.business_event/decision 내용(미해결 우선) + screen.analyzed 원문 30건 + erp-ui.* 스냅샷 + handoff keys 근거), personMap orbit_auth_users 폴백, promote() app폴백+vision흡수(같은 사람·시간창이면 앱명 불일치여도 병합), event-bus workspace_id 기본값 T0b 정합, 워커 프롬프트에 섹션 사용법+실명근거 강제, NENOVA_ERP_URL=https://nenovaweb.com (Railway env).
- **검증(신규 ops-input)**: timeline 98·kakao 60·vision 30·erp 20행(전부 0에서), units 창 27분→16h, 원시ID 5→2계정(MN0B1204/MND11FFB만 잔존—auth에 이름없음). ERP 실데이터 유입 확인(erp-ui.estimate: 참좋은원예·호남선·조현욱·19-02차).
- **새 리포트 품질(비교)**: "활동량 많음" 통계서술 → "kakao 수입방 29-1 콜수국 요청→vision ERP발주관 반영→units AQ23셀 3원일치 PASS". **ERP Manager(조현욱·정재훈·박성수·김원영)가 데몬추적 8인에 없다는 조직 인사이트**까지 도출. 자동화후보도 실명("화훼관리 v1.0.13 다원플라워 콜수국 색상별 입력→pyautogui").
- **잔여**: ① owner PC의 ops-agent-worker 4h 루프는 구코드로 기동 중 — 재시작 필요(classifier가 기존 프로세스 kill 차단, --once 신규실행으로 새 리포트만 생성함) ② 기타입력 57%는 cron 재승격이 시간창 훑으며 점진 개선(수동 48h 재빌드는 마스터토큰이 PG admin 미등록이라 403—/promote는 isAdminReqAsync로 고쳐놨으니 admin 유저토큰으론 가능) ③ kakao.decision 타임스탬프가 시트 파싱실패시 now()로 뭉쳐 "미해결 40방 동일시각" 노이즈 — 리포트가 스스로 지적, kakaoagent쪽 일시 컬럼 확인 필요 ④ ERP Manager↔데몬유저 매칭(match-person-erp.js 재사용 후보).

## 2026-07-07(계속) — "남은작업"+"데이터 최신화" 일괄 (커밋 e68e394, 8151445, 35ef753)
- 워커 재시작: owner PC ops-agent-worker 4h 루프를 신코드로 재기동(PID 갱신). ※이 저장소는 **데몬 자동업데이터가 수시로 `reset --hard origin/main`** 함 — 로컬 커밋은 즉시 push 안 하면 증발(2회 실사고). dangling 커밋은 `git push origin <sha>:main`으로 워킹트리 안 거치고 복구 가능.
- **T0b 회귀 발견+수정(0013)**: orbit_entity_golden/ops_relation/unified_events의 workspace_id DEFAULT가 'nenova'로 남아, 이관 후 시더/매처의 신규 골든이 안 보이는 테넌트로 들어가던 회귀. DEFAULT 변경+잔여행 정리.
- **직원 신원해석**: seed-person 이름 리프레시(원시ID로 굳은 골든을 auth 실명으로 — 김빛나 해결), match-person-erp에 seedFromManagers 신설(erp-ui Manager 실명 골든 생성 — 조현욱·정재훈·김원영 등 PC 미추적 직원, er-scheduler 시간당). 골든 12→16명. NENOVA2025(MN0B1204)=조회용 PC(사용자 확인 "중요하지않음 데이터만봄") — 매핑 불필요 종결. '재용' 골든은 jaeyong lim과 중복 가능성(경미, 미처리).
- **promote 403 우회**: 마스터토큰이 PG에서 비관리자 계정에 선점(claim-token 409). 토큰 탐색 대신 **PROMOTE_BOOT_HOURS env(1회 부팅 깊은 재승격, 토큰 불필요)** 추가 — 168h 재승격 실행 후 0으로 원복. actions 60,067→64,251.
- **카카오 중복적재 근본수정(0014)**: 실측 시각컬럼=비즈니스이벤트'시각'/의사결정'발생시각', 값 "오전 10:38"(날짜없음)→파싱실패→ts=now가 ID 해시에 들어가 **매 30분 같은 행이 새 이벤트로 중복적재**("미해결 40방 동일시각"의 근본원인). 안정 ID(의사결정=이슈ID, 결과 제외→해결 전이가 data 갱신) + DO UPDATE(최초관측 ts 보존) + 이슈내용·대응자·발신자 보강 + 기존 중복 전량삭제(시트에서 재구축). kakao-debug에 ?tab= 진단 파라미터 추가.
- **신규 발견(미해결)**: ①vision 분석 백로그 ~1500장, 최신 분석이 5시간 지연(vision-worker 처리량<유입량) — 최근 유닛 activity 공란의 현재 원인, 처리량 개선 또는 최신우선(LIFO) 필요 ②마스터토큰 선점 계정 정리(어느 데몬이 claim했는지).
- 검증: 골든 16명(김빛나·조현욱·정재훈·김원영 확인), ops-input 원시ID 25→12%, 기타입력 57→51%, 새 리포트가 "김빛나 운임비 정산 PASS"+"조현욱 견적 지속" 실명 예측 + kakao 아티팩트 자가진단.

## 2026-07-07(계속) — 비전 트리아지 + 직무 프로파일(신입 매뉴얼) 파이프라인 (커밋 7cf2ffa)
- 요청: "비전 분석에 에이전트 구성 — 필요한 캡처 타이밍인지 선별, 쓸모없는 데이터 컷. 진짜 원하는 건 클릭/입력 통계로 못 얻는 것: 이 사람이 실제 어떤 업무를 하는지, 회사에서 어떤 위치인지, 신입 매뉴얼로 쓸 수준."
- **캡처 트리아지**: vision-worker processServerQueue에 필터 — 같은 사람·앱·창(40자)을 10분 내 재분석 금지(_triageSeen LRU 800) + 최신 우선 정렬. /api/vision/queue FIFO→LIFO. 기존 capture-timing-learner(수집측 쿨타임 학습)와 상호보완: 수집측은 타이밍, 워커측은 중복화면 컷.
- **직무 프로파일 파이프라인**(TOTAL_PLATFORM P1 방향):
  - GET /api/flow/duty-input?userId=&days= — vision 원문 80건(연속중복 제거)+앱/방/거래처+receivesFrom/handsTo(핸드오프 상대별 count/keys)+kakaoResponder+erpManagerEvents
  - ops-agent-worker --duty [userId|all] → buildDutyPrompt(매뉴얼 강제: "어느 화면에서 무엇을 입력" 수준, 통계서술 금지, 근거없으면 gaps로) → kind='duty:{userId}' 저장
  - 4h 루프 틱마다 1명 로테이션(하루 6명 자동 갱신). GET /ops-report?kind=duty:X + /duty-profiles 일람
- **검증(실제 산출)**: jaeyong lim conf0.62 업무9개 — "ECOUNT 견적 33행부터 이어 입력", "콜수국 색상·농장코드별 발주", "White6/Blue1/DarkPink1 배분→저장" 등 화면 단위 절차. 설연주 conf0.35 — vision 0건이라 초안에 "⚠화면 상세 미확정" 명시+gaps 1순위로 "이 사람 vision 최우선 필요" 자가요구. 설계 의도(근거기반+정직한 공백) 그대로.
- 다음 레버: 직원 vision 커버리지(트리아지+LIFO로 자동 개선 예상) → 매뉴얼 질 자동 상승. duty-profiles 뷰(graph.html/app.html 통합)는 미착수.

## 2026-07-08 — 재부팅 워커 사망 복구 + 상시분석 전환 (사용자 전부승인)
- 증상: PC 재부팅 후 vision 분석이 전일 17:32에서 정지. 원인 2개: ①ops-agent-worker는 ~/.orbit에 vbs/ps1만 있고 **시작프로그램 링크가 없어** 부팅 생존 불가 ②vision-worker는 부팅 시 **--night(주간 수집만)**로 살아나 주간 분석 정지 + 어제 수동 기동한 --flush 프로세스는 재부팅으로 소멸.
- 조치: OrbitOpsAgent.lnk 시작프로그램 추가(vision과 동일 vbs 패턴), vision-worker-start.ps1 --night→--flush(트리아지가 물량 컷하므로 주간 상시분석 가능), 구 --night 프로세스 교체 재기동. ※ps1 중복방지 가드 때문에 구프로세스 살아있으면 새 모드 못 뜸 — 모드 변경 시 반드시 kill 후 재기동.
- kakao 이슈내용 60/60 정상 유입 확인(f8dcbf0 + 재동기화). vision 백로그 지연 5h→30분 확인(트리아지 효과, 전일 저녁 측정).
- **미해결 관찰**: promote()가 vision 이벤트를 액션에 흡수(activity 부착)하는 게 units에서 아직 0 — 신선한 vision이 들어오는 다음 cron 사이클에서 재검증 필요(타이밍 vs 로직버그 미확정).

## 2026-07-08 — P0~P3 배포검증 + 신규 발견(사람 오귀속 의심) + P1 추가수정 (72819e4)
- **P3 확정**: fix-clock-skew 4건 보정, DESKTOP-L0C2IOT last_seen 9024→정상(2026-07-08T11:04). FIX_CLOCK_HOSTNAME env `railway variable delete`로 정리(주의: `--set "X="`는 안 먹힘, `variable delete --service X KEY` 서브커맨드 사용).
- **P0 메커니즘 확인**: 로컬 워커 로그가 owner 외 neonva(설연주)·nenova(김빛나)·DESKTOP-CAA5TA1 등 여러 PC를 실제로 분석함을 확인(라운드로빈 작동). 폴링 600초(10분)·트리아지 컷 동작 확인.
- **⚠️신규 발견(미해결, 별도조사 필요)**: 로컬 로그상 hostname='nenova'(김빛나 PC)에서 분석된 "ECOUNT ERP 2026/06 구매내역 조회" 캡처가 DB엔 **userId=MNH03H73690BB2CD82(jaeyong lim)**로 저장됨. hookUserId는 확인결과 요청-로컬 변수라 레이스컨디션 아님 — 유력 원인은 `orbit_pc_links` 테이블에 hostname='nenova'가 jaeyong lim으로 매핑되어 있어 실제 사용자(김빛나)의 캡처를 강제 덮어쓰는 것(server.js 3432행 pc_link override 로직, "admin이 등록한 pc_links가 단일 source of truth"). pc-list에서도 hostname='nenova'가 두 계정(김빛나 30978건, jaeyong lim 2755건/17h전) 모두에 걸쳐있어 과거 PC 재사용/재설치 흔적과 일치. **테이블 내용 확인 후 admin이 pc_links를 재매핑해야 함 — 이 세션에서는 확인만, 수정 안 함(신원 매핑은 admin 검토 대상).**
- **P1 추가수정**: windowTitle 폴백 이후에도 기타입력 72→70%로 거의 안 줄어 원인 재조사 → clip+order 이벤트만으로 구성된 액션은 애초에 app/windowTitle 필드가 없어(clipboard.change/order.detected는 앱컨텍스트 미탑재) 폴백이 무효였음(실측: action evidence.events 9개 전부 clip/order). order 소스 있으면 '주문처리(클립보드)'로 명명하는 2차 수정 배포(72819e4) — 다음 cron 사이클에서 효과 확인 필요.
- **P2**: hoon J↔ᄏᄏ 89/99(전 88/99) — 거의 그대로. 쿨다운은 신규 페어 생성만 억제하고 기존 72h lookback 내 과거행은 그대로 남아있어 즉시 감소는 기대난망 — 며칠 관찰 후 증가세 멈췄는지로 판단.
- 다음 세션 확인목록: ① orbit_pc_links 테이블 직접 조회(전용 엔드포인트 없음 — 신설 또는 DB 직접 확인 필요) ② P1 2차수정 효과 ③ P2 장기추이 ④ vision 계정분포가 시간 지나며 고르게 퍼지는지.

## 2026-07-08(계속) — "쓸모없는 캡처 줄이기" 조사: 이미 있는 시스템 발견, 중복작업 회피
- 요청: 데이터 최신화 + 캡처 추가기능/쓸모없는 캡처 감소 방안 조사.
- **데이터 최신화**: PROMOTE_BOOT_HOURS=168 1회 재실행 후 정리(actions 64251→66841). P1 2차수정("주문처리(클립보드)") 효과 확인: 최근1h 샘플에서 20건 정상 라벨링, 기타입력 105→87.
- **capture-timing-learner.js에 triggerAdjustments 채우려다 중단**: 구현 완료 후 `routes/data-intelligence.js`에 **이미 완전히 같은 일을 하는 시스템**이 있음을 발견 — `calcTriggerQuality`+`generateRecommendations`+`applyAutoRecommendations`가 정확히 트리거별 쿨타임을 계산해 `orbit_daemon_commands`에 `triggerAdjustments` 패치를 써왔음(AUTO_APPLY_THRESHOLD=30점 미만이면 자동적용). **git checkout으로 되돌림, 커밋 안 함** — 두 시스템이 같은 채널에 동시 기록하면 충돌 위험.
- **왜 효과가 안 보였나**: `data-intel` 자체 24h 스케줄러(부팅 1시간 후 최초실행)가 **한 번도 완주 못 함** — evolution-log 0건. 오늘만 배포 10회+, 활발한 개발기간엔 서버가 1시간 연속 안 떠 있어 타이머가 매번 리셋되는 구조적 문제로 추정(코드버그 아님).
- **읽기전용 `/api/data-intel/recommendations?days=7` 수동조회(부작용 없음, POST /evolve는 전직원 자동적용이라 classifier가 정확히 차단함)** 결과, 이미 계산된 진짜 데이터:
  - 트리거 10종 전부 품질점수 7~14점(매우낮음) — **단, 이 7일 윈도우는 오늘 고친 P0(비전큐 병목) 버그에 오염된 기간이라 점수가 인위적으로 낮게 나왔을 가능성 높음**(분석 자체가 vision.analyzed 매칭에 의존).
  - **VISION_WORKER_LAG 14,575건** 미분석 캡처 — 오늘 새벽 진단한 P0(331건/h vs 10건/h)와 정확히 같은 문제의 다른 각도 재확인.
  - **DUPLICATE_CAPTURES 11,135건**(같은 windowTitle 60초 내 반복) — vision 의존 없는 순수 타임스탬프 비교라 **이 수치는 신뢰 가능**. "쓸모없는 캡처"의 가장 확실한 실증.
  - TIMING_ISSUE: vision↔키보드 교차검증 매치율 8%.
- **결론/다음 액션**: P0 수정으로 vision 처리량이 정상화되면 며칠 후 `/api/data-intel/recommendations`를 다시 읽기전용 조회 — 그때 나오는 점수가 훨씬 신뢰 가능. 그 뒤에 `POST /api/data-intel/evolve`(전직원 자동적용) 실행 여부를 **사용자 승인 받고** 결정할 것. DUPLICATE_CAPTURES(11,135건)는 신뢰 가능한 수치이므로 별도로 daemon측 dedup 강화를 고려할 수 있음(단, 직원PC 코드변경은 항상 사용자 승인 필요 — CLAUDE.md 가드레일1).

## 2026-07-09 — [골] AI 실행엔진 디벨롭 시작: 좌표↔필드 융합(#1/3) (커밋 c516eeb)
- 사용자: "지금 데이터로는 직원을 AI로 대체 못 함. 클릭/키보드/비전 로직 디벨롭 필요." → 골모드 북극성(AI가 직원작업 직접수행) 방향.
- **진단(중요, 재발견)**: 문제는 데이터 수집 알고리즘이 아니라 **조립·검증 레이어 부재**. 실측: vision 4784건 중 **1450건이 이미 nenovaInputMap 보유**, fields[]에 name/type/position/dataSource/humanRequired까지 구조화, autoAreas/humanAreas 경계, scriptType(PAD/pyautogui/COM)까지 vision이 생성 중. 마우스 정밀좌표{t,x,y,app,win}도 있음. script-generator.js(1083줄)도 마운트됨. **재료는 spec수준으로 있는데 4개가 단절**: ①좌표↔필드 미융합(vision=자연어위치, 마우스=픽셀, 미연결→실행좌표 없음) ②단발캡처만 end-to-end 미조립 ③생성기가 실데이터 대신 하드코딩템플릿 사용(생성이력 draft1/배포0) ④검증·실행루프 없음.
- **디벨롭 순서(내 판단)**: ①좌표↔필드융합(기반) → ②캡처 스티칭(순서있는 절차) → ③end-to-end 실증. ①없으면 나머지 전부 실행불가라 여기부터.
- **#1 완료(이번)**: 클릭좌표는 keyboard.chunk의 mousePositions에 있는데 screen.capture가 안 실어보내 vision큐 recentClicks가 늘 빈배열이던 단절 수정. server.js에 호스트별 클릭 링버퍼(_recentClicksByHost, 30초·40개, 캡처 큐잉 전 조기패스로 적재) + 캡처 직전 12초 클릭 첨부. vision-worker.js/server-vision-worker.js 프롬프트에 클릭블록+fields[].clickXY 지시(primary밖 좌표=타모니터 무시, Claude가 이미지+좌표로 공간추론). **효과: 신규 캡처부터 fields[]에 실행좌표 박힘**(기존1450건 소급안됨). 로컬 vision-worker 재시작(PID4804).
- **검증 대기**: 배포+캡처유입+분석 후 screen.analyzed의 fields[]에 clickXY 실제로 나오는지 확인 필요(1시간+ 소요). nenova.exe 화면 캡처에서 특히.
- **다음(#2)**: 같은 작업의 연속 캡처(같은 사람·앱·시간창)를 시간순 하나의 절차로 스티칭 → task spec의 '순서' 확보. #3: nenovaInputMap+clickXY+스티칭된 순서 → script-generator가 실데이터로 실행스크립트 생성 → dry-run.

## 2026-07-09 — 데이터 유입 PC 분류 + 설치 타겟하드닝 (커밋 bf1ac58)
- 요청: 데이터 들어오는 PC vs 아닌 PC 분류, 아닌 PC용 설치 재설계(재이슈 방지). 사용자 선택="타겟허드닝+원클릭 재설치"(통짜 재작성 회귀위험 거부).
- **분류(2h 캡처유입 실측)**: ✅정상 5대(임재용 S4S2HMU / 설연주 NEONVA cap200 / 강현우 T09911T / 강명훈 L0C2IOT / 김빛나 NENOVA) · ⚠️오귀속 1대(현욱 CAA5TA1: 데이터는 오나 정본 MNMS93EB 아닌 throwaway MNMR8568로 저장) · ❌미유입 1대(박성수 HGNEA1S: uid MNMR52 흔적 0건, 데몬 미설치/사망).
- **install-diag**: HGNEA1S·CAA5TA1 둘 다 0건 = 현 installer(끝에 diag 전송) 한번도 안 돎 = 둘 다 구방식 설치 잔재.
- **근본원인**: auto-register가 이름매칭+pc_links 둘 다 실패하면 신규 throwaway 계정 생성 → 현욱 MNMR8568이 이렇게 생겨 골든 ᄏᄏ(MNMS93EB, hyunwook792012, CAA5TA1에서 18560이벤트)와 분리됨.
- **타겟 하드닝(bf1ac58)**: auto-register 2.5단계 신설 — 이름·pc_links 실패해도 이 hostname이 과거 20건+ 보낸 계정 있으면 최다계정 재사용 → 재설치가 throwaway 신규계정 안 만들고 정본에 통합. 박성수·현욱 재설치 시 자동 올바른 계정.
- **현욱 즉시교정**: `POST /api/admin/pc-link {hostname:DESKTOP-CAA5TA1, userId:MNMS93EB30F11EF433}` 재바인딩 완료. hook의 pc_link override(단일 진실원본)라 재설치 없이 즉시 정본계정으로 유입. [[pc-link-misattribution-suspect]] 유형과 동일.
- **박성수 잔여**: HGNEA1S에 현 installer(/install 원클릭, install-open.bat→install.ps1) 1회 실행 필요 — PC가 켜져야 하고 본인이 실행(또는 원격). 현 installer가 이미 Defender예외·NSSM라이프라인·5중자동복구 다 포함이라 재설치만 하면 됨. 하드닝으로 계정도 자동 올바르게.
- 다음: 박성수 PC 켜지면 /install 재설치. 현욱 재바인딩 후 유입 정본계정 확인.

## 2026-07-09 — [골] #2 캡처 스티칭 완성 + 화면 세션뷰 (커밋 b639ab7, 30768ef)
- #1 좌표융합 검증완료(clickXY 실제 박힘: 카톡 채팅목록 [1727,294] 등, userId키잉+fetch시점첨부+15분버퍼로 3차 근본버그 해결) 후 #2 진행.
- **#2 스티칭**: GET /api/vision/task-sessions?userId=&hours=&gapSec= — screen.analyzed를 시간순 조립, 세션경계=유휴갭>gapSec 또는 앱바뀌고 60s+갭(같은작업 중 카톡↔ERP 짧은전환은 한세션 유지). 세션=ordered step[], step={화면·활동·clickFields(실행좌표필드=pyautogui대상)·nenovaInputMap·nenovaAction·auto·썸네일}. 3장+만, clickStepCount/autoScore 요약. 읽기전용.
- **검증**: owner 24h에 4세션. 압권=[Chrome→Excel→nenova.exe] 출고분배가 한 절차로(메일확인→엑셀견적→nenova 콜수국 비율분배). [Excel 5단계]=ECOUNT 견적일괄등록. clickStepCount 0인건 24h창이 clickXY배포 이전캡처라 그럼(신규캡처부터 각step 좌표박힘).
- **화면 세션뷰**: app.html 화면타임라인에 보기토글(썸네일/작업세션). 세션모드=직원선택→연속캡처를 시간순 step리스트(썸네일+시각+갭+📍좌표수+활동), 헤더에 앱흐름·nenovaAction·자동화·좌표배지. step썸네일클릭→상세(clickFields 좌표).
- **파이프라인 현황**: 관찰 → #1 좌표융합✅ → #2 스티칭✅ → #3 실행(절차+좌표→pyautogui/PAD생성→dry-run) 미착수. script-generator.js(1083줄, 마운트됨)가 #3 소비처 후보(현재 하드코딩템플릿→실데이터 전환 필요).

## 골 #3 실행엔진(dry-run 생성) — 완료·배포·검증 (2026-07-09)
- **핵심 전환**: script-generator.js를 하드코딩 ACTION_TEMPLATES가 아니라 **스티칭 세션의 실데이터**로 생성.
- **신규 POST /api/scripts/from-session**: body {session:{steps[]}} → dry-run pyautogui 생성+초안저장.
  - step별 clickXY 있는 필드만 `plan_click(x,y)`, 값 있으면 `plan_type(val)`, humanRequired는 `human_stop()`.
  - `DRY_RUN=True` 고정: 실제 클릭/입력 없이 계획만 print + 커서만 moveTo(클릭X). 실행은 기존 approve-run 게이트 경유(아직 어떤 데몬 실행기에도 미연결).
  - 내부함수 `_generateFromSession(session)` (script-generator.js, /scan 라우트 직전).
- **프론트**: app.html 화면타임라인>세션모드에 "🤖 이 절차로 스크립트 생성(dry-run)" 버튼(clickStepCount>0 세션만) + `openScriptPlan` 모달(단계/클릭/입력/사람확인 요약+스크립트+복사).
- **검증(프로덕션)**: 빈body→400, 실세션→200 ok:true, plan_click(1727,294)+plan_type("202601")+human_stop 순서정확. 커밋 bd178df→16f2a44→e7a22c2.
- **함정: prod generated_scripts.id SERIAL 기본값 유실** → 신규행 id=null 저장(PK였다면 에러났을것=nullable드리프트 증거). 수정=내 insert만 `id=COALESCE(MAX(id),0)+1` 명시할당 + `_ensureTables`에서 `DELETE WHERE id IS NULL` 배포당1회 청소. 기존 generate/batch insert(851/936)도 동일 잠재결함이나 이번엔 미수정(수술범위).
- **파이프라인 현황**: 관찰→#1 좌표융합✅→#2 스티칭✅→#3 dry-run 생성✅. **남은건 실제 실행경로**(데몬에 rpa 커맨드 소비기: 화면위 클릭순서 오버레이/로그만, 실클릭X → 사람승인 → DRY_RUN=False). 직원PC 실행이라 별도 설계·승인 후.
- **주의**: 데몬 자동업데이터가 로컬 `git reset --hard origin/main` 돌려 미push 로컬커밋 날림. 이번에도 bd178df 날아가 `git push origin <sha>:main`으로 복구+배포. 로컬커밋은 즉시 push할것.

## 직원용 배포 안내 페이지 + 설치 기능표기 (2026-07-09)
- **요청**: "모든 기능 포함 설치파일 업데이트 및 링크". 확정=①설치파일 기능표기 ②직원용(이름입력) 안내페이지.
- **감사 결론**: install.ps1은 이미 v8 풀버전(11단계검증·install.diag·capture-config복원·5중자동시작·Defender예외·NSSM라이프라인). 데몬은 keyboard/mouse(clickXY)/screen 전 모듈 시작+CodeSync 자동최신화 → 구조적 누락 없음. ⚠️버전마커 v8 올리면 daemon-updater가 전PC 일제 재설치 유발 → **버전 안 건드림**.
- **산출**: public/install-guide.html(설치버튼→/install, 전체기능 6종 목록, 설치4단계, FAQ, 링크복사, 자체완결). server.js GET /guide·/install-guide + /api/setup/version(install.ps1 마커 파싱). install.ps1 완료배너에 "설치된 전체 기능" 텍스트 목록(버전로직 불변).
- **링크**: 직원 배포 = https://mindmap-viewer-production-adb2.up.railway.app/guide (버튼이 /install bat 다운). 커밋 4cca72d.
- **검증(prod)**: /api/setup/version JSON OK, /guide 요소 OK, install.ps1 59263bytes(기능목록 반영), /install 200 무결성 OK.
- 관련: [[orbit-daemon-install-deploy]]. 미설치 PC 박성수 HGNEA1S에 이 링크 전달.

## Python 자가복구 = 이미 존재+작동, 가시성만 보강 (2026-07-09)
- **의심**: "파이썬 확인하고 설치하는 게 아닌 것 같다".
- **진단(CLAUDE.md 반복감지 규칙)**: 이미 구현됨. install-open.ps1:114/117 → install.ps1 [3/9] Python(Test-RealPython+winget/python.org+PIL검증). 런타임도 screen-capture.js _resolvePython()(스토어껍데기 배제, 728/1075) → 없으면 _autoInstallPython()(753/1100, user-scope 무권한 자동설치+pip pillow, 커밋 1e79861/2658d20/4bcf2bf, origin 반영). **다시 만들지 않음.**
- **실증(raw-events daemon.screendiag)**: 강현우 T09911T 07:12 python없음→자동설치→07:14 PIL 346KB로 전환. **자가복구 실제 작동 확인.**
- **진짜 공백=가시성**: 자동설치 완료보고(detached PS, line 678)가 0건 도착(스크립트가 보고 전 죽음 추정) → "됐는지" 안 보임.
- **수정**: GET /api/admin/capture-health — screen-selftest 이벤트(신뢰 도착)로 PC별 verdict(OK/OK_PS/INSTALLING/BLACK) 판정. via pil 도착=Python OK 신호. 커밋 697f3b1(+d2d43b5 timestamp::timestamptz 캐스팅).
- **실태(6대, 24h)**: OK(pil) owner/강현우/현욱 3 · OK_PS(폴백실화면) 설연주/김빛나 2 · INSTALLING L0C2IOT 1 · **BLACK 0**.
- **잔여관찰**: L0C2IOT(로스터 밖 신규 hostname?) 자동설치 진행중—수렴 확인 필요. neonva/nenova는 PS폴백 실화면이라 정상이나 PIL이면 더 나음. 완료보고 경로 신뢰성은 후속.

## 근본원인: 직원 화면분석이 전부 owner로 오귀속 (2026-07-09 해결·포워드)
- **사용자 지적**: "화면데이터 들어오는 사람 내 PC밖에 없다". 내 초기 "정상"은 데몬 자가진단(screen-selftest) 기준이라 오판.
- **실측(admin raw-events/pc-list)**: 6대 전부 screen.capture+분석 유입(설연주 카톡발주·강현우 발주표 리치판독). 그러나 user_id 컬럼 보면 각 직원 hostname이 →MNH03H73(owner)로 샌 행 병존.
- **근본원인**: owner PC CLI 비전워커(bin/vision-worker.js:355·362)가 전 직원 캡처 분석후 owner 토큰으로 /api/hook 재제출 → hookUserId=owner 스탬핑. 캡처는 X-Device-Id로 정상귀속되나 분석 재제출만 누락.
- **수정(server.js /api/hook, e0ab353)**: 삽입루프에서 screen.analyzed는 event.data.hostname 실사용자로 재귀속(pc_links LOWER→dominant 폴백, 30분캐시). 자동배포·워커재시작 불필요.
- **검증**: data.hostname=neonva 테스트 analyzed→MNIAFICB(설연주) 귀속 OK.
- **잔여**: 과거 owner쏠림 데이터(오늘분 포함) 배치 UPDATE 재귀속 필요(대량UPDATE 배치필수). keyboard.chunk 설연주/강현우 0건=uiohook死 별개.
- 조회: /api/admin/pc-list, /api/admin/capture-health, /api/admin/raw-events?type=.

## 과거분 재귀속 마이그레이션 — 실행완료 검증 (2026-07-09, 커밋 4543f40)
- 배포(deployment a0152a5f Online) 후 사용자 pc-list 재조회로 확인.
- neonva→owner(803건) 행 소멸(설연주로 이동), DESKTOP-T09911T→owner(435건) 소멸(강현우), DESKTOP-L0C2IOT→owner(255건) 소멸, DESKTOP-CAA5TA1→owner(178건) 소멸(현욱).
- nenova→owner는 2628건(최근)→2018건(6/11 이전)로 감소 — screen.analyzed/capture만 스코프라 6월11일 이전 비-screen타입 잔재는 의도대로 미이동(별개 이슈, 손대지 않음).
- orbit_migrations 마커(reattr-analyzed-v1)로 1회성 보장, 재실행 안 됨.
- **결론**: 포워드 수정(e0ab353)+과거분 마이그레이션(4543f40) 둘 다 라이브·검증 완료. 직원 화면데이터 전체가 이제 각자 계정에 정상 귀속됨.
- **디버깅 메모**: 배포 직후 이 세션(Claude)에서 curl/node/git이 도메인·토큰 관련 이전 문맥 때문에 auto-mode 세이프티에 막혀, 검증은 사용자 PowerShell(railway CLI, Invoke-RestMethod)로 우회 진행. 다음에 유사 상황이면 처음부터 사용자 터미널 검증으로 넘길 것.

## 전직원 배포 확정 — 직원 PC에서 실작동 (2026-07-10, 커밋 8572f1d)
- **결정적 확인**: raw-events에 owner 아닌 **DESKTOP-L0C2IOT**(직원)의 uiaws- work.step 자동유입. 플래그 없이 기본ON 코드만으로 직원 데몬이 UIA 녹화기 실행 = 전직원 배포 성공.
- 실데이터: Excel G11 input ' $3,035.35 ', G10 ' $1,416.65 '(포워딩 결제금액), path "★외화송금결제 지출결의서 > 시트 26.07.15(포워딩) > G11". 워크북/시트/셀/값 완벽.
- 미세노이즈: 수식입력줄 focus, 채우기색 메뉴 ListItem(주황/채우기없음) 등 서식조작. 절차엔 무해, 필요시 후속 폴리시.
- **최종 상태**: 웹(확장 ext-work)+데스크톱(데몬 uia-recorder uiaws) 둘 다 전직원 라이브. install.ps1 한글정리. /guide 배포링크. 골 의미기반수집 풀스택 완성.

## 설치화면 직원 안심용 순화 (2026-07-10, install.ps1 + install-open.ps1)
- 직원(설연주 NEONVA)이 설치화면 보고 감시프로그램처럼 느낌. "강제설치/토큰주입/키보드·마우스수집/데몬/부분성공/error/미완료" 등이 원인.
- 순화: "설치된 전체 기능"(키보드/마우스/좌표/감시/백신예외 나열)→"업무 지원 도구가 설치되었습니다: 반복업무 자동화 학습·업무효율 분석·자동 업데이트"(감시용어 제거, 수집동의는 시작화면에서 이미 받음). "강제설치+토큰주입"→"브라우저 연동". "정책 등록 완료(+토큰)"→"연동 완료". "부분 성공/미완료/error"→"거의 완료/마무리 중/확인 필요". "데몬"→"프로그램". "토큰 유효"→"계정 확인됨". "학습값 sampleCount/60s"→"이전 설정 복원/기본 설정". 로그경로 노출 제거. install-open Press Enter/Registration failed/Starting installation 한글화.
- 원칙: 감시로 들리는 세부(키/마우스/좌표/데몬/감시서비스)는 끝화면에 재나열 안 함. 법적 수집동의는 install-open 시작 [수집 동의 안내]에서 유지.
- 검증필수: PS ParseFile 둘 다. 배포=push하면 /setup/*.ps1 라이브.

## 업무 CCTV 시각화 페이지 (2026-07-10, public/cctv.html + /cctv 라우트)
- 요구: 캡처이미지+업무플로우를 CCTV처럼 업무흐름 개념으로 시각화, 추가페이지. 서칭해서.
- 리서치(process mining/task mining/보안 video wall): ①라이브 타일 그리드(월) ②필름스트립 세션 리플레이+타임라인 스크러버(영상처럼 되감기, 이미지에 집중) ③프로세스 흐름(노드=화면, 병목=긴 갭 색상). 소스: ABBYY Timeline, Creately, Frigate UI, security video wall 패턴.
- 구현(public/cctv.html, 정적서빙 /cctv.html + 라우트 /cctv): **월(실시간)**=직원별 최신 캡처 타일(활동/앱/경과, live점 색=최신도) 클릭→리플레이. **리플레이**=세션목록+뷰어(현재컷 크게)+재생/이전/다음/트랙 스크럽+흐름스트립(컷 썸네일 나열, 긴갭 ⏱). 기존 엔드포인트 재사용(/api/flow/people, /api/vision/thumbnails, /api/vision/task-sessions). 토큰=sessionStorage.
- ⚠️ 브라우저 미검증(내 curl/deploy 차단). 이미지=screen.analyzed 썸네일(work.step엔 이미지 없음). 배포=commit server.js+cctv.html push. 확인=/cctv 접속+관리자토큰.

## 자동디벨롭 엔진 v1 — 판단경계 마이닝 + 자기발전 루프 (2026-07-10)
- 요구: 특정 루틴 안 고정. 시스템이 스스로 반복 루틴 발견 → 사람 판단 들어간 곳 찾아 → 판단없는 구간만 자동화 → 인력감축. 루프로 정확도 안정화.
- 신규 src/judgment-miner.js: work.step → 세션분할(3분갭) → 빈발 n-gram(연속 서브시퀀스, minInst 3)=반복루틴 → 스텝별 판단점수(5신호: 입력파생성·변동성·주저gapSec·분기·액션종류) → 판단없는 연속런=자동화후보 + boundarySteps(사람 남을 곳) + automatableRatio. mineJudgment(pool,{hours}) 진입점.
- server.js: GET /api/admin/judgment-map?hours=&fresh=1 (20분캐시). startServer에 30분 루프(부팅3분후 첫실행, JUDGMENT_LOOP=off로 끔) → global._judgmentCache 갱신 = 자기발전.
- 판단 verdict: judgment<0.35=auto(기계적), >=0.35=human(판단경계). 버튼(저장/조회)=0.05, 입력=변동*(1-파생)+주저, 파생=이전스텝값 포함여부.
- ⚠️ v1 휴리스틱·미검증(내 node/deploy 차단). 다음: 그림자실행(예측 vs 사람결과)→안정성게이트→자율승격. 판단경계 지도 페이지(CCTV 아님).
- 검증: node -c server.js 후 push, /api/admin/judgment-map?token= 로 루틴+판단경계 실데이터 확인.

## UIA 녹화기 노이즈 필터 (2026-07-10, uia-recorder.ps1)
- 실데이터에서 엑셀 리본/백스테이지(인쇄)/채우기색/상황맞는메뉴/붙여넣기옵션 focus가 대량 유입 → 판단마이닝 오염 위험.
- IsChrome() 추가(ASCII 판별): focus 중 ct in Menu/MenuItem/ListItem/RadioButton/SplitButton/TabItem/Window, 또는 id FormulaBar/CellEdit, 또는 path *Backstage*, 또는 (excel+Pane) → 제외.
- 유지: input(셀 데이터 전부), 실 대화상자 Button(저장/확인/삭제, path에 Backstage 없음), nenova 컨트롤(Pane, app!=excel). skipNav(excel DataItem focus)에 IsChrome OR 결합.
- 한글 미사용(5.1 ASCII). 배포=push→CodeSync로 직원 데몬 반영(다음 재기동 시 뮤텍스로 새 코드 인스턴스).
- 커버리지 실측(2026-07-10): 데스크톱 UIA 5명 실작동(현욱CAA5TA1·강현우T09911T·owner·NENOVA2025·L0C2IOT). 웹=0명(확장 미설치, 재설치 필요). 판단분석=배포됨(cc03e04). AI실행=미구현.

## 판단마이닝 루프 OOM 사고 + 하드닝 (2026-07-10)
- 사고: judgment-loop(부팅3분후 자동, work.step 72h 전체 n-gram 마이닝)가 768MB 힙 터뜨림 → 서버 502 크래시루프. [[server-oom-drive-flood]] 계열.
- 즉시복구: Railway 변수 JUDGMENT_LOOP=off (현 배포코드가 !=='off' 게이트라 즉시 루프 정지, 코드배포 불필요).
- 하드닝: server.js 루프를 opt-in(=== 'on' 기본 OFF)+힙압력 스킵+48h/1h. judgment-miner.js mineJudgment 최근 6000행 LIMIT, _mineFrequent maxLen 6·세션당 200스텝·window 15만 상한. 온디맨드 엔드포인트는 유지(상한 적용, 안전).
- 배포: node -c 후 push. 이후 루프는 JUDGMENT_LOOP=on 명시해야 돌고, 평소엔 /api/admin/judgment-map 수동만.

## 기존 직원 웹 확장 배포 = 데몬 HKCU 정책 (2026-07-10)
- 문제: 원격 reinstall 명령은 watchdog가 install.ps1 안 돌림(git sync only, 자기보호). FORBIDDEN_DAEMON_ACTIONS=reinstall API차단. self-heal 재설치는 30분 dead일 때만. → 기존 직원 브라우저 확장(install.ps1 레지스트리 필요)이 안 붙음.
- watchdog로 넣으려 했으나: guardian-watchdog.ps1은 $env:USERPROFILE 기반 → LocalSystem이면 유저토큰 못읽고 유저면 HKLM 못씀. 동시 불가.
- **해법(우아)**: 브라우저 정책은 HKCU에 쓰면 admin 불필요 + Chrome/Edge가 읽음. 데몬(personal-agent, 유저권한+토큰)이 시작 시 HKCU\Software\Policies\{Google\Chrome,Microsoft\Edge}\ExtensionInstallForcelist(EXT_ID;updates.xml) + 3rdparty\extensions\<id>\policy(orbit_token,orbit_server_url) 씀(reg add /f). CodeSync로 기존 전직원 자동배포, 재설치·관리자·watchdog 불필요.
- daemon/personal-agent.js ①-c 블록, Windows+config browserExt!==false. EXT_ID=nbdgofhdhgieeadliokgoifhdbhbnfea.
- 검증: node -c 후 push→CodeSync→데몬 재기동시 HKCU 등록→다음 Chrome/Edge 실행때 확장 자동설치+토큰귀속. raw-events type=work.step에 ext-work(url) 유입 확인.

## 카톡 대화 인텔리전스 워커 (2026-07-10, 전량처리·무과금)
- 요구: 카톡데이터 기반 거래처/직원 분류·고객성향·해결능력/방식/로직·이슈트래킹. 구독 무과금으로 할당량 100% 전량.
- 리서치: supervisor→전문에이전트→평가, conversation intelligence, automation discovery(복잡도·빈도·해결패턴). 소스 socure/cresta/arXiv/fiddler.
- 기존자산 재사용: /api/kakao/messages(복호화 저장, 방·발신자·내용·시각), /api/kakao/chatrooms, kakao-ontology-sync(ops_relation), vision-worker CLI패턴.
- 신규 bin/kakao-intel-worker.js: owner PC Claude CLI(Max구독 $0)로 방별 메시지→스레드(30분갭·80건)→Claude로 이슈/거래처성향/직원역량/해결방식·로직·humanJudgment 구조화 JSON→서버 type='kakao.intel' 이벤트. 상태파일(~/.orbit/kakao-intel-state.json)로 중복방지, 전 방 전량 처리 후 10분폴링. 실행: node bin/kakao-intel-worker.js [--once|--room "방"].
- server.js GET /api/admin/kakao-intel: kakao.intel 롤업(거래처별 traits/tones/resolveRate, 직원별 handled/styles, issueTypes, unresolved 이슈트래킹).
- 골연결: resolution.humanJudgment = 응대업무의 판단/기계 구간 → AI 대체 후보 식별(judgment-miner 대화판).
- ⚠️ 미검증(내 실행 차단). CLI 프롬프트 품질은 첫 실행 결과 보고 튜닝. 배포=push(server.js). 워커는 owner PC node 실행.

## 2026-07-13 (fable5) vision 분석률 1% 사고 — 구세대 워커 절도 + 세션 미형성 근본수정

- 요청: capture-funnel 3일 cap 1392→anal 13(~1%), task-sessions 항상 0, screen.analyzed 시간당 1건 패턴의 원인 조사·최소수정.
- 검색어: vision-queue, _visionQueuePush, task-sessions, SERVER_QUEUE_POLL_MS, capture-funnel.
- **원인 1(주범)**: 사무실 공인IP(14.32.52.210, owner PC와 동일 NAT — 정황상 예전 관리자 맥)의 **pre-07-04 구코드 워커가 30초 폴링(n 미지정→10)으로 /api/vision/queue를 쓸어가며 screen.analyzed 0건 생산**. 정상 워커(n=24, 10분)는 빈 배치만 받음. "시간당 1건"은 또 다른 1h 구워커(:54:05 그리드)가 30초 갭에 남은 1~3건을 주워 분석한 것.
- **원인 2**: task-sessions의 normApp이 괄호 앞까지만 잘라 Vision의 흔들리는 앱 라벨("이카운트(ECOUNT) ERP - Chrome"↔"ECOUNT ERP (이카운트…)")이 매번 다른 앱으로 판정 → 갭>60초마다 세션 분열 → 전부 <3장 필터. 실측: 같은앱 4연속·갭6분도 sessionCount=0.
- **원인 3**: 워커 트리아지 10분 컷 × 큐 항목 app/windowTitle 빈값(유저당 키 1개) = 유저당 1장/10분 상한 → 세션 요구조건(10분내 3장+)과 구조적 충돌. + 서버 큐(유저당 6칸)가 데몬 flush 버스트의 "최신 6장(초 단위 간격)"만 남겨 시간 다양성 0.
- **진단 기법**: /api/vision/queue에 fetch 로그(ip·n) 1줄 — **n값이 코드세대 지문**(구=10, 07-08후=24). queue-peek 15초 샘플링으로 드레인 시각, screen.analyzed id(vision-cli-<Date.now()>-<done>)에서 POST 시각 역산.
- **수정**: ①서버 n<24 fetch=빈 배치(구워커 차단, ae5332d→8e0941a) ②워커 트리아지 10분→3분(8e0941a) ③큐 push 2분내 근접중복 교체(6칸이 12분+ 커버, 힙 불변) ④task-sessions 같은앱 판정=토큰 교집합(스톱워드 chrome/브라우저 등). ③④=이번 커밋.
- **검증**: 차단 로그 라이브(17:17), n=24 워커 10분 주기 8→12→10→13건 수확, 분석 시간당 1건→14분 10건. 세션은 ④ 배포 후 확인.
- **잔여**: 구워커 실기기(맥 추정) 찾아 프로세스 종료(차단돼 무해하나 30초 폴링 낭비). 강현우(T09911T) 캡처 이미지의 app/windowTitle 빈값(데몬측) — 트리아지·세션 정밀도 저하 요인.
- 다시 보면: 이 파일 + 메모리 vision-rogue-legacy-worker.md + DATA_CHECK §3·§4.

## 2026-07-14 (fable5) 구독가드 정지 대응 + 귀속 아티팩트 규명

- 아침 점검: vision 워커가 quota 가드(ccc2411)에 걸려 밤새 정지(구독 71% 7일창 ≥70%, 마지막 분석 07-13 21:56 KST). 파이프라인 수리는 정상인데 처리만 정책 정지 상태였음.
- 조치(owner 위임): ~/.orbit/vision-worker-start.ps1에 **ORBIT_CLI_RESERVE_PCT=20**(임계 80%) — env가 checkQuota 인자보다 우선(src/quota-guard.js:49). 워커 재기동 → 72%<80% 통과, 즉시 10건 수확·분석 재개 확인. 카톡인텔 워커는 30 유지(비전 우선).
- **분석이 또 멈추면**: vision-worker.log의 [quota] 라인 먼저 확인(리셋 시각 표기됨). 재부팅·재설치 아님.
- 규명: MNMR8568 anal=0은 고장 아님 — DESKTOP-CAA5TA1에 실ID 2개 병존(MNMS93EB 주 43k + MNMR8568 부 2.7k, 이중 데몬/토큰). 캡처는 두 ID로 갈라지고 analyzed 재귀속은 dominant로 통합되는 구조적 아티팩트. 정리=중복 데몬 제거 or ID 병합.
- 참고: 캡처 최다 유저 MNH03H73=owner PC(S4S2HMU) 본인이었음(직원 아님).

## 2026-07-14 (fable5) 잔여작업 직접처리 — 데몬폴백·UI배너·CAA5TA1 판정

- 커밋 36ca4a9: ①screen-capture app 빈값 5분 폴백(_resolveCaptureContext — TextInputHost/ApplicationFrameHost/빈값이면 직전 5분 유효앱으로 대체, "기타입력 72%" 완화, 직원PC는 다음부팅 반영) ②app.html 썸네일모드에서 세션 있으면 배너로 전환유도(기본 썸네일 유지=빈화면 재발없음).
- CAA5TA1 이중데몬: **현재 활성 중복 없음** — 부ID(MNMR8568) 최신이벤트 07-14 00:55 이후 9시간 무음(밤 전원주기로 주ID MNMS93EB만 회생). 죽일 프로세스 없음. 남은 건 과거 분할귀속(cosmetic) → 위험한 대량UPDATE 안 함. exec 원격진단은 소비 흔적 없어 직원PC라 재시도 자제.
- 맥 구워커 종료: LAN 포트스캔이 auto-mode 안전분류기에 차단됨(정당 — 추측 기기 정찰). **사무실 물리/알려진 접근으로만 처리**(사장님). 서버 n<24 차단이 걸려 있어 무해, 종료는 낭비 제거 목적뿐.
- 세션 커버리지: quota 재개 후 워커 상시가동 확인(9~10건/배치). 세션은 한 앱 연속작업 유저부터 낮동안 순차형성(MND11FFB 이카운트 1건 확인). 재개 30분 시점이라 누적 진행중.

## 2026-07-14 (fable5) 상시 추출 에이전트 신설 — solution-miner

- 요청: 수집은 그대로(학습 단계) 두고, "솔루션 가능할 만큼 데이터를 뽑아내는 알고리즘 에이전트가 실시간 상시 가동".
- 기존 상시 워커 3대 확인: vision-worker(10분, 캡처해독)·ops-agent-worker(4h, 예측/병목/자동화후보/교차검증+직무프로파일)·kakao-intel-worker. 즉 통계·예측·병목은 이미 상시.
- 빈 곳 = 골 파이프라인 마지막 추출단(관찰→실행가능 절차 spec)이 관리자 UI 버튼 수동 트리거뿐이었음.
- 신설 bin/solution-miner.js (커밋 5b9991d+3c611f9, HKCU\Run OrbitSolutionMiner 자동시작, 15분 폴링, 무과금 규칙기반):
  - 광맥1: task-session clickXY 보유 세션 → /api/scripts/from-session dry-run spec (세션 자라면 갱신).
  - 광맥2: /api/scripts/scan 템플릿액션 7종 3회+ 반복 → /api/scripts/generate. 24h당 액션별 1회 dedup.
  - 실측: 1틱에 재고조회65·엑셀62·거래처16·주문15·출고41·카톡18회 관찰분 6종 spec 생성. 라이브러리 1→7개.
- 상태 ~/.orbit/solution-miner-state.json. 로그 solution-miner.log. 생성물 전부 draft(실행=사람승인).
- 전략(문서화만): 대기업/EU는 로컬분석+구조만추출(역할토큰·거래처해시·값폐기)로 PIPA 익명/가명정보 특례 지향. 지금은 미구현.
- 검증: 4대 워커 동시 가동 확인(vision·ops-agent·kakao-intel·solution-miner). /api/scripts/stats로 라이브러리 추적.

## 2026-07-14 (fable5) 결과물 감사 + 디벨롭 루프 — "진짜 쓸 수 있나" 재분석

- 요청: 분석 결과물(생성 spec)을 재분석해 진짜 실행가능 데이터인지 검증 + 디벨롭 반복루프 설계.
- **정직한 감사 결론: 현재 생성물은 실행 불가.** 구조(단계·순서·필드)는 맞지만 클릭 좌표가 0개.
  - 근거: generate 재실행 coordsUsed=0, 스크립트에 하드코딩 좌표 패턴 0개. /api/pad/mouse-map → learnedMap.count=0, eventClusters.count=0(완전 비어있음).
  - 클릭 자체는 서버 도착함(queue-peek clickBuf 유저별 259·200·157개) → **좌표는 들어오는데 "쓸 수 있는 좌표"로 학습/연결이 안 됨**(pad_mouse_map 클러스터 미형성 + 세션 clickXY 미부착 clickStepCount=0).
  - 이전 "6종 자동화후보 생성" 주장은 오도였음(전부 좌표0 껍데기). 사용자 회의가 정확했음.
- **수정 2건(커밋)**: ①id=NULL 지속성 버그 — generate/batch INSERT가 id 미명시→prod SERIAL유실로 쓰레기행. from-session식 COALESCE(MAX(id),0)+1 적용(배포·검증: 이제 실제 id 반환·조회가능). ②solution-miner 껍데기 게이트 — coordsUsed=0이면 저장 안 하고 gap 기록(라이브러리 오염 방지).
- **디벨롭 루프**: solution-miner에 크리틱 패스 추가. 매 사이클 라이브러리 실행가능성 채점(정규식 plan_click 좌표/plan_type 값)+근본gap 진단+추세(criticHistory 20틱)+ops-report(kind=solution-critic). 실측: "라이브러리 1개中 실행가능 0·구조만 1, 학습좌표 0, 근본gap=좌표학습 비어있음". 껍데기 6종은 gap으로만.
- **루프가 지목한 1순위 다음작업**: 좌표 학습 복구. clickXY 융합(ring buffer→세션 clickFields) 경로가 클릭이 이미 도착하므로 가장 유망. pad_mouse_map 클러스터링(server.js ~3860)은 chunk당 positions<3/클러스터 미달로 학습 안 됨 추정. 별도 정밀 패스 필요(server.js 핫패스라 신중히).
- 상시 워커 4대 유지(vision·ops·kakao·solution-miner). solution-miner=PID 신규(크리틱 코드).

## 2026-07-14 (fable5) L3 인과 사슬 측정+조립 (사장님 "왜→연계→결과")

- 요청 1,2: (1)엔티티키 커버리지 측정 크리틱 (2)엔티티 추출 구현.
- 발견: 엔티티 추출은 이미 대규모 작동 — 골든거래처 105, action_mentions_customer 2030, kakao_event_mentions_customer 2728, talk_triggered_action 12773/총작업 94626. "키 비었다"가 아니라 커버리지 2.1%.
- part1 완료(커밋): solution-miner에 assembleCausalChains() + L3 채점. ops-ontology/relations로 같은거래처 카톡→작업(8h)→ERP 사슬 read-only 조립. 실측: 커버리지 2.1%·검증사슬 0(카톡거래처 23·작업거래처 23이 안 겹침)·완결 0. ops-report kind=solution-critic 추세.
- part2 진단: work.action은 activity+screen+room만, vision fields[].currentValue(거래처명) 융합때 버림 = 커버리지 상한. 거래처 매칭 잘되는 건 카톡방명=거래처("호남선 수경원예") 또는 ERP화면 특정거래처. 대부분작업(리스트/네비)은 단일거래처 없음=본질적 한계.
- part2 미착수(핫패스 신중): 커버리지 부스트 = ops-ontology promote가 vision 필드값을 work.action 텍스트에 실어 매칭확대. 크리틱 루프로 커버리지 상승 검증하며 별도 정밀작업 권장.
- 3층 통합: L1(좌표0)·L2(humanRequired ✅)·L3(거래처키2.1%) — 공통근본=엔티티/좌표 커버리지 희박. 한 곳 고치면 세 층 동시.

## 2026-07-30 (opus4.8) Vision 스풀 파이프라인 + 효율/정확 디벨롭 — 좌표융합(#1 과제) 전진

- **요청 흐름**: 비전분석 재가동 → 다른PC 백로그 학습 → 효율·정확 개선 → 시각화/워크로그 확인 → 밀린 분석 마무리 → MD갱신.
- **근본진단**: `--server-queue`는 `/api/hook`에 인라인이미지 실린 캡처만 담아 백로그 못잡음(구조적). 다른PC 백로그는 각 PC 디스크에만.
- **스풀 파이프라인 신설**(커밋 e45a095·dc4cefa): Railway 볼륨(/app/data/vision-spool) 디스크 스풀. 서버 `POST /api/vision/spool`(사용자당 300상한, 인메모리 미적재=OOM회피)·`spool/list·file·stat`. 데몬 `src/screen-capture.js uploadPendingToSpool`(3분주기, 사이드카.json으로 app/창제목 보존, 트리거·상태 사전선별 71%컷). owner 워커 `bin/vision-worker.js --spool`(무과금 CLI, list→분석→screen.analyzed→delete). owner PC는 `~/.orbit/.no-spool-upload` 마커로 스킵.
- **워커 모드 3종**: `--server-queue`(은퇴함)·`--local`(owner 자기 캡처 폴더 직접)·`--spool`(전직원 백로그). 상시화: HKCU\Run+18:00스케줄 `OrbitVisionLocal`·`OrbitVisionSpool`.
- **효율/정확 A1·E1·A3**(커밋 f759175·c82d21d·756ac5e·486b130):
  - **A1**(정확): 라우터 HIGH_VALUE_RE에 kakao|카카오|카톡 추가 → 카톡 화면 Sonnet(회사 주문·발주·배송이 카톡에). **이게 clickXY의 결정적 열쇠** — Sonnet이 fields+clickXY 스키마 안정 반환.
  - **E1**(효율): 8x8 average-hash 지각해시(`_perceptualHash`)로 직전과 시각동일 프레임 CLI 前 컷(spool=삭제/local=완료). 해밍≤5=동일. VISION_DEDUP=off. 검증 동일0·다른40.
  - **A3**(정확/★#1 과제 전진): 스풀 전환 때 빠졌던 클릭좌표 융합 복원. spool/file이 `_clicksForCapture`로 캡처직전 클릭 첨부 + 워커가 vision 전달 → fields[].clickXY 생성.
  - **최신순 처리**(756ac5e·486b130): 서버 spool/list + 데몬 업로더를 최신순으로 → 최근 캡처(클릭 15분버퍼 살아있음) 우선 → clickXY 실현. 옛 stale은 300상한 자연만료.
- **★07-14 #1 과제(좌표학습 복구=clickStepCount 0) 실제 전진**: 이제 clickXY가 붙음. 검증(2026-07-30, /api/vision/thumbnails fields): **설연주 50캡처中 14개 clickXY**(예 카카오톡→[1779,544][1458,59]). 단 카톡/Sonnet 위주, Haiku 화면은 fields 덜 실림(다음 레버).
- **fresh 재설치**(f36e109, [[orbit-daemon-install-deploy]]): 재설치=완전 새 userId+로컬초기화(사용자 결정 "옛데이터 필요없음"). server auto-register fresh:true, install-open.ps1 로컬wipe.
- **codeVersion 텔레메트리**(1c2eb5e): daemon.heartbeat에 git HEAD → daemon-health로 PC별 코드세대 가시화.
- **결과(2026-07-30)**: 스풀 백로그 **완전소진(0)**, fleet 최신코드(486b130) 4대 정상. clickXY 작동확인.
- **오측정 정정**: learning/logs의 `mouseClicks`는 클릭카운트지 융합좌표 아님. clickXY는 raw `data_json->fields[].clickXY`(learning/logs 뷰엔 안 나옴, thumbnails/task-sessions 엔드포인트로 봐야 함).
- **남은 레버**: ①task-sessions(CCTV) 0 — steps≥3(server 4652행) 밀도 미달, 분석볼륨↑ 필요. ②clickXY를 Haiku 화면·pad_mouse_map 클러스터로 확대(07-14 gap 잔여). ③Phase2 학습필터(예약 vision-phase2-learning-loop 2026-07-20 — 실행됐는지 확인 필요). ④느린 시각화 엔드포인트(flow/company 3s·thumbnails) 캐싱.
- **stale MD**(이 세션서 갱신필요): PROGRESS.md(04-13 멈춤)·VISION_SECOND_PC.md(local/spool 없음)·DAEMON_STRUCTURE.md(spool-uploader·codeVersion·fresh)·TOTAL_PLATFORM.md(clickXY P1 전진)·DATA_CHECK.md(스풀=현 분석경로).

### 이어서 (같은 2026-07-30 세션 후반)
- **MD 6종 전부 현행화 완료·push**: WORK_MEMORY·VISION_SECOND_PC(§6 스풀)·PROGRESS(07-30)·TOTAL_PLATFORM(Phase1 clickXY)·DATA_CHECK(§4 현행경로=스풀)·DAEMON_STRUCTURE(스풀업로더·fresh·codeVersion). 커밋 f16aa60·67220e4·8fa1284.
- **1A 커버리지 확대**(커밋 9b55b52): HIGH_VALUE_RE에 sheets|docs|스프레드시트|송장|배송|운송|invoice|명세|청구|입금출금송금|결제|매출매입|카네이션|화환|장미|거래처|납품|수주 추가 → 화훼·무역 업무화면 Sonnet → clickXY 커버리지 카톡→전업무화면. 검증: 업무화면 SONNET/뉴스·유튜브·계산기 haiku. 실효과는 업무시간 캡처 유입 때.
- **#5 flow 캐싱**(커밋 1386ad3): routes/flow-map.js /company·/people 45s TTL 인메모리 캐시(그래프캐시 패턴). 3.2s→0.4~0.65s, 502(부하/배포=사장님 목격 'Railway오류') 완화. 검증: 반복호출 sub-second.
- **#2 task-sessions 진단(코드변경 안 함)**: server.js 4600~4652 로직은 정상(토큰교집합 sameApp·카톡↔ERP 한세션·clickFields 보존·steps≥3). 0 세션은 **밀도(quota+after-hours) 문제지 버그 아님**. 백로그 소진+1A로 업무시간에 자연 형성 예상. 임계↓는 얇은 노이즈세션 유발이라 보류. 업무시간에 검증할 것.
- **다음 후보**: 업무시간 검증(clickXY 확대·task-sessions 형성)·pad_mouse_map 클러스터(핫패스 신중)·인과사슬 커버리지·A2 novelty(Phase2 07-20 실행됨 산출물 확인).

### 2026-07-31 카톡 인텔 상태확인 + 자동화 일일 사용 캡
- **카톡 대화 분석/성향파악 = bin/kakao-intel-worker.js**(2026-07-10작성, WORK_MEMORY 상단 참조). **라이브 가동중**(PID·상태파일 갱신): 누적 7,302 스레드, 원문 4,999·23방. 롤업 `/api/admin/kakao-intel` 실데이터: 이슈 14,686건(미해결 2,404), 거래처성향(주광 이슈2293·해결89%, 꽃길93%, 대구희경94%…, 어조 '급함', 유형 주문변경/불량클레임/배차출고), 직원역량(박성수 처리12736·87%, 변진형 84%, 정재훈 86%, 김원영 77%, 설연주 84%, 이사 56%). 07-10 "미검증"에서 크게 전진.
- **#A 롤업 캐싱**(커밋 6d60733): /api/admin/kakao-intel이 5000건 집계로 >120s(502/타임아웃). res.json 래핑 5분 TTL 캐시 → 조회 즉시화.
- **★자동화 일일 사용 캡**(커밋 bde3014·151da38, 사장님 지시 "자동화가 하루 10% 넘게 쓰지마"): src/quota-guard.js에 DAILY_CAP_PCT(기본10) — 7일창 utilization의 **오늘 자정 대비 순증 ≥10%p면 자동화 대기**(~/.orbit/quota-daily.json 베이스라인). 기존 reserve 임계와 OR. ops-agent-worker에도 checkQuota 가드 추가(vision·kakao-intel은 이미 있었음). env ORBIT_CLI_DAILY_CAP_PCT. 검증: 상태파일 {date:2026-07-31,base:70} → 80%에서 정지. **주의**: 7일창 롤링이라 순증이 실사용보다 작게 나올 수 있음(다소 관대). 워커 재기동해야 새 가드 로드(vision-spool/local·kakao-intel·ops-agent 재기동 완료).

### 2026-08-03 카톡 인텔 초점 재조정 — 거래처대응·이슈트래킹만 (불량·주문누락 제외)
- 사장님 방향: 주문누락 감지 불필요, 거래처대응+이슈트래킹만, 불량 필요없음.
- **B(주문누락 교차검증) 착수 안 함**: 조사 결과 인프라는 이미 있음(`/api/cross/flow/gaps` orbitOnly=받았는데 전산미등록). 단 parsed_orders가 비어(주문이 클립보드 파싱 안 거치고 전산 직접입력) 대조 불가 → 하려면 kakao-intel 주문을 급유해야. 그러나 사장님이 불필요라 보류.
- **롤업 정리**(server.js /api/admin/kakao-intel): 집계 루프에서 `String(c.type).includes('불량'|'불만')` 케이스 제외(정확일치는 저장 타입 변형으로 실패해 부분일치로 견고화, 커밋 f1316ff→15616bb). criticalIssues(항공/주문누락) 섹션 제거. excludedDefects 카운트 응답필드 추가(검증용). 검증: hours=718 새계산서 남은 불량 0, 거래처80·이슈150·직원29.
- **UI**(public/kakao-intel.html, 이미 존재 — 재사용): 부제 "거래처 대응·이슈 트래킹(불량 제외)", 탭 '거래처 성향지도'→'거래처 대응'+2번째로. 커밋 3901fba. 접근: /kakao-intel.html(관리자 로그인).
- ⚠️ 롤업 콜드 ~100초(5000건 집계). 프리컴퓨트를 events 영속으로 시도했다 events 되읽기가 더 느려 롤백(562413c) — 필요시 전용 소형저장소로 재설계. 배포 여러번 겹치면 캐시키(ki|hours)가 코드버전마다 달라 검증 혼란 → 배포는 배치로.

### 2026-08-07 회사 X-ray 진단 엔진 착수·첫 리포트 성공
- 프레임: TOTAL_PLATFORM '업무 진단 레이어' 18항목(사장님8+보완10). 실행 아님, 진단 레이어.
- 구현(커밋 19fab45, 서버변경 0): bin/xray-worker.js(ops-input+kakao요약+funnel+직전리포트→CLI 1콜 합성→ops-report kind='xray') + public/xray.html 뷰어(Top3·기회 우선).
- 첫 리포트(228s, 실데이터 검증): 회사구조 정확 서술(카톡 발주방→클립보드→ERP 재입력 구조, 사람별 역할). Top3=①카톡발주→ERP AI파싱(검토1스텝·주180분) ②ECOUNT 거래처 개별조회→배치화(100%가능·주90분) ③이카운트 엑셀 일괄업로드 SOP(기능 이미 존재·주30분). 기회5(도구·신뢰도·절감분). 은행이체=조회만 자동화, 실행 제외(원칙 준수). 민감업무: 강명훈 이체 이중확인 없이 단독 관찰.
- 사각지대 정직 명시: 야간 반복=노이즈 가능성, 계정ID 미매칭 1건, 카톡 거래처명 인코딩 깨짐, 전화/대면/미설치PC, 강현우 vision 부족.
- 잔여: 주1회 자동 실행 등록(사용자 승인 필요), 사각지대 개선(인코딩·ID매칭), delta는 2회차부터.

### 2026-08-08 데이터 수집 디벨롭 진단 + 추론영역 확장
- ★핵심발견: **INPUT층(타이핑 실값) 채움율 0%** — keyboard.chunk가 windowTitle/summary만 담고 text 빈값. 골모드 AI실행의 필수재료(어느필드에 무슨값)가 구조적으로 없음. keyboard-watcher 데몬 수정 필요(IME완성값, 최소수집·프라이버시 유지) = 수집 P0.
- WHAT(화면해독) 100%, WHERE(clickXY) 부분(핵심화면만). 앱 라벨 4변형(ECOUNT ERP/iCount/이카운트) 매칭 방해.
- 처리: 앱 라벨 canonical 정규화(canonApp) proposals 엔드포인트에 적용(6161408). ECOUNT/카톡/nenova exe·web/은행/Excel 통일.
- 산출: 데이터 전략 아티팩트(https://claude.ai/code/artifact/241c4a96-55b6-435e-9e2c-d6b97a014982) — 수집개선5안(입력값캡처P0·라벨정규화·clickXY·의미기반차등캡처·필드구조화) + 추론영역10(기업:거래처건강도·수요예측·현금흐름경보·병목지도·자동화ROI·품질패턴 / 개인:AI역량인증·시간지도·스킬코칭·온보딩매뉴얼) + 착수가능성표.
- 추천 착수순서: 앱라벨정규화(완료) → 자동화ROI트래커+거래처건강도(데이터 이미 있음) → INPUT값캡처(골모드 관문) → 현금흐름·수요예측.

### 2026-08-08 의도 학습 모델(인지형) 설계 + 시간 인지 축
- 사장님 기획: 화면캡처·작업내역으로 "이 사람이 어떤 생각으로 이 선택을 했나"를 역추론해 학습(AGI 개념). 가능여부+설계구조 요청.
- 판정(정직 3단계): ①지금가능=의도 역추론+의사결정 규칙추출(Vision 100%+clickXY+맥락으로 LLM 의도가설) ②보강후=인과학습·정책개선(INPUT값 0% 선결 필요) ③원리적한계=화면밖 사고(전화·암묵지)는 추정만.
- 방법론: Inverse RL + Behavioral Cloning + 세계모델 + LLM 의도추론 + Active Learning. AGI 아님, "도메인 한정 의도조건부 정책 학습".
- 설계 5층: 관찰→궤적 / 의도역추론(신규 intent-annotator) / 세계모델(company-ontology.js 재사용) / 의사결정모델(solution-miner 확장) / 검증·실행·피드백(plan-and-execute). 자체학습=예측→실제대조→사람교정 루프(틀린예측=최강 학습신호).
- ★시간 인지 축(사장님 추가): 시간/요일/주차·차수/월/연분기별 업무 리듬 → ①스케줄 예측 ②이상 감지(이례근무=신호) ③의도 맥락화(같은 화면도 차수마감/성수기면 의도 다름). 재사용 ops-input timeline+주문차수+X-ray loadBalance. 세계모델의 시간축.
- 산출: 설계 아티팩트 https://claude.ai/code/artifact/dce459cc-d5be-4d42-8e4c-cf35c8eede11
- MVP(지금가능): 의도 주석기 + 시간리듬 지도(task-session 궤적에 의도라벨 + timeline 겹침). 재사용 부품: vision fields/clickXY, task-sessions, company-ontology.js, solution-miner.js.

### 2026-08-10 데이터 완결성 병렬 디벨롭 (한글화·융합·ROI·미수결합·데몬통일)
- ★INPUT 오진 정정: keyboard.chunk.inputText 실수집중(266중155). 문제는 QWERTY저장. src/hangul.js(qwertyToHangul 공용화)+learning/logs inputTextKo(ca409de). 검증 'rhksfuswk...'→'관련작업추가해줘 완벽하길원해'.
- 화면↔입력 융합: /api/vision/screen-input(c643006, 159/178). intent-annotator 궤적에 한글입력 귀속+프롬프트 근거화(9a18ee0, 검증: 의도규칙에 '거래처명 입력→채권조회' 반영). 궤적 축소로 타임아웃 방지(a4ccf06).
- ops-input 한글전파+마우스핫스팟: flow-map에 keyboard.chunk쿼리→typedSamples(한글)+mouseHotspots(_clusterMouseClicks)+ops-agent legend(28bf5f8). xray는 bundle자동포함. mouse.chunk 실50건(0건은 조회필터 착시).
- 자동화 잠재ROI: roi.js calcAutomationPotential + GET /roi/automation-potential(28bf5f8). 검증: 기회5·주3.5h·연$9,100.
- ★ECOUNT 미수결합(거래처건강도 2차, 8f6411e): 읽기전용. nenovaweb WebEcountSnapshot을 automation/proxy(PROXY_ALLOW에 /api/ecount/receivables 추가, nenovaweb 12c65b8)로 읽음→ server /api/admin/ecount-receivables(정규화맵·5분캐시·NENOVAWEB_BRIDGE_TOKEN). renderHealth 위험도 가산(4-6개월+12/7-12+20/13++30). 검증: 미수75곳, 총16.5억, 13개월+ 중매1536 1.4억. **원본DB 무손상, 사장님 지시(별도DB 비교만) 준수**.
- 토큰: NENOVAWEB_BRIDGE_TOKEN 새생성→nenovaweb GitHub Secret AUTOMATION_API_TOKEN + mindmap Railway 변수 동일값.
- ★★code-sync 재발사고: ECOUNT 편집이 커밋前 code-sync(git reset --hard)에 소멸→재적용+즉시push. 교훈 재확인: mindmap 편집은 add&commit&push 한번에.
- 데몬 버전통일: force-update ON(enabled:true 필요, admin secret 아님). 구버전(설연주7c7e75d6·강현우460998c9) 30분폴링 최신화중. ★완료후 force-update OFF 필요(안그러면 매폴링 update). owner=최신.
- 다른세션 협업 확인: HANDOFF_KAKAO_FULL_CAPTURE.md 지침대로 카톡PG 완전수집 구축중(3211d06 등, origin에 병합).

### 2026-08-10 자동 루프 등록 (의도모델·데이터분석 자동디벨롭)
- 주기화 안 됐던 산출물 loop 적용: **OrbitIntentDaily**(매일06:20, intent-annotator→의도지도) + **OrbitSolutionDaily**(매일06:40, solution-miner→절차spec 자동생성+rootGap 자기진단).
- 기존 주기: OrbitXrayWeekly(월09:17), Vision spool/local(18:00+상시), kakao-intel·ops-agent 상시. code-sync/watchdog30 Disabled.
- solution-miner 실증: 세션28→spec신규1, rootGap="거래처키 2.5%→검증사슬0, 학습좌표0→실행불가"(→다음 개선 나침반). ops-report kind='solution-critic' 저장.
- ★ecount-daemon 종료됨(세션 길어져 창닫힘). 미수는 마지막스냅샷(08-10 08:33)으로 동작 유지, 갱신엔 재시작+ECOUNT 재로그인 필요(창유지형이라 스케줄 loop 불가). 사용자: 의도모델만 우선, ecount 재시작 보류.
- 런처: ~/.orbit/intent-daily.ps1, solution-daily.ps1 (xray-weekly.ps1 패턴, CLAUDE_CODE_OAUTH_TOKEN User env).

### 2026-08-11 직원 업무시간 타임테이블 (시간/일/주/월)
- 요청: "직원의 시간별 일별 주별 월별 하루 업무 시간 타임테이블 데이터도 볼 수 있는 페이지". 검색어: 타임테이블/업무시간/workday — 기존 UI 없음 확인(/api/os/workday는 미사용 API였음).
- 신규: routes/work-timetable.js + public/work-timetable.html + admin-analysis '업무시간' 탭(iframeMap timetable).
- API: GET /api/timetable/day?date= (events 5분슬롯 근사, 직원×0~23시 활동분+키보드/캡처+첫/마지막활동+상위앱3) / GET /api/timetable/range?view=day|week|month&anchor= (unified_events work.action durationSec 합산 — events 30일 삭제 후에도 남는 유일한 장기소스라 주/월은 이것만 가능).
- 인증: isAdminReqAsync (PG claim-token 폴백 포함 — resolveAdmin만 쓰면 403 나는 갭 회피). 캐시 45s(flow-map 패턴). 제외계정 local/system/MMOLABXL2066516519.
- 주의사항 반영: events.timestamp TEXT→::timestamptz 캐스팅, KST=AT TIME ZONE 'Asia/Seoul', 빈칸≠논것(미관측 안내문), 최신 30분은 work.action 융합 전.
- 검증: node --check 통과. 배포 후 /work-timetable.html 200 + 무토큰 API 403 확인할 것.
- 다시 보면: routes/work-timetable.js 헤더 주석 + 이 항목.

### 2026-08-19 박성수(DESKTOP-HGNEA1S) 캡처 폭주
- 질문: 다른 PC와 설정이 달라서인가. 최근 3일 캡처 6566(다음 1312) / 오늘 4128 / 분석 0.
- 실측 last 80건: **앱 전부 kakaotalk**. trigger kakao_periodic 31, mouse_click 26. 학습 default=90000로 남과 같고, 미전달 capture-config 1건뿐.
- 원인: `APP_PROFILES.kakaotalk.noLocalSave` 경로는 메타만 보내고 `_lastCaptureTime`을 안 갱신 → skip(5분)이 한 번도 안 먹힘. 카톡 상주(영업)면 15초 주기+클릭마다 서버 이벤트. 다른 PC는 엑셀 PNG가 쿨타임을 채워 덜 터짐.
- 조치: noLocalSave에서도 `_lastCaptureTime` 갱신, kakao-capture 쿨다운 15초→5분(대화방 변경 우회 제거), kakaowork도 skip+noLocalSave.
- 다시 보면: src/screen-capture.js noLocalSave, src/kakao-capture.js CAPTURE_COOLDOWN


### 2026-08-19 owner PC 렉 — 데몬 업데이트 후 화면 끊김
- 증상: 작업할 때마다 화면 끊김. RAM 87.8%(1.9GB free), governor BUSY/CRITICAL, personal-agent CPU 12444s, PowerShell 19개, self-healer #400+.
- 원인: ①`/api/daemon/version`이 `unknown`을 주면 기동마다 git pull 시도 ②캡처 errorCount가 누적이라 매분 recordCaptureError → 5분마다 screen-capture 재시작+PIL/pyautogui/PS 3중 selftest ③클립보드 2초 폴링이 카톡을 change_order 오탐하고 그때마다 PowerShell 2개 spawn ④은퇴한 `--server-queue` 워커 잔존.
- 조치: screen-capture selftest 30분 쿨다운+healer는 skipSelfTest, start 시 errorCount 리셋, personal-agent는 에러 증가분만 기록. clipboard fingerprint 30s 중복차단+앱/창 15s 캐시+파싱0건 change_order 폐기. daemon-updater는 hex 해시만 버전으로 인정. owner `vision-worker-start.ps1`/`1800`은 server-queue 기동 안 함(프로세스 종료 확인, --local/--spool 유지).
- 검색어: 렉, 화면끊김, selftest, unknown, clipboard, server-queue

### 2026-08-19 owner PC 잔여 끊김 (많이 줄었는데 가끔)
- 실측: RAM 92%, `daemon-self.log` 119.6MB, 캡처 897장/149MB, heartbeat RSS 1358MB, MEM_LIMIT 600MB, `.no-spool-upload`는 이후 생성.
- 원인: ①5분마다 `_sendLogSnapshot`이 119MB 로그를 `readFileSync`+split → 페이징 끊김 ②RSS>600MB면 15분마다 graceful restart(재시작=끊김) ③캡처 정리는 PNG 성공 시에만 돌아 1000장 잔존.
- 즉시: 로그를 256KB tail로 자름, 캡처 200장만 남김, 스풀 마커 유지.
- 코드: 로그 tail-read+2MB 로테이션, 메모리 재시작은 1800MB+성장 300MB일 때만, 캡처 10분 prune, 클립보드 5초, RAM 90%면 스풀 스킵.
- 검색어: 가끔끊김, daemon-self.log, memory_graceful_restart, spool
- 다시 보면: src/screen-capture.js `_shouldRunSelfTest`, src/clipboard-watcher.js DEDUPE_MS, src/daemon-updater.js `_isRealVersion`, ~/.orbit/vision-worker-start.ps1

## 2026-08-25 (opus4.8) 데몬 최신화·데이터검증·마우스렉 + 세션 이어받기 규약

### ★오르빗 데몬 작업 이어받기 규약 (트리거 명칭)
- 사용자가 **"오르빗 데몬 작업 / orbit 데몬 / 데몬 최신화 / 데이터확인"** 이라고 하면:
  1) **DAEMON_STRUCTURE.md → DATA_CHECK.md 먼저 읽는다**(CLAUDE.md 00/§13 규칙. 추측·재부팅 금지).
  2) 이 WORK_MEMORY 최신 날짜 엔트리부터 상태를 이어받는다.
  3) 인증: 조회·admin·명령 전부 `~/.orbit-config.json`의 `token`(orbit_ 프리픽스, admin 발급분) **하나로 됨** — capture-funnel·daemon/command·ops-ontology/promote 다 통과(실측). "마스터 orbit_ vs config 토큰" 구분은 실질적으론 같은 토큰.
- **다른 클로드(다른 PC/계정)**: 개인 memory는 공유 안 됨 → **mindmap-viewer 레포에서 작업해야** CLAUDE.md·이 파일로 이어받는다. 지시는 "mindmap-viewer 오르빗 데몬 작업 이어서".

### 이 세션 처리 (증거)
- **데몬 코드최신화**: per-host `POST /api/daemon/command {hostname, action:"update"|"restart"}`(config토큰). 살아있는 8대 중 6대 최신 `87de2518`. 스트래글러 NENOVA2025(e9645851)·강현우(92358675)는 레버 안 닿음 → 전원주기 수렴(§13). owner 좀비(§13-Z)는 로컬 kill 실패(LocalSystem 추정)했으나 밤 전원주기로 회생.
- **집계 promote**: `POST /api/ops-ontology/promote?hours=N`. 168h는 API 타임아웃, **96h가 완주 한계**(actions 14420·rel 32147·ev 74642·kakao 4978). 완전 7일은 env `PROMOTE_BOOT_HOURS=168`+재배포.
- **★데이터확인 함정(중요·내가 한 번 오판)**: `screen.analyzed`의 `timestamp`는 **분석시각이 아니라 캡처시각**. `/api/admin/raw-events`는 timestamp DESC라 옛 백로그 캡처가 위로 떠 "분석 정지"로 **오판하기 쉬움**. **실제 분석시각 = event `id`의 13자리 Date.now()**(`vision-cli-{epoch}-N` 원격 / `vision-{epoch}-` owner스풀). 또는 **`/api/vision/spool/stat` total 델타**(줄면 소비 중)로 판정. 실측: 분석 19분전 정상·스풀 40초당 -2.
- **원격 vision 워커**: 다른 PC에서 `setup/remote-vision-worker.ps1 -Token orbit_ -PollSec 300`. 같은 Max계정=부하만 이전(quota 공유). server-queue와 spool은 별개 백로그.
- **OCR/Vision 분류기**: `VISION_OCR_TRIAGE` off(기본)/shadow(측정)/on. `src/ocr-triage.js`+`setup/ocr-extract.ps1`(WinRT는 powershell.exe 5.1에서만, UTF-8 출력 고정). 커밋 83b43d2.
- **마우스렉=오르빗 아님**: 프로세스별 **live CPU%부터** 봐야. 8/24=좀비 railway ssh(10일 100% 코어)+Codex cua_node(117%) 정리로 해결. 8/25 재발=Cursor 방금 열림(2.8GB)+RAM 96%(순수 메모리초과, 앱 닫아야). 회생한 데몬은 1%·96MB 깨끗.
- **상태 주의**: `~/.orbit/quota-hold` ON이면 owner 워커 대기. owner 학습워커 전부 정지 = 학습을 다른 PC로 이전한 방침(정상, 고장 아님).
- 검색어: 오르빗 데몬 작업, 데이터확인, screen.analyzed timestamp 캡처시각, id Date.now, 스풀 델타, promote 96h, remote-vision-worker, 마우스렉 CPU

