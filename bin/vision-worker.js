#!/usr/bin/env node
'use strict';
/**
 * vision-worker.js — Google Drive 캡처 Vision 분석 워커
 *
 * Google Drive "Orbit AI Captures" 폴더의 스크린샷을
 * Claude로 분석하여 서버에 결과 전송.
 *
 * 모드 1 (CLI — Claude Max 구독자): node bin/vision-worker.js
 * 모드 2 (API):                    ANTHROPIC_API_KEY=sk-xxx node bin/vision-worker.js
 *
 * CLI 모드는 API 키 없이 claude 명령어로 분석 (구독 포함)
 */

const https = require('https');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const { execFile, execSync } = require('child_process');
const _ocrTriage = require('../src/ocr-triage');   // OCR/Vision 분류기(기본 off)

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || (() => {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8')).anthropicApiKey || ''; }
  catch { return ''; }
})();
const ORBIT_SERVER = process.env.ORBIT_SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app';

// Claude CLI 경로 감지
const CLAUDE_CLI = (() => {
  try {
    return execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { timeout: 3000 })
      .toString().trim().split('\n')[0];
  } catch { return null; }
})();
const USE_CLI = !ANTHROPIC_KEY && !!CLAUDE_CLI;
const TEMP_DIR = path.join(os.tmpdir(), 'orbit-vision');
try { fs.mkdirSync(TEMP_DIR, { recursive: true }); } catch {}

// ── Claude CLI 전역 직렬화 락 ────────────────────────────────────────────────
// 여러 워커(--local/--spool 등)가 동시에 claude -p 를 호출하면 회전(rotating)
// OAuth refreshToken 을 경쟁 갱신하다 소실 → 자격증명 죽음(재로그인 후 하루 만에 반복 만료).
// 크로스프로세스 파일락으로 claude 호출을 한 번에 하나만 실행해 토큰을 보존한다.
const CLI_LOCK = path.join(os.homedir(), '.orbit', 'claude-cli.lock');
const CLI_LOCK_STALE_MS = 180000; // 3분(claude timeout 120s) 초과 점유 = 죽은 프로세스로 보고 회수
function _cliSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function _acquireCliLock(waitMs = 300000) {
  const start = Date.now();
  for (;;) {
    try { const fd = fs.openSync(CLI_LOCK, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return true; }
    catch {
      try { const st = fs.statSync(CLI_LOCK); if (Date.now() - st.mtimeMs > CLI_LOCK_STALE_MS) { fs.unlinkSync(CLI_LOCK); continue; } } catch {}
      if (Date.now() - start > waitMs) return false; // 과도한 대기 방지: 못 얻어도 진행
      await _cliSleep(400 + Math.floor(Math.random() * 400));
    }
  }
}
function _releaseCliLock() { try { fs.unlinkSync(CLI_LOCK); } catch {} }

// [화면 타임라인] 썸네일을 base64 자르기(→화면 상단만 보임) 대신 전체 화면을 축소해 저장.
// owner PC(Windows)의 System.Drawing으로 폭 900px JPEG로 리사이즈 → 전체 화면이 다 보이면서 작음.
// 실패 시 기존 방식(substring) 폴백. execSync는 무겁지만 캡처당 1회라 감당 가능.
function _makeThumb(base64) {
  try {
    if (!base64 || base64.length < 2000) return (base64 || '').substring(0, 100000);
    const inP = path.join(TEMP_DIR, `thin-${Date.now()}-${Math.floor(Math.random()*1e6)}.png`);
    const outP = inP.replace('.png', '.jpg');
    fs.writeFileSync(inP, Buffer.from(base64, 'base64'));
    const ps = `Add-Type -AssemblyName System.Drawing; `
      + `$img=[System.Drawing.Image]::FromFile('${inP}'); `
      + `$w=900; $h=[int]($img.Height*$w/$img.Width); `
      + `$bmp=New-Object System.Drawing.Bitmap($w,$h); $g=[System.Drawing.Graphics]::FromImage($bmp); `
      + `$g.InterpolationMode='HighQualityBicubic'; $g.DrawImage($img,0,0,$w,$h); `
      + `$eps=New-Object System.Drawing.Imaging.EncoderParameters(1); `
      + `$q=[System.Drawing.Imaging.Encoder]::Quality; $eps.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter($q,[long]62); `
      + `$codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|?{$_.MimeType -eq 'image/jpeg'}; `
      + `$bmp.Save('${outP}',$codec,$eps); $img.Dispose(); $bmp.Dispose()`;
    execSync(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g,'\\"')}"`, { timeout: 15000, windowsHide: true, stdio: 'pipe' });
    const out = fs.readFileSync(outP).toString('base64');
    try { fs.unlinkSync(inP); fs.unlinkSync(outP); } catch {}
    return out.length ? out : base64.substring(0, 100000);
  } catch { return (base64 || '').substring(0, 100000); }
}

