'use strict';
/**
 * verification.js — 섀도우 예측 검증율 게이트 (골 파이프라인)
 *
 * 섀도우 예측기(bin/shadow-predictor.js)가 "앞스텝만 보고 다음스텝 블라인드 예측 →
 * 실제와 5차원 채점"한 점수를 shadow_scores에 적재하고, 이 라우터가 (직원×부류)별
 * 롤링 검증율·신뢰구간을 계산해 "무인 라우팅 승인 vs 사람 승인" 게이트를 판정한다.
 *
 * 핵심 원칙(사용자 통찰): 예측 vs 실제 유사도 = 무인화 자격. 임계를 CI 하한으로 판정.
 *   - 화면·동작(라우팅)=무인 가능층 / 좌표·값(주입)=사람 승인층.
 *   - 저장·금융·확정 등 되돌리기 큰 커밋은 검증율 무관 영구 사람 게이트.
 *
 * 엔드포인트:
 *   POST /api/verification/scores  — 채점 점수 적재 (admin). body:{scores:[...]}
 *   GET  /api/verification/gate     — 직원×부류 게이트 판정 (admin)
 *   GET  /api/verification/scores   — 원점수/요약 (admin)
 */
const express = require('express');

// ── 게이트 임계 (튜닝 가능) ──────────────────────────────────────────────────
const MIN_N = 30;        // 부류별 무인 승격에 필요한 최소 표본
const ROUTE_TH = 0.80;   // 무인 라우팅 승인 임계(overall CI 하한이 이 이상)
const VALUE_GATE = 0.75; // 값 차원이 이 미만이면 금액·수량 주입은 무조건 사람 승인
const COORD_GATE = 0.80; // 좌표 차원이 이 미만이면 절대좌표 실행 금지(앵커 필요)
// 검증율과 무관하게 영구 사람 게이트인 부류(되돌리기 큰 커밋)
const NEVER_AUTO = new Set(['저장', 'save', '금융', '정산', '매출전표', '수금', '출고확정', '재고차감', '주문확정']);
// 부작용 없는 무인 라우팅 후보 부류(조회/전환)
const AUTO_ROUTE_KIND = new Set(['조회', 'read', '전환', 'navigate', '검색']);

