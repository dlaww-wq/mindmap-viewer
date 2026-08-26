#!/usr/bin/env node
/**
 * shadow-predictor.js — 상시 섀도우 예측기 (골 파이프라인 검증 축적기)
 *
 * task-session을 정답으로 놓고, 앞 스텝만 보고 "다음 스텝"을 블라인드 예측한 뒤
 * 실제와 5차원 채점해 서버 shadow_scores에 적재한다. 개인×부류별 표본이 n≥30 쌓이면
 * /api/verification/gate 가 무인 라우팅을 자동 판정한다.
 *
 * 무과금: Claude CLI(Max 구독, API키 불필요). quota-guard로 사용자 몫 보전.
 * 실행:  node bin/shadow-predictor.js --once            (1배치)
 *        node bin/shadow-predictor.js                    (루프, 폴링)
 *   env: ORBIT_TOKEN(admin), ORBIT_SERVER_URL, SHADOW_USERIDS(콤마), SHADOW_MAX(배치 상한)
 */
const https = require('https'), http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFile, execSync } = require('child_process');

const ORBIT_SERVER = process.env.ORBIT_SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app';
const ORBIT_TOKEN = process.env.ORBIT_TOKEN || (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8')).token || ''; } catch { return ''; } })();
const CLAUDE_CLI = (() => { try { return execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { timeout: 3000 }).toString().trim().split(/\r?\n/)[0]; } catch { return 'claude'; } })();
const MODEL = process.env.SHADOW_CLI_MODEL || 'sonnet';
// 예측 모델 분리: 평소 sonnet(저비용 상시), 초정밀 필요시(승격 임계 근접·고위험 스텝) opus로.
//   확인 실행:  SHADOW_MODEL_PRED=opus node bin/shadow-predictor.js --once
const MODEL_PRED = process.env.SHADOW_MODEL_PRED || MODEL;
const MAX = parseInt(process.env.SHADOW_MAX) || 16;         // 배치당 예측점 상한
const HOURS = parseInt(process.env.SHADOW_HOURS) || 96;
const POLL_MS = parseInt(process.env.SHADOW_POLL_MS) || 6 * 60 * 60 * 1000; // 6h
// 4인 기본(강명훈·설연주·박성수·조현욱). env로 교체 가능.
const USERIDS = (process.env.SHADOW_USERIDS || 'MNMSAQJD78E544A631,MNIAFICB3DC88DCB34,MN9B6750A0A37D561D,MN506C7A6A710A046E').split(',').map(s => s.trim()).filter(Boolean);
const NAME = { MNMSAQJD78E544A631: '강명훈', MNIAFICB3DC88DCB34: '설연주', MN9B6750A0A37D561D: '박성수', MN506C7A6A710A046E: '조현욱' };
const ROLE = {
  '강명훈': '재무/전산 — 금융·정산·재고 조회 + 엑셀 대사',
  '설연주': '영업지원 주문처리 — 카톡→nenova→Excel',
  '박성수': '카톡 다중방→주문입력 + 해외 인보이스',
  '조현욱': '화훼 발주 — 거래처별 색상 반복발주 + 출고',
};

const TMP = path.join(os.tmpdir(), 'orbit-shadow'); try { fs.mkdirSync(TMP, { recursive: true }); } catch {}