// [2026-07-17 E1] 지각해시 중복컷 — 시각적으로 같은 프레임은 CLI 부르기 전에 걸러 사용량 절감.
// 8x8 그레이스케일 average hash(64bit). System.Drawing(=_makeThumb 동일 경로). 실패 시 null(중복판정 안 함=안전).
function _perceptualHash(base64) {
  try {
    if (!base64 || base64.length < 2000) return null;
    const inP = path.join(TEMP_DIR, `ph-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
    fs.writeFileSync(inP, Buffer.from(base64, 'base64'));
    const ps = `Add-Type -AssemblyName System.Drawing; `
      + `$img=[System.Drawing.Image]::FromFile('${inP}'); `
      + `$bmp=New-Object System.Drawing.Bitmap(8,8); $g=[System.Drawing.Graphics]::FromImage($bmp); `
      + `$g.InterpolationMode='HighQualityBicubic'; $g.DrawImage($img,0,0,8,8); `
      + `$v=@(); for($y=0;$y -lt 8;$y++){for($x=0;$x -lt 8;$x++){$p=$bmp.GetPixel($x,$y); $v+=[int](($p.R*30+$p.G*59+$p.B*11)/100)}}; `
      + `$img.Dispose(); $bmp.Dispose(); $a=($v|Measure-Object -Average).Average; `
      + `-join ($v|ForEach-Object{ if($_ -gt $a){'1'}else{'0'} })`;
    const out = execSync(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, { timeout: 10000, windowsHide: true, stdio: 'pipe' }).toString().trim();
    try { fs.unlinkSync(inP); } catch {}
    return /^[01]{64}$/.test(out) ? out : null;
  } catch { return null; }
}
const _dupCache = new Map(); // key(userId|app) → 최근 N개 지각해시(ring)
const DEDUP_ON = process.env.VISION_DEDUP !== 'off';
const DEDUP_MAXDIST = parseInt(process.env.VISION_DEDUP_DIST) || 5; // 해밍거리 ≤5 = 사실상 동일화면
const DEDUP_RECENT = parseInt(process.env.VISION_DEDUP_RECENT) || 12; // [B] 직전 1개 대신 최근 N개와 비교(비연속 중복도 컷)
let _skipStats = { dup: 0, blank: 0 };
function _hamming(a, b) { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; }
// [A] 빈/단색 프레임(잠금·로딩·검은/흰 화면): average-hash 1비트 수가 극단 = 시각 무정보 → 분석 불필요
function _isBlankHash(h) { const ones = (h.match(/1/g) || []).length; return ones <= 3 || ones >= 61; }
function _isDupFrame(base64, key) {
  if (!DEDUP_ON) return false;
  const h = _perceptualHash(base64);
  if (!h) return false;                 // 해시 실패 → 분석 진행(안전측)
  if (_isBlankHash(h)) { _skipStats.blank++; return true; }   // [A] 빈/단색 컷
  // [B] 최근 N개 중 하나라도 시각적으로 같으면 중복(A→B→A 왕복·재등장도 컷)
  let recent = _dupCache.get(key);
  if (!recent) { recent = []; _dupCache.set(key, recent); }
  const dup = recent.some(p => _hamming(p, h) <= DEDUP_MAXDIST);
  recent.push(h); if (recent.length > DEDUP_RECENT) recent.shift();
  if (_dupCache.size > 500) { const k = _dupCache.keys().next().value; _dupCache.delete(k); }
  if (dup) _skipStats.dup++;
  return dup;
}

// [2026-06-15] 야간 배치 모드(--night): 낮엔 큐 이미지를 디스크에 보관만(CLI 비용 0),
// 19:00~08:00에만 CLI 분석. owner PC를 켜두고 퇴근 → 구독한도/업무시간 충돌 없이 야간 처리.
const NIGHT_MODE = process.argv.includes('--night');
const FLUSH = process.argv.includes('--flush'); // 주간에도 vision-pending 백로그 즉시 소진
const NIGHT_START = 19, NIGHT_END = 8; // 19시~다음날 8시
const PENDING_DIR = path.join(os.homedir(), '.orbit', 'vision-pending');
try { fs.mkdirSync(PENDING_DIR, { recursive: true }); } catch {}
function _isNight() { const h = new Date().getHours(); return (h >= NIGHT_START || h < NIGHT_END); }
function _savePending(item) { try { fs.writeFileSync(path.join(PENDING_DIR, `${(item.id||Date.now())}.json`), JSON.stringify(item)); } catch {} }
const _triageSeen = new Map(); // `${user}|${app}|${win}` → 마지막 분석 캡처시각 (중복화면 컷)
function _pendingCount() { try { return fs.readdirSync(PENDING_DIR).filter(f=>f.endsWith('.json')).length; } catch { return 0; } }
let _pqBusy = false; // 재진입 방지 (야간 CLI는 분당 수십초 소요 → setInterval 겹침 방지)
const ORBIT_TOKEN = process.env.ORBIT_TOKEN || (() => {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8')).token || ''; }
  catch { return ''; }
})();
const LOCAL_USER = process.env.ORBIT_USER_ID || (() => {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8')).userId || ''; }
  catch { return ''; }
})();
const POLL_INTERVAL = 3 * 60 * 1000; // 3분

// ── Google 서비스 계정 ────────────────────────────────────────────────────────
let _gCred = null, _gFolder = null, _gToken = null, _gTokenExp = 0;

async function loadGoogleConfig() {
  return new Promise((resolve) => {
    const url = new URL('/api/daemon/drive-config', ORBIT_SERVER);
    const mod = url.protocol === 'https:' ? https : http;
    const h = {}; if (ORBIT_TOKEN) h['Authorization'] = 'Bearer ' + ORBIT_TOKEN;
    const req = mod.get({ hostname: url.hostname, port: url.port || 443, path: url.pathname, headers: h, timeout: 10000 }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const cfg = JSON.parse(d);
          if (cfg.enabled) {
            // credentialsJson 파싱 — DB 저장 시 이중 이스케이프 처리
            // private_key PEM의 \\n (chars 92,92,110) vs 구조적 \n (chars 92,110) 구분
            let credStr = cfg.credentialsJson || '';
            try {
              _gCred = JSON.parse(credStr); // 우선 직접 시도
            } catch {
              // Step 1: private_key 내부 \\n (이중 이스케이프) 보호
              credStr = credStr.replace(/\\\\n/g, '__ORBIT_NL__');
              // Step 2: 구조적 \n → 실제 줄바꿈
              credStr = credStr.replace(/\\n/g, '\n');
              // Step 3: 보호된 \\n → JSON string escape \n 복원
              credStr = credStr.replace(/__ORBIT_NL__/g, '\\n');
              _gCred = JSON.parse(credStr);
            }
            _gFolder = cfg.folderId;
          }
          resolve(cfg.enabled);
        } catch (e) { console.error('[vision] loadGoogleConfig 실패:', e.message); resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function gToken() {
  if (_gToken && Date.now() < _gTokenExp) return _gToken;
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg:'RS256', typ:'JWT' })}.${b64({ iss:_gCred.client_email, scope:'https://www.googleapis.com/auth/drive', aud:'https://oauth2.googleapis.com/token', iat:now, exp:now+3600 })}`;
  const sign = crypto.createSign('RSA-SHA256'); sign.update(unsigned);
  const jwt = `${unsigned}.${sign.sign(_gCred.private_key, 'base64url')}`;
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname:'oauth2.googleapis.com', path:'/token', method:'POST',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded', 'Content-Length':Buffer.byteLength(body) } }, res => {
      let d=''; res.on('data', c=>d+=c); res.on('end', ()=>{ const p=JSON.parse(d); _gToken=p.access_token; _gTokenExp=Date.now()+3500000; resolve(_gToken); });
    }); req.on('error', reject); req.write(body); req.end();
  });
}

function gApi(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const h = { 'Authorization': `Bearer ${token}` };
    if (payload) { h['Content-Type']='application/json'; h['Content-Length']=Buffer.byteLength(payload); }
    const req = https.request({ hostname:u.hostname, path:u.pathname+u.search, method, headers:h, timeout:30000 }, res => {
      let d=''; res.on('data', c=>d+=c); res.on('end', ()=>{ try { resolve(JSON.parse(d)); } catch { resolve({ raw:d }); } });
    }); req.on('error', reject); if(payload) req.write(payload); req.end();
  });
}

function gDownload(fileId, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname:'www.googleapis.com', path:`/drive/v3/files/${fileId}?alt=media`, method:'GET',
      headers:{ 'Authorization':`Bearer ${token}` }, timeout:30000 }, res => {
      const chunks=[]; res.on('data', c=>chunks.push(c)); res.on('end', ()=>resolve(Buffer.concat(chunks).toString('base64')));
    }); req.on('error', reject); req.end();
  });
}

// ── 미분석 캡처 찾기 ──────────────────────────────────────────────────────────
async function findCaptures() {
  const token = await gToken();
  const caps = [];

  // 1차: 설정 폴더 내 hostname 서브폴더 → PNG
  if (_gFolder) {
    try {
      const folders = await gApi('GET', `https://www.googleapis.com/drive/v3/files?q='${_gFolder}'+in+parents+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&fields=files(id,name)`, token);
      for (const f of (folders.files || [])) {
        const files = await gApi('GET', `https://www.googleapis.com/drive/v3/files?q='${f.id}'+in+parents+and+mimeType='image/png'+and+trashed=false&fields=files(id,name,description,createdTime)&orderBy=createdTime+desc&pageSize=10`, token);
        for (const img of (files.files || [])) {
          if (img.description?.includes('analyzed')) continue;
          caps.push({ id:img.id, name:img.name, hostname:f.name, ts:img.createdTime });
        }
      }
    } catch (e) { console.warn('[vision] 설정 폴더 스캔 실패:', e.message); }
  }

  // 2차 폴백: 서비스 계정 Drive 루트에서 직접 PNG 검색 (hostname=파일명에서 추출)
  if (!caps.length) {
    console.log('[vision] 폴백: 루트 Drive PNG 검색');
    const rootPngs = await gApi('GET', `https://www.googleapis.com/drive/v3/files?q=mimeType='image/png'+and+trashed=false&fields=files(id,name,description,createdTime,parents)&orderBy=createdTime+desc&pageSize=30`, token);
    for (const img of (rootPngs.files || [])) {
      if (img.description?.includes('analyzed')) continue;
      // hostname을 파일명에서 추론 (screen-{ts}-{trigger}-{hostname}.png 형식 시도)
      const hostnameMatch = img.name.match(/[-_]([A-Z][A-Z0-9\-]{4,})\.png$/i);
      const hostname = hostnameMatch?.[1] || 'unknown-host';
      caps.push({ id:img.id, name:img.name, hostname, ts:img.createdTime });
    }
  }

  return caps;
}

