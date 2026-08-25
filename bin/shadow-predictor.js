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
const MAX = parseInt(process.env.SHADOW_MAX) || 16;         // 배치당 예측점 상한
const HOURS = parseInt(process.env.SHADOW_HOURS) || 96;
const POLL_MS = parseInt(process.env.SHADOW_POLL_MS) || 6 * 60 * 60 * 1000; // 6h
// 4인 기본(강명훈·설연주·박성수·조현욱). env로 교체 가능.
const USERIDS = (process.env.SHADOW_USERIDS || 'MNMSAQJD78E544A631,MNIAFICB3DC88DCB34,MN9B6750A0A37D561D,MN506C7A6A710A046E').split(',').map(s => s.trim()).filter(Boolean);
const NAME = { MNMSAQJD78E544A631: '강명훈', MNIAFICB3DC88DCB34: '설연주', MN9B6750A0A37D561D: '박성수', MN506C7A6A710A046E: '조현욱' };

const TMP = path.join(os.tmpdir(), 'orbit-shadow'); try { fs.mkdirSync(TMP, { recursive: true }); } catch {}

function apiGet(p) { return new Promise(r => { const u = new URL(p, ORBIT_SERVER); const mod = u.protocol === 'https:' ? https : http; const q = mod.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', headers: { Authorization: 'Bearer ' + ORBIT_TOKEN }, timeout: 40000 }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { r(JSON.parse(d)); } catch { r(null); } }); }); q.on('error', () => r(null)); q.on('timeout', () => { q.destroy(); r(null); }); q.end(); }); }
function apiPost(p, body) { return new Promise(r => { const u = new URL(p, ORBIT_SERVER); const mod = u.protocol === 'https:' ? https : http; const data = JSON.stringify(body); const q = mod.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST', headers: { Authorization: 'Bearer ' + ORBIT_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 40000 }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { r(JSON.parse(d)); } catch { r(null); } }); }); q.on('error', () => r(null)); q.on('timeout', () => { q.destroy(); r(null); }); q.write(data); q.end(); }); }

function cli(prompt) {
  return new Promise(resolve => {
    execFile(CLAUDE_CLI, ['-p', prompt, '--model', MODEL], { timeout: 90000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = String(stdout).match(/```(?:json)?\s*([\s\S]*?)```/) || [null, String(stdout)];
      try { resolve(JSON.parse((m[1] || '').trim())); } catch { try { resolve(JSON.parse(String(stdout).slice(String(stdout).indexOf('{'), String(stdout).lastIndexOf('}') + 1))); } catch { resolve(null); } }
    });
  });
}
const minStep = s => ({ screen: s.screen, activity: (s.activity || '').slice(0, 80), app: s.app, nenovaAction: s.nenovaAction || null, gapSec: s.gapSec, clickFields: (s.clickFields || []).map(f => ({ name: f.name, clickXY: f.clickXY || null, value: f.value != null ? String(f.value).slice(0, 40) : null, source: f.source || null })) });
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
  const pred = await cli(`너는 직원 업무행동 예측 모델이다. 아래는 직원 "${who}"의 작업 세션 앞 스텝(시간순)이다. 다음 스텝(정답 미제공)을 앞 흐름 논리로만 예측하라.\n앞스텝:\n${JSON.stringify(prefix)}\n\n순수 JSON으로만: {"predScreen","predAction","predTarget","predClickRegion","predValue","predSource","confidence"}`);
  if (!pred) return null;
  const sc = await cli(`너는 예측 유사도 채점기다. 예측:\n${JSON.stringify(pred)}\n실제 다음 스텝:\n${JSON.stringify(actual)}\n\n5차원 0~1로 채점(엄격히). 순수 JSON으로만: {"screenMatch","actionMatch","targetMatch","coordMatch","valueMatch","overall","note"}`);
  if (!sc) return null;
  return { sessionKey, cutIdx, who, category: localCategory(actual), screenMatch: sc.screenMatch, actionMatch: sc.actionMatch, targetMatch: sc.targetMatch, coordMatch: sc.coordMatch, valueMatch: sc.valueMatch, overall: sc.overall, note: (sc.note || '').slice(0, 300), source: 'shadow-predictor' };
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
  const scores = [];
  for (const p of batch) {
    const r = await predictAndScore(p.who, p.sessionKey, p.cutIdx, p.prefix, p.actual);
    if (r) { scores.push(r); console.log(`  ${p.who} ${p.sessionKey}#${p.cutIdx} [${r.category}] overall ${Number(r.overall).toFixed(2)}`); }
    await new Promise(r2 => setTimeout(r2, 1500));
  }
  if (scores.length) { const res = await apiPost('/api/verification/scores', { scores }); console.log(`[shadow] 적재 ${res && res.inserted || 0}건`); }
  return scores.length;
}

(async () => {
  if (!ORBIT_TOKEN) { console.error('ORBIT_TOKEN 필요(admin)'); process.exit(1); }
  console.log(`[shadow-predictor] 서버 ${ORBIT_SERVER} · 대상 ${USERIDS.length}인 · 배치상한 ${MAX}`);
  const once = process.argv.includes('--once');
  await runBatch();
  if (once) { process.exit(0); }
  setInterval(runBatch, POLL_MS);
})();