function apiGet(p) { return new Promise(r => { const u = new URL(p, ORBIT_SERVER); const mod = u.protocol === 'https:' ? https : http; const q = mod.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', headers: { Authorization: 'Bearer ' + ORBIT_TOKEN }, timeout: 40000 }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { r(JSON.parse(d)); } catch { r(null); } }); }); q.on('error', () => r(null)); q.on('timeout', () => { q.destroy(); r(null); }); q.end(); }); }
function apiPost(p, body) { return new Promise(r => { const u = new URL(p, ORBIT_SERVER); const mod = u.protocol === 'https:' ? https : http; const data = JSON.stringify(body); const q = mod.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST', headers: { Authorization: 'Bearer ' + ORBIT_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 40000 }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { r(JSON.parse(d)); } catch { r(null); } }); }); q.on('error', () => r(null)); q.on('timeout', () => { q.destroy(); r(null); }); q.write(data); q.end(); }); }

function cliOnce(prompt, model) {
  return new Promise(resolve => {
    execFile(CLAUDE_CLI, ['-p', prompt, '--model', model || MODEL], { timeout: 150000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = String(stdout).match(/```(?:json)?\s*([\s\S]*?)```/) || [null, String(stdout)];
      try { resolve(JSON.parse((m[1] || '').trim())); } catch { try { resolve(JSON.parse(String(stdout).slice(String(stdout).indexOf('{'), String(stdout).lastIndexOf('}') + 1))); } catch { resolve(null); } }
    });
  });
}
// 재시도 래퍼(CLI 단발 null 손실 방지). model 미지정 시 MODEL.
async function cli(prompt, model) { for (let i = 0; i < 2; i++) { const r = await cliOnce(prompt, model); if (r) return r; await new Promise(s => setTimeout(s, 800)); } return null; }
const minStep = s => ({ screen: s.screen, activity: (s.activity || '').slice(0, 160), app: s.app, nenovaAction: s.nenovaAction || null, gapSec: s.gapSec, clickFields: (s.clickFields || []).map(f => ({ name: f.name, clickXY: f.clickXY || null, value: f.value != null ? String(f.value).slice(0, 80) : null, source: f.source || null })) });
function localCategory(actual) {
  const hay = `${actual.activity || ''} ${actual.screen || ''} ${actual.nenovaAction || ''}`.toLowerCase();
  if (/저장|save|확정|커밋|등록완료/.test(hay)) return '저장';
  if (/금융|정산|매출전표|수금|대출|자금/.test(hay)) return '금융';
  if (/입력|수량|단가|주문등록|기입|type/.test(hay)) return '입력';
  if (/조회|열람|목록|검색|확인|읽|모니터/.test(hay)) return '조회';
  if (/전환|이동|navigate|주소창|새탭/.test(hay)) return '전환';
  return '기타';
}

async function predictAndScore(who, sessionKey, cutIdx, prefix, actual) {
  const roleHint = ROLE[who] ? `직원 역할: ${who} — ${ROLE[who]}.` : `직원: ${who}.`;
  const pred = await cli(`너는 직원의 다음 업무행동을 예측하는 모델이다. ${roleHint}
아래는 이 직원 작업 세션의 "앞 스텝들"(시간순)이다. 정답(다음 스텝)은 주어지지 않았다.
각 스텝 객체 필드 의미:
- screen: 화면/앱 이름, activity: 그 화면에서 한 행동 요약, app: 실행 앱
- nenovaAction: nenova ERP 액션(있으면), gapSec: 이전 스텝과의 시간간격(초)
- clickFields[]: 그 스텝에서 건드린 필드들 {name:필드명, clickXY:클릭좌표[x,y]또는null, value:입력/표시값, source:값출처}

앞스텝:
${JSON.stringify(prefix)}

이 직원이 "바로 다음에 할 단 하나의 스텝"을 앞 흐름의 업무 논리로만 추론해 예측하라.
정답을 막연히 찍지 말고, 앞 스텝의 흐름 근거로 특정하라(정답은 주어지지 않았다).
각 필드를 반드시 채워라:
- predScreen: 다음에 있을 화면/앱 (예: "nenova 주문등록", "Excel 출고시트", "카카오톡 OO방")
- predAction: 다음 동작 — 다음 중 하나만: read | click | input | navigate | select | save | verify | copy | paste
- predTarget: 대상 필드/버튼/요소를 구체적으로 (예: "수량 입력칸", "저장 버튼", "고객명 셀")
- predClickRegion: 클릭 위치 — 좌표 추정 "[x,y]" 또는 영역("좌상","상단중앙","중앙","우하" 등)
- predValue: 타이핑/입력/선택할 구체값 (없으면 "-")
- predSource: 값 출처 — 다음 중 하나만: kakao | erp | clipboard | manual | formula | none
- confidence: 0~1 (앞 흐름 근거가 강할수록 높게)

순수 JSON 객체 하나로만 출력(마크다운/설명/코드펜스 금지):
{"predScreen":"","predAction":"","predTarget":"","predClickRegion":"","predValue":"","predSource":"","confidence":0}`, MODEL_PRED);
  if (!pred) return null;
  const sc = await cli(`너는 예측 유사도 채점기다. 아래 "예측"과 "실제 다음 스텝"을 5차원으로 채점한다.

예측:
${JSON.stringify(pred)}

실제 다음 스텝(actual):
${JSON.stringify(actual)}

actual 필드 의미: screen=화면/앱, activity=행동요약, app=앱, nenovaAction=ERP액션, clickFields[]={name:필드명, clickXY:클릭좌표, value:값, source:출처}.

각 차원 0~1로 채점하라(0=완전 다름, 0.5=부분 일치/유사, 1=의미상 동일). 표면 문자열이 아니라 "의미"로 판정한다:
- screenMatch: 예측 화면/앱이 실제 screen·app과 같은 작업맥락인가 (같은 앱·같은 업무화면이면 높게)
- actionMatch: predAction이 실제로 한 동작 유형과 일치하는가 (input↔값입력, save↔저장, navigate↔화면전환 등 의미로 매칭)
- targetMatch: predTarget이 실제 clickFields의 name(대상 필드/버튼)과 일치하는가
- coordMatch: predClickRegion이 실제 위치에 근접한가 — 같은 필드·같은 영역이면 높게. actual에 clickXY가 있고 예측 좌표/영역이 근접하면 1. 좌표정보가 없으면 targetMatch(같은 필드 여부)로 대체 판정
- valueMatch: predValue가 실제 입력/표시 value와 의미상 일치하는가 (같은 수량·같은 고객명이면 표기가 달라도 높게)

overall = 가중평균 = 0.15*screenMatch + 0.20*actionMatch + 0.25*targetMatch + 0.15*coordMatch + 0.25*valueMatch.
(actual에 해당 정보가 아예 없어 채점 불가한 차원은 제외하고, 남은 차원의 가중치로 정규화하라.)

엄격하게: 화면만 맞고 대상필드·값이 틀리면 overall을 낮게 줘라. 근거 없이 후하게 주지 마라.
단, 의미가 같으면 문자열/좌표 표기가 달라도 깎지 마라(의미 채점이 원칙).
note에 "예측 X / 실제 Y" 형식 한 줄 비교.

순수 JSON 객체 하나로만 출력(마크다운/설명/코드펜스 금지):
{"screenMatch":0,"actionMatch":0,"targetMatch":0,"coordMatch":0,"valueMatch":0,"overall":0,"note":""}`);
  if (!sc) return null;
  return { sessionKey, cutIdx, who, category: localCategory(actual), screenMatch: sc.screenMatch, actionMatch: sc.actionMatch, targetMatch: sc.targetMatch, coordMatch: sc.coordMatch, valueMatch: sc.valueMatch, overall: sc.overall, note: (sc.note || '').slice(0, 300), source: 'shadow-predictor-v2' + (MODEL_PRED !== MODEL ? '-' + MODEL_PRED : '') };
}

async function runBatch() {
  try { const q = await require('../src/quota-guard').checkQuota(30); if (q.pause) { console.log('[shadow][quota]', q.reason); return 0; } } catch {}
  // 예측점 수집(직원별 리치세션의 cut 지점)
  const points = [];
  for (const uid of USERIDS) {
    const who = NAME[uid] || uid;
    const j = await apiGet(`/api/vision/task-sessions?userId=${uid}&hours=${HOURS}`);
    const sessions = (j && j.sessions || []).filter(s => s.stepCount >= 4);
    sessions.forEach((s, si) => {
      const N = s.steps.length;
      [...new Set([Math.floor(N * 0.5), Math.floor(N * 0.75), N - 1].filter(c => c >= 2 && c < N))].forEach(c => {
        points.push({ who, sessionKey: `${who}-s${si}`, cutIdx: c, prefix: s.steps.slice(0, c).map(minStep), actual: minStep(s.steps[c]) });
      });
    });
  }
  // 최신 우선 + 배치 상한
  const batch = points.slice(0, MAX);
  console.log(`[shadow] 예측점 ${points.length} 중 ${batch.length} 처리 (모델 ${MODEL})`);
  // 점마다 즉시 적재(중단돼도 부분진행 보존)
  let posted = 0;
  for (const p of batch) {
    const r = await predictAndScore(p.who, p.sessionKey, p.cutIdx, p.prefix, p.actual);
    if (r) {
      const res = await apiPost('/api/verification/scores', { scores: [r] });
      const ok = (res && res.inserted) || 0; posted += ok;
      console.log(`  ${p.who} ${p.sessionKey}#${p.cutIdx} [${r.category}] overall ${Number(r.overall).toFixed(2)} → 적재 ${ok}`);
    } else {
      console.log(`  ${p.who} ${p.sessionKey}#${p.cutIdx} — 예측/채점 실패(스킵)`);
    }
    await new Promise(r2 => setTimeout(r2, 1500));
  }
  console.log(`[shadow] 배치 완료 · 적재 ${posted}건`);
  return posted;
}

(async () => {
  if (!ORBIT_TOKEN) { console.error('ORBIT_TOKEN 필요(admin)'); process.exit(1); }
  console.log(`[shadow-predictor] 서버 ${ORBIT_SERVER} · 대상 ${USERIDS.length}인 · 배치상한 ${MAX} · 예측모델 ${MODEL_PRED}/채점 ${MODEL}`);
  const once = process.argv.includes('--once');
  await runBatch();
  if (once) { process.exit(0); }
  setInterval(runBatch, POLL_MS);
})();