// ── 분석 프롬프트 ─────────────────────────────────────────────────────────────
function _buildPrompt(ctx) {
  // [골:실행좌표 융합] 이 화면에서 실제 클릭된 좌표들(같은 payload에 첨부됨)을 필드에 매핑시킨다.
  // 캡처는 primary 모니터만 담으므로, 이미지 밖(멀티모니터) 좌표는 무시하라고 명시.
  let clickBlock = '';
  const clicks = (ctx.recentClicks || []).filter(c => c && typeof c.x === 'number' && typeof c.y === 'number').slice(-8);
  if (clicks.length) {
    clickBlock = `\n[실제 클릭 좌표] 이 스크린샷 직전 사용자가 클릭한 픽셀 좌표들이다(시간순). 이미지는 주 모니터(primary)만 담으므로 이미지 경계 밖 좌표는 다른 모니터라 무시하라. 이미지 안쪽 좌표는 그 위치의 필드/버튼을 특정하는 근거로 써라:\n${clicks.map((c,i)=>`  ${i+1}. (${c.x}, ${c.y})`).join('\n')}\n각 field가 위 클릭 중 하나와 겹치면 그 field에 "clickXY":[x,y] 를 넣어라(겹치는 게 확실할 때만, 아니면 생략).\n`;
  }
  return `스크린샷을 정밀 분석해주세요. 호스트: ${ctx.hostname}${clickBlock}
다음 JSON 형식으로만 응답 (마크다운 없이 순수 JSON):
{
  "app": "실제 프로그램명",
  "screen": "현재 화면/메뉴명 (예: 신규주문등록, 카카오톡 호남소재 단톡방)",
  "activity": "사용자가 지금 하는 작업 1줄 (구체적으로)",
  "workCategory": "전산처리|문서작업|커뮤니케이션|파일관리|웹검색|기타",

  "fields": [
    {
      "name": "필드/항목명",
      "type": "input|button|dropdown|table|text|checkbox",
      "currentValue": "현재 입력된 값 (보이는 경우)",
      "position": "화면 위치 (상단/중앙/하단 + 좌/우)",
      "clickXY": "[x,y] — 위 실제 클릭 좌표 중 이 필드에 떨어진 것(있을 때만, pyautogui 실행 좌표로 씀)",
      "dataSource": "kakao|manual|erp|clipboard|unknown",
      "humanRequired": true/false,
      "humanReason": "사람 판단 필요한 이유 (humanRequired가 true일 때만)"
    }
  ],

  "autoAreas": ["자동화 가능한 작업 목록 — 데이터 출처가 명확한 것"],
  "humanAreas": ["반드시 사람이 판단해야 하는 영역 — 의사결정/확인/예외처리"],

  "nenovaAction": "nenova ERP에서 해당하는 화면명 (해당없으면 null)",
  "nenovaInputMap": [
    {
      "field": "nenova 입력 필드명",
      "value": "입력할 값 또는 데이터 출처",
      "source": "kakao_parse|clipboard|manual|formula",
      "automatable": true/false
    }
  ],

  "automationScore": 0.0~1.0,
  "automatable": true/false,
  "automationHint": "자동화 구현 방법 (PAD UI셀렉터 or pyautogui 좌표 or 클립보드)",
  "padPossible": true/false,
  "scriptType": "PAD|pyautogui|clipboard|none"
}`;
}

function _parseResult(text) {
  if (!text) return { raw: '' };

  let jsonStr = null;

  // Strategy 1: ```json ... ``` 코드블록에서 추출
  const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlock) jsonStr = codeBlock[1].trim();

  // Strategy 2: 가장 바깥 { ... } 추출
  if (!jsonStr) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) jsonStr = m[0];
  }

  if (jsonStr) {
    // Claude가 프롬프트 템플릿 힌트를 그대로 넣는 문제 수정
    const cleaned = jsonStr
      .replace(/:\s*true\/false/g, ': true')              // "true/false" → true
      .replace(/:\s*(\d+\.?\d*)~(\d+\.?\d*)/g, ': $1')   // "0.0~1.0" → 0.0
      .replace(/,\s*([}\]])/g, '$1')                       // trailing comma
      .replace(/\/\/[^\n]*/g, '')                           // line comment
      .replace(/\/\*[\s\S]*?\*\//g, '');                    // block comment

    try { return JSON.parse(cleaned); } catch {}
    try { return JSON.parse(jsonStr); } catch {}
  }

  // Strategy 3: 전체 텍스트를 JSON으로 시도
  try { return JSON.parse(text.trim()); } catch {}

  // 실패 — 디버깅용 원본 2000자 보존
  return { raw: text.substring(0, 2000) };
}

// ── [모델 라우터] 화면 가치별 모델 선택 — 사용량 절감 ─────────────────────────
// 핵심 업무화면(nenova·ECOUNT·주문/출고·엑셀 등)=고급(Sonnet), 나머지=경량(Haiku).
// VISION_MODEL_ROUTER=off 로 끄면 단일 모델(VISION_CLI_MODEL/기본).
const MODEL_HIGH = process.env.VISION_MODEL_HIGH || 'sonnet';
const MODEL_BULK = process.env.VISION_MODEL_BULK || 'haiku';
const ROUTER_ON  = process.env.VISION_MODEL_ROUTER !== 'off';
// [2026-07-17 A1] 카톡(kakao)도 고가치 승격 — 회사 주문·발주·배송·거래처 정보가 카톡에 실려 옴.
// 라우터는 앱명만 보므로 카톡은 앱명(kakao/카카오/카톡)으로 잡아 Sonnet 처리(정확도↑).
// [2026-07-30 1A] 커버리지 확대 — 화훼·무역 업무화면(구글시트/문서·송장/배송·매출입·꽃상품 등)도
// Sonnet으로 → fields+clickXY 커버리지↑(골모드 좌표). 카톡(A1)에 이어 업무 콘텐츠 키워드 추가.
const HIGH_VALUE_RE = new RegExp(process.env.VISION_HIGH_VALUE_RE || 'nenova|ecount|이카운트|화훼|주문|출고|발주|견적|재고|erp|excel|엑셀|정산|채권|채무|무역|통관|검수|분배|kakao|카카오|카톡|sheets|docs|스프레드시트|구글시트|송장|배송|운송|택배|invoice|인보이스|명세|청구|입금|출금|송금|결제|매출|매입|카네이션|carnation|화환|장미|거래처|납품|수주', 'i');
const API_MODEL_ID = { sonnet: 'claude-sonnet-4-20250514', haiku: 'claude-haiku-4-5-20251001' };
function pickModel(ctx) {
  if (ctx && ctx.forceModel) return ctx.forceModel; // 로컬 폴더 모드: 메타데이터 없어 라우팅 불가 → 명시 모델
  if (!ROUTER_ON) return process.env.VISION_CLI_MODEL || null;
  const hay = ((ctx && ctx.name) || '') + ' ' + ((ctx && ctx.windowTitle) || '');
  return HIGH_VALUE_RE.test(hay) ? MODEL_HIGH : MODEL_BULK;
}