function createVerificationRouter({ getDb, isAdminReq }) {
  const router = express.Router();
  let _ready = false;
  async function ensureTable(db) {
    if (_ready || !db || !db.query) return;
    await db.query(`
      CREATE TABLE IF NOT EXISTS shadow_scores (
        id SERIAL PRIMARY KEY,
        session_key TEXT, cut_idx INT, who TEXT, category TEXT,
        screen_match REAL, action_match REAL, target_match REAL,
        coord_match REAL, value_match REAL, overall REAL,
        note TEXT, source TEXT DEFAULT 'shadow-predictor',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_ss_who_cat ON shadow_scores(who, category)`);
    _ready = true;
  }
  const admin = async (req, res) => { if (!(await isAdminReq(req))) { res.status(403).json({ error: 'admin only' }); return false; } return true; };
  const num = (v) => (v == null ? null : Number(v));
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };

  // 부류 정규화(입력값이 다양해도 게이트 부류로 매핑)
  function normCat(c) {
    const s = String(c || '').toLowerCase();
    if (/저장|save|확정|커밋/.test(s)) return '저장';
    if (/금융|정산|매출전표|수금|대출|자금/.test(s)) return '금융';
    if (/조회|read|열람|목록|검색/.test(s)) return '조회';
    if (/전환|navigate|앱전환|이동/.test(s)) return '전환';
    if (/입력|input|type|수량|단가|주문등록/.test(s)) return '입력';
    return c || '기타';
  }

  // POST /scores — 채점 점수 적재
  router.post('/scores', async (req, res) => {
    if (!(await admin(req, res))) return;
    try {
      const db = getDb(); if (!db || !db.query) return res.status(503).json({ error: 'db unavailable' });
      await ensureTable(db);
      const scores = Array.isArray(req.body?.scores) ? req.body.scores : [];
      if (!scores.length) return res.status(400).json({ error: 'scores[] 필요' });
      let ins = 0;
      for (const s of scores) {
        await db.query(
          `INSERT INTO shadow_scores (session_key, cut_idx, who, category, screen_match, action_match, target_match, coord_match, value_match, overall, note, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [s.sessionKey || null, s.cutIdx ?? null, s.who || null, normCat(s.category),
           num(s.screenMatch), num(s.actionMatch), num(s.targetMatch), num(s.coordMatch), num(s.valueMatch), num(s.overall),
           (s.note || '').slice(0, 300), s.source || 'shadow-predictor']);
        ins++;
      }
      res.json({ ok: true, inserted: ins });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /gate — 직원×부류 게이트 판정
  router.get('/gate', async (req, res) => {
    if (!(await admin(req, res))) return;
    try {
      const db = getDb(); if (!db || !db.query) return res.status(503).json({ error: 'db unavailable' });
      await ensureTable(db);
      const whoFilter = req.query.who ? ' AND who = $1' : '';
      const params = req.query.who ? [req.query.who] : [];
      const { rows } = await db.query(
        `SELECT who, category, screen_match, action_match, target_match, coord_match, value_match, overall
         FROM shadow_scores WHERE overall IS NOT NULL${whoFilter}`, params);
      // (who, category) 그룹핑
      const grp = {};
      for (const r of rows) {
        const k = `${r.who}||${r.category}`;
        (grp[k] = grp[k] || []).push(r);
      }
      const gates = Object.entries(grp).map(([k, arr]) => {
        const [who, category] = k.split('||');
        const ov = arr.map(a => a.overall);
        const n = ov.length, m = mean(ov), s = sd(ov);
        const ciLower = n >= 2 ? Math.max(0, m - 1.96 * s / Math.sqrt(n)) : null;
        const dims = {
          screen: mean(arr.map(a => a.screen_match).filter(x => x != null)),
          action: mean(arr.map(a => a.action_match).filter(x => x != null)),
          target: mean(arr.map(a => a.target_match).filter(x => x != null)),
          coord: mean(arr.map(a => a.coord_match).filter(x => x != null)),
          value: mean(arr.map(a => a.value_match).filter(x => x != null)),
        };
        let decision, reason;
        if (NEVER_AUTO.has(category)) { decision = 'never-auto'; reason = '되돌리기 큰 커밋 — 검증율 무관 영구 사람 게이트'; }
        else if (n < MIN_N) {
          decision = (m >= ROUTE_TH) ? 'trending' : 'insufficient';
          reason = `표본 n=${n} < ${MIN_N}. ${decision === 'trending' ? '평균 높음(승격 유망) — 표본 더 필요' : '표본·평균 부족'}`;
        } else if (AUTO_ROUTE_KIND.has(category) && ciLower != null && ciLower >= ROUTE_TH) {
          decision = 'auto-route-cleared'; reason = `CI하한 ${ciLower.toFixed(2)} ≥ ${ROUTE_TH}, 부작용 없는 ${category} → 무인 라우팅 승인`;
        } else { decision = 'human-gate'; reason = `CI하한 ${ciLower != null ? ciLower.toFixed(2) : '-'} 또는 부류 성격상 사람 승인`; }
        // 값·좌표 서브게이트(항상 첨부)
        const subGates = [];
        if (dims.value < VALUE_GATE) subGates.push(`값 ${dims.value.toFixed(2)}<${VALUE_GATE} → 금액·수량 주입은 사람 승인 필수`);
        if (dims.coord < COORD_GATE) subGates.push(`좌표 ${dims.coord.toFixed(2)}<${COORD_GATE} → 절대좌표 실행 금지(앵커 필요)`);
        return { who, category, n, meanOverall: +m.toFixed(3), ciLower: ciLower != null ? +ciLower.toFixed(3) : null, dims: Object.fromEntries(Object.entries(dims).map(([kk, vv]) => [kk, +vv.toFixed(3)])), decision, reason, subGates };
      }).sort((a, b) => (b.decision === 'auto-route-cleared') - (a.decision === 'auto-route-cleared') || b.meanOverall - a.meanOverall);
      const summary = {
        total: rows.length, groups: gates.length,
        cleared: gates.filter(g => g.decision === 'auto-route-cleared').length,
        trending: gates.filter(g => g.decision === 'trending').length,
        thresholds: { MIN_N, ROUTE_TH, VALUE_GATE, COORD_GATE },
      };
      res.json({ ok: true, summary, gates });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /scores — 요약
  router.get('/scores', async (req, res) => {
    if (!(await admin(req, res))) return;
    try {
      const db = getDb(); if (!db || !db.query) return res.status(503).json({ error: 'db unavailable' });
      await ensureTable(db);
      const { rows } = await db.query(`SELECT who, category, COUNT(*) n, ROUND(AVG(overall)::numeric,3) avg_overall FROM shadow_scores GROUP BY who, category ORDER BY n DESC`);
      const { rows: tot } = await db.query(`SELECT COUNT(*) n FROM shadow_scores`);
      res.json({ ok: true, total: Number(tot[0]?.n || 0), byGroup: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
createVerificationRouter.ensureTable = async function (db) {
  if (!db || !db.query) return;
  await db.query(`CREATE TABLE IF NOT EXISTS shadow_scores (id SERIAL PRIMARY KEY, session_key TEXT, cut_idx INT, who TEXT, category TEXT, screen_match REAL, action_match REAL, target_match REAL, coord_match REAL, value_match REAL, overall REAL, note TEXT, source TEXT DEFAULT 'shadow-predictor', created_at TIMESTAMPTZ DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ss_who_cat ON shadow_scores(who, category)`);
};
module.exports = createVerificationRouter;
