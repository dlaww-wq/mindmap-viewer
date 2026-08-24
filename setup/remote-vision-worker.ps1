# =============================================================================
# remote-vision-worker.ps1  —  다른 PC에서 Orbit 서버큐 Vision 워커 기동 (무과금 CLI)
# =============================================================================
# 목적: owner PC 부하를 덜기 위해, 다른 PC가 서버 큐(/api/vision/queue)의 밀린
#       캡처를 그 PC의 Claude CLI(Max 구독, API키 불필요)로 해독하고 결과를
#       서버로 되돌린다($0). owner PC와 병행하면 quota-guard가 자동 조율.
#
# 사전조건(그 PC에서 1회):
#   1) Node.js 설치            → https://nodejs.org (LTS)
#   2) Git 설치                → https://git-scm.com
#   3) Claude CLI 로그인        → `claude`  실행 후 /login  (Max 구독 계정)
#      * 같은 계정으로 로그인하면 owner와 "같은 주간 풀"을 나눠 씀(CPU/RAM만 이전).
#      * 다른 Claude 구독 계정으로 로그인하면 "별도 풀" = 실제 용량 증설.
#   4) Orbit 토큰 확보          → 아래 -Token 파라미터로 전달 (orbit_... 프리픽스)
#                                또는 ~/.orbit-config.json 에 {"token":"orbit_..."}
#
# 사용:
#   powershell -NoProfile -ExecutionPolicy Bypass -File remote-vision-worker.ps1 -Token orbit_XXXX
#   (토큰이 ~/.orbit-config.json 에 이미 있으면 -Token 생략 가능)
#
# 옵션:
#   -ReservePct 30   주간 사용량에서 사용자 몫으로 남길 %(기본 30). 별도계정이면 5로 낮춰 최대활용.
#   -Once            첫 배치만 처리하고 종료(테스트용).
# =============================================================================
param(
  [string]$Token = '',
  [int]$ReservePct = 30,
  [switch]$Once,
  [string]$RepoDir = "$env:USERPROFILE\mindmap-viewer",
  [string]$RepoUrl = 'https://github.com/Jayinsightfactory/mindmap-viewer.git'
)
$ErrorActionPreference = 'Stop'

Write-Host "===== Orbit 원격 Vision 워커 부트스트랩 =====" -ForegroundColor Cyan

# --- 0) 중복 실행 방지 (이미 서버큐 워커가 있으면 종료) ------------------------
$me = $PID
$dup = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -like '*vision-worker.js*--server-queue*' -and $_.ProcessId -ne $me }
if ($dup) { Write-Host "이미 서버큐 워커 실행 중 (PID $($dup.ProcessId)) — 종료" -ForegroundColor Yellow; exit 0 }

# --- 1) 사전조건 점검 ----------------------------------------------------------
foreach ($cmd in 'node','git','claude') {
  if (-not (Get-Command $cmd -EA SilentlyContinue)) {
    Write-Host "[X] '$cmd' 를 찾을 수 없습니다. 사전조건 설치 후 다시 실행하세요." -ForegroundColor Red
    exit 1
  }
}
Write-Host "[OK] node / git / claude 확인" -ForegroundColor Green

# --- 2) 저장소 준비 (없으면 clone, 있으면 최신화) ------------------------------
if (Test-Path (Join-Path $RepoDir '.git')) {
  Write-Host "[git] 최신화: $RepoDir"
  git -C $RepoDir fetch origin --quiet
  git -C $RepoDir reset --hard origin/main --quiet
} else {
  Write-Host "[git] clone → $RepoDir"
  git clone --depth 1 $RepoUrl $RepoDir
}

# --- 3) 토큰 확인 --------------------------------------------------------------
if (-not $Token) {
  $cfg = Join-Path $env:USERPROFILE '.orbit-config.json'
  if (Test-Path $cfg) { try { $Token = (Get-Content $cfg -Raw | ConvertFrom-Json).token } catch {} }
}
if (-not $Token) {
  Write-Host "[X] Orbit 토큰이 없습니다. -Token orbit_XXXX 로 전달하거나 ~/.orbit-config.json 에 넣으세요." -ForegroundColor Red
  exit 1
}
Write-Host "[OK] Orbit 토큰 확인 (orbit_...$($Token.Substring([Math]::Max(0,$Token.Length-4))))" -ForegroundColor Green

# --- 4) 환경변수 (무과금 CLI 모드 강제) ----------------------------------------
$env:ANTHROPIC_API_KEY   = ''                 # 반드시 공백 → CLI 구독으로만 분석($0)
$env:ORBIT_TOKEN         = $Token
$env:ORBIT_CLI_RESERVE_PCT = "$ReservePct"    # 주간 사용자 몫 보전 %
$env:VISION_MODEL_ROUTER = 'on'               # 핵심화면=Sonnet, 나머지=Haiku
# $env:ORBIT_SERVER_URL  = 'https://mindmap-viewer-production-adb2.up.railway.app'  # 기본값이라 생략 가능

# --- 5) 기동 ------------------------------------------------------------------
Set-Location $RepoDir
$log = Join-Path $env:USERPROFILE '.orbit\remote-vision.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
Write-Host "[run] node bin/vision-worker.js --server-queue" -ForegroundColor Cyan
Write-Host "      로그: $log"

$args = @('bin/vision-worker.js', '--server-queue')
if ($Once) { $args += '--once' }
& node @args *>> $log