// ── Claude CLI 분석 (Max 구독 — API 키 불필요) ───────────────────────────────
async function visionCli(base64, ctx, model) {
  const tmpFile = path.join(TEMP_DIR, `cap-${Date.now()}.png`);
  fs.writeFileSync(tmpFile, Buffer.from(base64, 'base64'));
  // CLI는 프롬프트에 파일 경로를 포함하면 Read 도구로 이미지 인식
  const prompt = `${tmpFile} ${_buildPrompt(ctx)}`;

  const _locked = await _acquireCliLock(); // 여러 워커 동시 claude 호출 직렬화(회전 토큰 보존)
  return new Promise((resolve) => {
    // VISION_CLI_MODEL로 모델 지정(예: sonnet / haiku). 미설정 시 CLI 계정 기본모델.
    const _args = ['-p', prompt, '--allowedTools', 'Read', '--add-dir', TEMP_DIR];
    const _m = model || process.env.VISION_CLI_MODEL;
    if (_m) _args.push('--model', _m);
    execFile(CLAUDE_CLI, _args,
      { timeout: 120000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (_locked) _releaseCliLock();
      if (err) { console.warn(`  CLI 분석 실패: ${err.message}`); resolve(null); return; }
      resolve(_parseResult(String(stdout)));
    });
  });
}

// ── Claude API 분석 (API 키 사용) ─────────────────────────────────────────────
async function visionApi(base64, ctx, model) {
  const prompt = _buildPrompt(ctx);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: (model && (API_MODEL_ID[model] || model)) || process.env.VISION_API_MODEL || 'claude-sonnet-4-20250514', max_tokens: 1024,
      messages: [{ role:'user', content:[
        { type:'image', source:{ type:'base64', media_type:'image/png', data:base64 } },
        { type:'text', text:prompt },
      ]}],
    });
    const req = https.request({ hostname:'api.anthropic.com', path:'/v1/messages', method:'POST', timeout:60000,
      headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01', 'Content-Length':Buffer.byteLength(body) },
    }, res => {
      let d=''; res.on('data', c=>d+=c);
      res.on('end', ()=>{
        try { resolve(_parseResult(JSON.parse(d).content?.[0]?.text)); }
        catch(e) { reject(e); }
      });
    }); req.on('error', reject); req.write(body); req.end();
  });
}

// ── 결과 유효성 검사 ─────────────────────────────────────────────────────────
function _isValidResult(result) {
  if (!result) return false;
  if (result.raw !== undefined && !result.app) return false; // 파싱 실패
  return !!(result.app || result.activity || result.screen);
}

