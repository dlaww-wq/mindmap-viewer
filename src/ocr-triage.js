// =============================================================================
// ocr-triage.js — 캡처를 "무료 로컬 OCR로 충분" vs "Claude Vision 필요"로 분류.
// 목적: Claude 부르기 전 값싼 신호로 판정 → 읽기/유휴/비업무는 OCR($0·quota無),
//       ERP입력·상호작용 핵심작업만 Vision. 보수적(애매하면 Vision).
//
// 모드(env VISION_OCR_TRIAGE):
//   off(기본)  아무것도 안 함(기존 동작 100% 보존).
//   shadow     분류·집계·로그만. Claude는 그대로 호출 → 데이터 손실 0으로 오분류·절감률 실측.
//   on         OCR판정건은 Claude 스킵(호출측이 screen.ocr로 텍스트 보존).
//
// Windows 내장 OCR(Windows.Media.Ocr) 사용 — 설치 불필요, 한국어 언어팩 있으면 한글 인식.
// WinRT 프로젝션은 powershell.exe(5.1)에서만 안정 → pwsh(7) 쓰지 말 것.
// =============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OCR_PS1 = path.join(__dirname, '..', 'setup', 'ocr-extract.ps1');

// 핵심(고가치) 화면 키워드 — worker의 VISION_HIGH_VALUE_RE와 동일 기본값(환경변수로 통일 오버라이드).
const HIGH_VALUE_RE = new RegExp(process.env.VISION_HIGH_VALUE_RE ||
  'nenova|ecount|이카운트|화훼|주문|출고|발주|견적|재고|erp|excel|엑셀|정산|채권|채무|무역|통관|검수|분배|kakao|카카오|카톡|sheets|docs|스프레드시트|구글시트|송장|배송|운송|택배|invoice|인보이스|명세|청구|입금|출금|송금|결제|매출|매입|카네이션|carnation|화환|장미|거래처|납품|수주',
  'i');
// 데이터 입력/처리 정황(OCR 본문에서) — 있으면 Vision.
const ENTRY_RE = /수량|단가|금액|합계|공급가|부가세|품목|규격|납기|거래처|계정과목|전표|등록|저장|수정|삭제|입력/i;

function mode() {
  const m = (process.env.VISION_OCR_TRIAGE || 'off').toLowerCase();
  return (m === 'shadow' || m === 'on') ? m : 'off';
}

// base64 PNG → { ok, text, wordCount }. 실패/불가 시 ok:false(호출측은 Vision으로 승격).
function ocrExtract(base64) {
  let tmp = null;
  try {
    if (!base64 || base64.length < 2000) return { ok: false, text: '', wordCount: 0 };
    tmp = path.join(os.tmpdir(), `ocr-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
    fs.writeFileSync(tmp, Buffer.from(base64, 'base64'));
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OCR_PS1, '-Path', tmp],
      { timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }
    ).toString('utf8');
    const text = (out || '').trim();
    const wordCount = text ? (text.split(/\s+/).filter(Boolean).length) : 0;
    return { ok: text.length > 0, text, wordCount };
  } catch {
    return { ok: false, text: '', wordCount: 0 };
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
  }
}

// 보수적 분류: 기본은 Vision. 명백한 읽기/유휴/비업무일 때만 OCR.
// 반환 { route: 'vision'|'ocr', reason }
function classify(ctx, ocr) {
  ctx = ctx || {};
  if (!ocr || !ocr.ok) return { route: 'vision', reason: 'ocr-unavailable' };  // OCR 불가 → 안전 승격
  const hay = [ctx.name, ctx.windowTitle, ocr.text].filter(Boolean).join(' ');
  if (HIGH_VALUE_RE.test(hay)) return { route: 'vision', reason: 'high-value-keyword' };
  if (Array.isArray(ctx.recentClicks) && ctx.recentClicks.length) return { route: 'vision', reason: 'interactive-clicks' };
  if (ENTRY_RE.test(ocr.text)) return { route: 'vision', reason: 'entry-pattern' };
  // 숫자 밀도 높음(단가/수량/금액 화면 가능성) → 안전하게 Vision.
  const numRuns = (ocr.text.match(/\d{2,}/g) || []).length;
  if (numRuns >= 12) return { route: 'vision', reason: 'numeric-dense' };
  return { route: 'ocr', reason: 'reading/idle-nonwork' };
}

// ── 집계 & 리포트(파일럿 실측용) ──────────────────────────────────────────────
const REPORT_PATH = path.join(os.homedir(), '.orbit', 'ocr-triage-report.json');
const _stats = { since: new Date().toISOString(), total: 0, vision: 0, ocr: 0, byReason: {}, byApp: {} };
let _sinceWrite = 0;

function tally(dec, ctx) {
  _stats.total++;
  _stats[dec.route]++;
  _stats.byReason[dec.reason] = (_stats.byReason[dec.reason] || 0) + 1;
  const app = String((ctx && ctx.name) || '기타').replace(/\s*[\(\-–].*/, '').trim() || '기타';
  _stats.byApp[app] = _stats.byApp[app] || { vision: 0, ocr: 0 };
  _stats.byApp[app][dec.route]++;
  if (++_sinceWrite >= 10) { _sinceWrite = 0; writeReport(); }
}

function summary() {
  const t = _stats.total || 1;
  return { ...(_stats), ocrShare: +(100 * _stats.ocr / t).toFixed(1), visionShare: +(100 * _stats.vision / t).toFixed(1) };
}

function writeReport() {
  try {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify(summary(), null, 2));
  } catch {}
}

module.exports = { mode, ocrExtract, classify, tally, summary, writeReport, REPORT_PATH };
