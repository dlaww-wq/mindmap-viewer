#!/usr/bin/env node
// ocr-triage-measure.js — 로컬 캡처에 OCR+분류만 돌려 "Vision vs OCR 분기 비율"을 실측.
// Claude 미호출 = $0·quota無. 파일럿 검증용(오분류 육안 확인 + 절감률 추정).
// 사용: node scripts/ocr-triage-measure.js [N=20] [capturesDir]
const fs = require('fs');
const os = require('os');
const path = require('path');
const triage = require('../src/ocr-triage');

const N = parseInt(process.argv[2]) || 20;
const DIR = process.argv[3] || path.join(os.homedir(), '.orbit', 'captures');

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.png'))
  .map(f => ({ f, t: fs.statSync(path.join(DIR, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t).slice(0, N);

console.log(`대상: ${files.length}건 (최신순, ${DIR})\n`);
let vision = 0, ocr = 0;
const rows = [];
for (const { f } of files) {
  const b64 = fs.readFileSync(path.join(DIR, f)).toString('base64');
  // 파일명 트리거에서 대략적 앱/컨텍스트 추정은 불가 → ctx는 최소(app 미상). OCR 본문이 주 신호.
  const ocrRes = triage.ocrExtract(b64);
  const dec = triage.classify({ name: '', windowTitle: '', recentClicks: [] }, ocrRes);
  if (dec.route === 'vision') vision++; else ocr++;
  rows.push({ f: f.slice(0, 42), route: dec.route, reason: dec.reason, words: ocrRes.wordCount,
              peek: (ocrRes.text || '').replace(/\s+/g, ' ').slice(0, 60) });
}

for (const r of rows) {
  const tag = r.route === 'ocr' ? 'OCR ' : 'VIS ';
  console.log(`${tag}| ${r.reason.padEnd(20)} | ${String(r.words).padStart(4)}w | ${r.peek}`);
}
const tot = vision + ocr || 1;
console.log(`\n── 결과 ──`);
console.log(`VISION(Claude 필요): ${vision}건 (${(100 * vision / tot).toFixed(1)}%)`);
console.log(`OCR-only($0)       : ${ocr}건 (${(100 * ocr / tot).toFixed(1)}%)  ← 이만큼 quota 절감`);
console.log(`\n※ ctx(앱/클릭)가 없는 로컬 백로그 기준이라 실제 서버큐(앱·클릭 메타 있음)에선 VISION 비율이 더 정확/보수적으로 나옵니다.`);