// OCR-only 판정건: 텍스트를 screen.ocr 이벤트로 보존(Claude 미호출). enforce(on) 모드에서만 호출.
function _emitOcrEvent(ctx, ocrText) {
  try {
    ctx = ctx || {};
    const payload = JSON.stringify({ events: [{
      id: `ocr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      type: 'screen.ocr', source: 'vision-worker-ocr',
      sessionId: ctx.sessionId || `daemon-${ctx.hostname || ''}`,
      userId: ctx.userId || undefined,
      timestamp: ctx.ts || new Date().toISOString(),
      data: {
        hostname: ctx.hostname || '', app: ctx.name || '', windowTitle: ctx.windowTitle || '',
        originalCaptureId: ctx.captureId || undefined,
        ocrText: (ocrText || '').slice(0, 8000), route: 'ocr',
      },
    }] });
    const u = new URL('/api/hook', ORBIT_SERVER);
    const mod = u.protocol === 'https:' ? https : http;
    const h = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (ORBIT_TOKEN) h['Authorization'] = 'Bearer ' + ORBIT_TOKEN;
    const r = mod.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST', headers: h, timeout: 10000 }, res => res.resume());
    r.on('error', () => {}); r.write(payload); r.end();
  } catch {}
}

// ── 통합 분석 함수 (1회 재시도 포함) ─────────────────────────────────────────
async function visionAnalyze(base64, ctx) {
  const analyze = USE_CLI ? visionCli : ANTHROPIC_KEY ? visionApi : null;
  if (!analyze) throw new Error('Claude CLI 또는 ANTHROPIC_API_KEY 필요');

  // ── OCR 트리아지 (env VISION_OCR_TRIAGE=shadow|on, 기본 off) ─────────────────
  // shadow: 분류·집계만(Claude는 그대로 호출 → 손실0 실측). on: OCR판정건은 Claude 스킵.
  const _tmode = _ocrTriage.mode();
  if (_tmode !== 'off') {
    try {
      const _ocr = _ocrTriage.ocrExtract(base64);
      const _dec = _ocrTriage.classify(ctx, _ocr);
      _ocrTriage.tally(_dec, ctx);
      if (_dec.route === 'ocr') {
        console.log(`  [ocr-triage:${_tmode}] OCR-only ← ${((ctx && ctx.name) || '').slice(0, 24)} (${_dec.reason}, ${_ocr.wordCount}단어)`);
        if (_tmode === 'on') {
          _emitOcrEvent(ctx, _ocr.text);   // 텍스트 보존(screen.ocr), Claude 미호출
          return null;                     // 호출측은 null=스킵으로 처리
        }
      }
    } catch (e) { console.warn(`  [ocr-triage] 실패(무시, Vision 진행): ${e.message}`); }
  }

  const model = pickModel(ctx); // 화면 가치별 모델 (핵심=Sonnet, 나머지=Haiku)
  if (ROUTER_ON) console.log(`  [모델] ${model || '기본'} ← ${((ctx && ctx.name) || '').slice(0, 24)}`);

  let result = await analyze(base64, ctx, model);
  if (_isValidResult(result)) return result;

  // 1회 재시도
  console.log('  ⟳ 빈 결과 — 1회 재시도');
  await new Promise(r => setTimeout(r, 3000));
  result = await analyze(base64, ctx, model);
  if (_isValidResult(result)) return result;

  console.warn(`  ✗ 재시도 후에도 빈 결과 (${ctx.hostname}/${ctx.name})`);
  return null;
}

// ── 결과 서버 전송 ────────────────────────────────────────────────────────────
function sendToServer(cap, analysis, base64Thumbnail) {
  const eventData = { fileId:cap.id, filename:cap.name, hostname:cap.hostname, ...analysis };
  // 썸네일 포함 (100KB 이하로 리사이즈 — 원본의 처음 부분)
  if (base64Thumbnail) {
    // base64 이미지의 앞 100KB만 전송 (썸네일 용도)
    eventData.thumbnail = _makeThumb(base64Thumbnail);  // 전체 화면 축소(잘라내기 아님)
  }
  const payload = JSON.stringify({ events:[{
    id:`vision-${Date.now()}-${cap.id.substring(0,6)}`, type:'screen.analyzed', source:'vision-worker',
    sessionId:`daemon-${cap.hostname}`, timestamp:cap.ts || new Date().toISOString(),
    data: eventData,
  }] });
  return new Promise(resolve => {
    const url = new URL('/api/hook', ORBIT_SERVER);
    const mod = url.protocol === 'https:' ? https : http;
    const h = { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(payload) };
    if (ORBIT_TOKEN) h['Authorization'] = 'Bearer ' + ORBIT_TOKEN;
    const req = mod.request({ hostname:url.hostname, port:url.port||443, path:url.pathname, method:'POST', headers:h, timeout:10000 }, res => {
      res.resume(); resolve(res.statusCode < 300);
    }); req.on('error', ()=>resolve(false)); req.write(payload); req.end();
  });
}

// ── Google Sheets 저장 ──────────────────────────────────────────────────────
let _sheetsId = null;

async function _ensureVisionSheet(token) {
  if (_sheetsId) return _sheetsId;

  // 기존 "Vision 분석" 시트 검색
  try {
    const q = encodeURIComponent("name='Orbit AI Vision 분석' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false");
    const search = await gApi('GET', `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&orderBy=modifiedTime+desc&pageSize=1`, token);
    if (search.files && search.files.length > 0) {
      _sheetsId = search.files[0].id;
      console.log(`[vision] 기존 Sheets 발견: ${_sheetsId}`);
      return _sheetsId;
    }
  } catch {}

  // 새 스프레드시트 생성 (Sheets API 스코프 토큰 필요)
  const sheetsToken = await _getSheetsToken();
  const result = await gApi('POST', 'https://sheets.googleapis.com/v4/spreadsheets', sheetsToken, {
    properties: { title: 'Orbit AI Vision 분석' },
    sheets: [{ properties: { title: 'Vision 분석', index: 0 } }],
  });
  _sheetsId = result.spreadsheetId;
  console.log(`[vision] 새 Sheets 생성: ${_sheetsId}`);

  // 폴더로 이동
  if (_gFolder) {
    try { await gApi('PATCH', `https://www.googleapis.com/drive/v3/files/${_sheetsId}?addParents=${_gFolder}&fields=id`, token); } catch {}
  }

  // dlaww584@gmail.com에 공유
  try {
    await gApi('POST', `https://www.googleapis.com/drive/v3/files/${_sheetsId}/permissions`, sheetsToken, {
      type: 'user', role: 'writer', emailAddress: 'dlaww584@gmail.com',
    });
    console.log('[vision] Sheets 공유 완료: dlaww584@gmail.com');
  } catch (e) { console.warn('[vision] Sheets 공유 실패:', e.message); }

  // 헤더 행 추가
  try {
    const hUrl = `https://sheets.googleapis.com/v4/spreadsheets/${_sheetsId}/values/${encodeURIComponent('Vision 분석!A1')}?valueInputOption=RAW`;
    await gApi('PUT', hUrl, sheetsToken, {
      range: 'Vision 분석!A1', majorDimension: 'ROWS',
      values: [['시간', '호스트', '파일명', '앱', '화면', '활동', '자동화가능', '자동화힌트', '카테고리']],
    });
  } catch (e) { console.warn('[vision] 헤더 기록 실패:', e.message); }

  return _sheetsId;
}

let _sheetsToken = null, _sheetsTokenExp = 0;

async function _getSheetsToken() {
  if (_sheetsToken && Date.now() < _sheetsTokenExp) return _sheetsToken;
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg:'RS256', typ:'JWT' })}.${b64({
    iss: _gCred.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  })}`;
  const sign = crypto.createSign('RSA-SHA256'); sign.update(unsigned);
  const jwt = `${unsigned}.${sign.sign(_gCred.private_key, 'base64url')}`;
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname:'oauth2.googleapis.com', path:'/token', method:'POST',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded', 'Content-Length':Buffer.byteLength(body) } }, res => {
      let d=''; res.on('data', c=>d+=c); res.on('end', ()=>{
        const p = JSON.parse(d); _sheetsToken = p.access_token; _sheetsTokenExp = Date.now() + 3500000; resolve(_sheetsToken);
      });
    }); req.on('error', reject); req.write(body); req.end();
  });
}

async function saveToSheets(cap, analysis) {
  try {
    const driveToken = await gToken();
    const sheetId = await _ensureVisionSheet(driveToken);
    const sheetsToken = await _getSheetsToken();

    const ts = cap.ts ? new Date(cap.ts).toLocaleString('ko-KR') : new Date().toLocaleString('ko-KR');
    const row = [
      ts,
      cap.hostname || '',
      cap.name || '',
      analysis.app || '',
      analysis.screen || '',
      analysis.activity || '',
      analysis.automatable ? '가능' : '불가',
      analysis.automationHint || '',
      analysis.workCategory || '',
    ];

    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent('Vision 분석!A:I')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    await gApi('POST', appendUrl, sheetsToken, {
      range: 'Vision 분석!A:I', majorDimension: 'ROWS', values: [row],
    });
    console.log(`  → Sheets 저장 완료`);
    return true;
  } catch (e) {
    console.warn(`  → Sheets 저장 실패: ${e.message}`);
    return false;
  }
}

// ── 메인 루프 ─────────────────────────────────────────────────────────────────
async function processBatch() {
  try {
    const caps = await findCaptures();
    if (!caps.length) return 0;
    console.log(`[vision] 미분석: ${caps.length}건`);
    const token = await gToken();
    let done = 0;
    for (const cap of caps.slice(0, 5)) {
      try {
        console.log(`[vision] ${cap.hostname}/${cap.name}`);
        const b64 = await gDownload(cap.id, token);
        // 빈 파일(0바이트) 감지 → Drive에서 삭제 후 스킵
        if (!b64 || b64.length < 100) {
          console.warn(`  ✗ 빈 파일(${b64?.length || 0}바이트) — Drive 삭제: ${cap.name}`);
          try { await gApi('DELETE', `https://www.googleapis.com/drive/v3/files/${cap.id}`, token, null); } catch {}
          continue;
        }
        // [E1+] Drive 모드에도 중복/빈화면 컷(기존 누락) — Claude 호출 전 스킵해 사용량 절감
        if (_isDupFrame(b64, `drive|${cap.hostname || ''}`)) {
          console.log(`  ⇢ 중복/빈화면 스킵(Drive): ${cap.name}`);
          try { await gApi('DELETE', `https://www.googleapis.com/drive/v3/files/${cap.id}`, token, null); } catch {}
          continue;
        }
        const result = await visionAnalyze(b64, cap);
        if (!result) { console.warn(`  ✗ 분석 실패 — 스킵: ${cap.name}`); continue; }
        console.log(`  → ${result.app}: ${result.activity?.substring(0,50)}`);
        await sendToServer(cap, result, b64);
        await saveToSheets(cap, result);
        // 분석 완료 마킹 후 Drive에서 파일 삭제
        await gApi('DELETE', `https://www.googleapis.com/drive/v3/files/${cap.id}`, token, null);
        console.log(`  → Drive 파일 삭제 완료: ${cap.name}`);
        done++;
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) { console.warn(`  실패: ${e.message}`); }
    }
    return done;
  } catch (e) { console.error('[vision] 에러:', e.message); return 0; }
}

// ── 서버 큐 모드: /api/vision/queue에서 이미지 가져와 CLI 분석 ───────────────
async function processServerQueue() {
  if (_pqBusy) return 0;
  // 구독 사용량 가드: 사용자 몫 30% 보전 — 사용량 70%↑면 이번 사이클 스킵(리셋 후 자동 재개)
  try {
    const q = await require('../src/quota-guard').checkQuota(30);
    if (q.pause) { console.log('[quota]', q.reason); return 0; }
  } catch {}
  _pqBusy = true;
  try {
    const url = new URL('/api/vision/queue', ORBIT_SERVER);
    url.searchParams.set('n', String(QUEUE_BATCH_N)); // 사용자별 라운드로빈 배치 크기(서버측 상한 40)
    const mod = url.protocol === 'https:' ? https : http;
    const h = {}; if (ORBIT_TOKEN) h['Authorization'] = 'Bearer ' + ORBIT_TOKEN;

    const queueData = await new Promise((resolve) => {
      const req = mod.get({ hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, headers: h, timeout: 15000 }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ batch: [] }); } });
      });
      req.on('error', () => resolve({ batch: [] }));
      req.end();
    });

    const batch = queueData.batch || [];
    // 주간(--night) — 큐 이미지를 디스크에 보관만 (CLI 비용 0). 큐는 비워 서버 메모리 보호. 분석은 야간.
    if (NIGHT_MODE && !_isNight() && !FLUSH) {
      for (const item of batch) if (item.imageBase64) _savePending(item);
      if (batch.length) console.log(`[vision-collect] 주간 보관 ${batch.length}건 (분석 ${NIGHT_START}시~, 누적 ${_pendingCount()}건)`);
      return batch.length;
    }
    // 야간(또는 일반 모드) — 디스크 누적분을 큐와 합쳐 처리
    let pending = [];
    if (NIGHT_MODE || FLUSH) {
      try {
        pending = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json')).slice(0, 15)
          .map(f => { try { const it = JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), 'utf8')); it.__pf = path.join(PENDING_DIR, f); return it; } catch { try { fs.unlinkSync(path.join(PENDING_DIR, f)); } catch {} return null; } })
          .filter(Boolean);
      } catch {}
    }
    let work = [...batch, ...pending];
    if (!work.length) return 0;
    // ── 트리아지: 분석 가치 없는 캡처 선별 컷 (같은 사람·앱·창을 3분 내 재분석 금지 — 화면 안 바뀜) ──
    // 목적: CLI 처리량을 "새 정보가 있는 화면"에만 쓴다. 백로그의 대부분이 동일화면 반복 캡처.
    // [2026-07-13] 10분→3분 완화: 작업세션 판정(/api/vision/task-sessions)이 "10분 내 분석 3장+"를
    // 요구하는데, 큐 항목의 app·windowTitle이 빈 값이 많아 유저당 키 1개로 뭉개짐 → 10분 컷이면
    // 유저당 최대 1장/10분이라 세션이 구조적으로 형성 불가. 3분 컷 = 유저·키당 최대 3~4장/10분.
    work.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0)); // 최신 우선
    const before = work.length;
    work = work.filter(item => {
      const key = `${item.userId || item.hostname}|${item.app || ''}|${(item.windowTitle || '').slice(0, 40)}`;
      const itemMs = new Date(item.ts || Date.now()).getTime();
      const last = _triageSeen.get(key);
      if (last && Math.abs(itemMs - last) < 3 * 60 * 1000) {
        if (item.__pf) { try { fs.unlinkSync(item.__pf); } catch {} } // 누적분도 컷하면 파일 정리
        return false;
      }
      _triageSeen.set(key, itemMs);
      if (_triageSeen.size > 800) { const k = _triageSeen.keys().next().value; _triageSeen.delete(k); }
      return true;
    });
    const cut = before - work.length;
    console.log(`[vision-queue] 처리 ${work.length}건 (트리아지 컷 ${cut}, 큐:${batch.length} 누적:${pending.length}, 대기:${queueData.pending || 0})`);

    let done = 0;
    for (const item of work) {
      try {
        if (!item.imageBase64) { console.warn('  이미지 없음, 스킵'); continue; }
        console.log(`[vision-queue] ${item.hostname}/${item.app}: ${item.windowTitle || ''}`);

        const result = await visionAnalyze(item.imageBase64, {
          hostname: item.hostname, name: item.app || 'capture', windowTitle: item.windowTitle || '',
          recentClicks: item.recentClicks,  // [골:실행좌표 융합] 서버 큐가 첨부한 직전 클릭들
        });
        if (!result) continue;

        console.log(`  → ${result.app}: ${(result.activity || '').substring(0, 50)}`);

        // screen.analyzed 이벤트로 서버에 전송 (분석 결과 전체 포함)
        const payload = JSON.stringify({ events: [{
          id: `vision-cli-${Date.now()}-${done}`, type: 'screen.analyzed', source: 'vision-cli-worker',
          sessionId: item.sessionId, userId: item.userId,
          timestamp: item.ts || new Date().toISOString(),
          data: {
            hostname: item.hostname,
            originalCaptureId: item.id,
            ...result,
            app: result.app || item.app || '',
            // 썸네일 (100KB 이하 — 관리자 대시보드 표시용)
            thumbnail: item.imageBase64 ? _makeThumb(item.imageBase64) : undefined,  // 전체 화면 축소
          },
        }] });

        await new Promise(resolve => {
          const sUrl = new URL('/api/hook', ORBIT_SERVER);
          const sMod = sUrl.protocol === 'https:' ? https : http;
          const sh = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
          if (ORBIT_TOKEN) sh['Authorization'] = 'Bearer ' + ORBIT_TOKEN;
          const sr = sMod.request({ hostname: sUrl.hostname, port: sUrl.port || 443, path: sUrl.pathname, method: 'POST', headers: sh, timeout: 10000 },
            r => { r.resume(); resolve(r.statusCode < 300); });
          sr.on('error', () => resolve(false)); sr.write(payload); sr.end();
        });

        done++;
        if (item.__pf) { try { fs.unlinkSync(item.__pf); } catch {} } // 누적분 처리완료 → 삭제
        await new Promise(r => setTimeout(r, 2000)); // CLI 쿨다운
      } catch (e) { console.warn(`  분석 실패: ${e.message}`); }
    }
    return done;
  } catch (e) { console.error('[vision-queue] 에러:', e.message); return 0; }
  finally { _pqBusy = false; }
}

// ── 로컬 폴더 모드: ~/.orbit/captures/*.png 백로그 소급 분석 ──────────────────
// 서버 큐 경로는 인라인 이미지가 실린 캡처만 담겨 백로그를 못 잡는다(구조적). 이 모드는
// 각 PC가 링버퍼로 쌓아둔 실제 PNG를 직접 소스로 삼아 무과금 CLI로 소급 분석한다.
// PNG는 데몬 소유물이라 삭제하지 않고, 처리분은 상태파일에 기록해 재실행 시 건너뛴다.
const LOCAL_DIR = (() => {
  const i = process.argv.indexOf('--local');
  const p = i >= 0 ? process.argv[i + 1] : null;
  return (p && !p.startsWith('--')) ? p : path.join(os.homedir(), '.orbit', 'captures');
})();
const LOCAL_STATE_FILE = path.join(os.homedir(), '.orbit', 'vision-local-state.json');
const LOCAL_BATCH = parseInt(process.env.VISION_LOCAL_BATCH) || 30;      // 틱당 분석 상한
const LOCAL_MIN_GAP_MS = parseInt(process.env.VISION_LOCAL_GAP_MS) || 40000; // 유지 프레임 간 최소 간격(중복 컷)
const LOCAL_FORCE_MODEL = process.env.VISION_LOCAL_MODEL || null;         // 미지정=라우터(메타없어 Haiku), 'sonnet'=강제
let _localDone = (() => { try { return new Set(JSON.parse(fs.readFileSync(LOCAL_STATE_FILE, 'utf8')).done || []); } catch { return new Set(); } })();
function _saveLocalState() { try { fs.writeFileSync(LOCAL_STATE_FILE, JSON.stringify({ done: [..._localDone].slice(-5000) })); } catch {} }
let _localBusy = false;

async function processLocalDir() {
  if (_localBusy) return 0;
  try {
    const q = await require('../src/quota-guard').checkQuota(30);
    if (q.pause) { console.log('[vision-local][quota]', q.reason); return 0; }
  } catch {}
  _localBusy = true;
  try {
    let files;
    try { files = fs.readdirSync(LOCAL_DIR).filter(f => f.endsWith('.png')); }
    catch { console.warn(`[vision-local] 폴더 없음: ${LOCAL_DIR}`); return 0; }
    const host = os.hostname();
    // 파일명에서 epoch·트리거 파싱, 미처리분만, 오래된→최신(세션 순서 보존)
    const cand = files.map(f => {
      const m = f.match(/screen-(\d+)-([a-z_]+)-([a-z]+)\.png/i);
      return m ? { f, epoch: parseInt(m[1]), trigger: m[2], focus: m[3] } : null;
    }).filter(x => x && !_localDone.has(x.f)).sort((a, b) => a.epoch - b.epoch);
    if (!cand.length) { console.log(`[vision-local] 신규 없음 (총 ${files.length}, 처리완료 ${_localDone.size})`); return 0; }
    // 중복 컷: 유지 프레임 간 최소 간격. mouse_click(의도적 클릭)은 항상 유지.
    const work = []; let lastKept = 0;
    for (const c of cand) {
      if (c.trigger === 'mouse_click' || c.epoch - lastKept >= LOCAL_MIN_GAP_MS) { work.push(c); lastKept = c.epoch; }
      else _localDone.add(c.f); // 컷도 처리완료로 기록(재스캔 방지)
    }
    const batch = work.slice(0, LOCAL_BATCH);
    console.log(`[vision-local] 대상 ${batch.length}/${work.length}건 (신규후보 ${cand.length}, 폴더 ${LOCAL_DIR})`);

    let done = 0;
    for (const c of batch) {
      try {
        const full = path.join(LOCAL_DIR, c.f);
        const stat = fs.statSync(full);
        if (stat.size > 6_000_000) { _localDone.add(c.f); continue; } // 6MB↑ 스킵
        const base64 = fs.readFileSync(full).toString('base64');
        const iso = new Date(c.epoch).toISOString();
        // [E1] 직전과 시각적으로 같은 화면이면 분석 스킵(처리완료 기록해 재스캔 방지)
        if (_isDupFrame(base64, `local|${host}`)) { _localDone.add(c.f); continue; }
        const result = await visionAnalyze(base64, {
          hostname: host, name: 'capture', windowTitle: '', trigger: c.trigger,
          forceModel: LOCAL_FORCE_MODEL,
        });
        if (!result) { console.warn(`  ✗ 분석 실패 — 다음 스캔 재시도: ${c.f}`); continue; }
        console.log(`  → ${result.app || '?'}: ${(result.activity || '').substring(0, 50)}`);
        const payload = JSON.stringify({ events: [{
          id: `vision-local-${c.epoch}`, type: 'screen.analyzed', source: 'vision-local-worker',
          sessionId: `local-${host}-${Math.floor(c.epoch / 1800000)}`, // 30분 버킷 = 세션 형성 도움
          userId: LOCAL_USER, timestamp: iso,
          data: { hostname: host, originalCaptureId: c.f, trigger: c.trigger, ...result,
            app: result.app || '', thumbnail: _makeThumb(base64) },
        }] });
        const ok = await new Promise(resolve => {
          const sUrl = new URL('/api/hook', ORBIT_SERVER);
          const sMod = sUrl.protocol === 'https:' ? https : http;
          const sh = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
          if (ORBIT_TOKEN) sh['Authorization'] = 'Bearer ' + ORBIT_TOKEN;
          const sr = sMod.request({ hostname: sUrl.hostname, port: sUrl.port || 443, path: sUrl.pathname, method: 'POST', headers: sh, timeout: 10000 },
            r => { r.resume(); resolve(r.statusCode < 300); });
          sr.on('error', () => resolve(false)); sr.write(payload); sr.end();
        });
        if (ok) { _localDone.add(c.f); done++; }        // 전송 성공분만 완료 기록
        if (done % 10 === 0) _saveLocalState();
        await new Promise(r => setTimeout(r, 2000));      // CLI 쿨다운
      } catch (e) { console.warn(`  분석 실패: ${e.message}`); }
    }
    _saveLocalState();
    console.log(`[vision-local] 처리 ${done}건 전송 (누적 완료 ${_localDone.size})`);
    return done;
  } catch (e) { console.error('[vision-local] 에러:', e.message); return 0; }
  finally { _localBusy = false; }
}

// ── 스풀 모드: 서버 볼륨에 모인 전 직원 백로그를 owner PC 무과금 CLI로 소진 ──────
// 데몬이 /api/vision/spool에 올린 파일을 list→file→분석→screen.analyzed→delete 로 한 건씩 비운다.
// 스풀은 app/windowTitle 메타를 실어오므로 라우터(핵심=Sonnet)가 정상 작동한다(로컬 모드와 차이).
const SPOOL_BATCH_N = parseInt(process.env.VISION_SPOOL_BATCH) || 30;
let _spoolBusy = false;
function _spoolReq(method, pathQ, timeout) {
  return new Promise(resolve => {
    const url = new URL(pathQ, ORBIT_SERVER);
    const mod = url.protocol === 'https:' ? https : http;
    const h = {}; if (ORBIT_TOKEN) h['Authorization'] = 'Bearer ' + ORBIT_TOKEN;
    const req = mod.request({ hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method, headers: h, timeout: timeout || 15000 },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null)); req.end();
  });
}
async function processSpool() {
  if (_spoolBusy) return 0;
  try {
    const q = await require('../src/quota-guard').checkQuota(30);
    if (q.pause) { console.log('[vision-spool][quota]', q.reason); return 0; }
  } catch {}
  _spoolBusy = true;
  try {
    const list = await _spoolReq('GET', `/api/vision/spool/list?n=${SPOOL_BATCH_N}`);
    const batch = (list && list.batch) || [];
    if (!batch.length) { console.log(`[vision-spool] 신규 없음 (대기 ${list ? list.pending : '?'})`); return 0; }
    console.log(`[vision-spool] 대상 ${batch.length}건 (전체 대기 ${list.pending})`);
    let done = 0;
    for (const it of batch) {
      try {
        const full = await _spoolReq('GET', `/api/vision/spool/file?user=${encodeURIComponent(it.userId)}&file=${encodeURIComponent(it.file)}`);
        if (!full || !full.imageBase64) { // 못 읽으면 삭제해 무한루프 방지
          await _spoolReq('DELETE', `/api/vision/spool/file?user=${encodeURIComponent(it.userId)}&file=${encodeURIComponent(it.file)}`); continue;
        }
        console.log(`[vision-spool] ${full.hostname}/${full.app}: ${(full.windowTitle || '').slice(0, 40)}`);
        // [E1] 직전과 시각적으로 같은 화면이면 분석 스킵 + 스풀에서 삭제(드레인)
        if (_isDupFrame(full.imageBase64, `${it.userId}|${full.app || ''}`)) {
          console.log(`  ⇢ 중복화면 스킵(E1): ${it.file}`);
          await _spoolReq('DELETE', `/api/vision/spool/file?user=${encodeURIComponent(it.userId)}&file=${encodeURIComponent(it.file)}`);
          continue;
        }
        const result = await visionAnalyze(full.imageBase64, {
          hostname: full.hostname, name: full.app || 'capture', windowTitle: full.windowTitle || '', trigger: full.trigger,
          recentClicks: full.recentClicks,  // [골:실행좌표 융합/A3] 서버가 붙인 캡처 직전 클릭 → clickXY 특정
        });
        if (!result) { console.warn(`  ✗ 분석 실패 — 다음 폴 재시도: ${it.file}`); continue; } // 삭제 안 함(재시도)
        console.log(`  → ${result.app || '?'}: ${(result.activity || '').substring(0, 50)}`);
        const payload = JSON.stringify({ events: [{
          id: `vision-spool-${it.userId}-${it.file.replace(/\.json$/, '')}`, type: 'screen.analyzed', source: 'vision-spool-worker',
          sessionId: `spool-${full.hostname || it.userId}-${Math.floor(new Date(full.ts || Date.now()).getTime() / 1800000)}`,
          userId: full.userId || it.userId, timestamp: full.ts || new Date().toISOString(),
          data: { hostname: full.hostname, originalCaptureId: it.file, trigger: full.trigger, ...result,
            app: result.app || full.app || '', thumbnail: _makeThumb(full.imageBase64) },
        }] });
        const ok = await new Promise(resolve => {
          const sUrl = new URL('/api/hook', ORBIT_SERVER); const sMod = sUrl.protocol === 'https:' ? https : http;
          const sh = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
          if (ORBIT_TOKEN) sh['Authorization'] = 'Bearer ' + ORBIT_TOKEN;
          const sr = sMod.request({ hostname: sUrl.hostname, port: sUrl.port || 443, path: sUrl.pathname, method: 'POST', headers: sh, timeout: 10000 },
            r => { r.resume(); resolve(r.statusCode < 300); });
          sr.on('error', () => resolve(false)); sr.write(payload); sr.end();
        });
        if (ok) { await _spoolReq('DELETE', `/api/vision/spool/file?user=${encodeURIComponent(it.userId)}&file=${encodeURIComponent(it.file)}`); done++; } // 전송 성공분만 스풀에서 삭제
        await new Promise(r => setTimeout(r, 2000)); // CLI 쿨다운
      } catch (e) { console.warn(`  분석 실패: ${e.message}`); }
    }
    console.log(`[vision-spool] 처리 ${done}건 전송·삭제`);
    return done;
  } catch (e) { console.error('[vision-spool] 에러:', e.message); return 0; }
  finally { _spoolBusy = false; }
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
const LOCAL_MODE = process.argv.includes('--local');
const SPOOL_MODE = process.argv.includes('--spool');
const SERVER_QUEUE_MODE = process.argv.includes('--server-queue') || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
// 2026-07-08: 1시간/10건이 유입량(실측 331건/h)의 3%만 처리해 저활동 직원 캡처가 서버 큐에서
// 상시 밀려나던 병목의 절반 원인(나머지 절반은 서버측 사용자별 라운드로빈으로 해결) — 10분/24건으로 상향.
const SERVER_QUEUE_POLL_MS = parseInt(process.env.VISION_POLL_MS) || 10 * 60 * 1000;
const QUEUE_BATCH_N = parseInt(process.env.VISION_BATCH_N) || 24;

async function main() {
  console.log('[vision-worker] Claude Vision 분석 워커');
  if (!ANTHROPIC_KEY && !CLAUDE_CLI) {
    console.error('Claude CLI 또는 ANTHROPIC_API_KEY 필요');
    console.error('  방법 1: Claude Max 구독 → claude 명령어 설치');
    console.error('  방법 2: ANTHROPIC_API_KEY=sk-xxx node bin/vision-worker.js');
    process.exit(1);
  }
  console.log(`  모드: ${USE_CLI ? 'Claude CLI (Max 구독)' : 'API 키'}`);
  console.log(`  소스: ${SPOOL_MODE ? '스풀 (전 직원 백로그 /api/vision/spool)' : LOCAL_MODE ? '로컬 폴더 (' + LOCAL_DIR + ')' : SERVER_QUEUE_MODE ? '서버 큐 (/api/vision/queue)' : 'Google Drive'}`);
  if (CLAUDE_CLI) console.log(`  CLI: ${CLAUDE_CLI}`);
  console.log(`  서버: ${ORBIT_SERVER}`);
  console.log(`  폴링: ${(SERVER_QUEUE_MODE ? SERVER_QUEUE_POLL_MS / 1000 : POLL_INTERVAL / 1000)}초`);

  if (SPOOL_MODE) {
    // 스풀 모드: 서버 볼륨에 모인 전 직원 백로그를 무과금 CLI로 소진(라우터 정상 작동)
    console.log(`  스풀 배치 ${SPOOL_BATCH_N} · 라우터 ${ROUTER_ON ? 'ON(핵심=Sonnet)' : 'OFF'}`);
    const first = await processSpool();
    console.log(`[vision-spool] 첫 배치: ${first}건`);
    if (process.argv.includes('--once')) { process.exit(0); }
    setInterval(processSpool, SERVER_QUEUE_POLL_MS);
  } else if (LOCAL_MODE) {
    // 로컬 폴더 모드: PNG 백로그 소급 분석 (무과금 CLI). 사용자 ID 없으면 결과 귀속 불가.
    if (!LOCAL_USER) console.warn('  ⚠ userId 없음(.orbit-config.json) — 분석결과 귀속 안 됨');
    console.log(`  로컬유저: ${LOCAL_USER || '(없음)'} · 배치 ${LOCAL_BATCH} · 모델 ${LOCAL_FORCE_MODEL || '라우터(메타없어 Haiku)'}`);
    const first = await processLocalDir();
    console.log(`[vision-local] 첫 배치: ${first}건`);
    if (process.argv.includes('--once')) { process.exit(0); }
    setInterval(processLocalDir, SERVER_QUEUE_POLL_MS);
  } else if (SERVER_QUEUE_MODE) {
    // 서버 큐 모드: SERVER_QUEUE_POLL_MS마다 서버에서 이미지 가져와 CLI 분석
    const first = await processServerQueue();
    console.log(`[vision] 첫 배치: ${first}건`);
    if (process.argv.includes('--once')) { process.exit(0); }
    setInterval(processServerQueue, SERVER_QUEUE_POLL_MS);
  } else {
    // Google Drive 모드
    if (!(await loadGoogleConfig())) { console.error('Google Drive 설정 실패'); process.exit(1); }
    console.log(`  폴더: ${_gFolder}`);
    const first = await processBatch();
    console.log(`[vision] 첫 배치: ${first}건`);
    if (process.argv.includes('--once')) { process.exit(0); }
    setInterval(processBatch, POLL_INTERVAL);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
