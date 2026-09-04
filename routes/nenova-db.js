'use strict';
/**
 * routes/nenova-db.js
 * ─────────────────────────────────────────────────────────────────────────────
 * nenova SQL Server 직접 연결 — 전산 데이터 실시간 조회 전용 (읽기만!)
 *
 * ⚠️ 절대 규칙: nenova SQL Server에는 SELECT만 실행한다.
 *   INSERT / UPDATE / DELETE / ALTER / DROP 절대 금지!
 *   기존 화훼관리 프로그램 DB에 문제가 생길 수 있음.
 *   쓰기 작업은 Orbit PostgreSQL에만 수행한다.
 *
 * nenova1_nenova 데이터베이스 (SQL Server 2016)에 읽기 전용 접속하여
 * 상품, 주문, 출하, 거래처, 재고, 견적, 매출 분석 API 제공
 *
 * 수량 체계: Box → Bunch → Steam (3단계)
 *   1 box ≈ 15~16 bunch, 1 bunch ≈ 10 stems
 *
 * 주차 체계:
 *   OrderWeek: "13-02" = 13주차 2차 주문
 *   ShipNo:    "202613" = 2026년 13주차
 *
 * 엔드포인트:
 *   # 대시보드
 *   GET  /api/nenova/dashboard          — 전체 현황 KPI
 *   GET  /api/nenova/dashboard/weekly   — 주차별 추이 (최근 8주)
 *
 *   # 상품
 *   GET  /api/nenova/products           — 상품 목록 (필터)
 *   GET  /api/nenova/products/stock     — 재고 현황
 *   GET  /api/nenova/products/:key      — 상품 상세
 *   GET  /api/nenova/flowers            — 꽃 종류
 *   GET  /api/nenova/countries          — 국가 목록
 *   GET  /api/nenova/farms              — 농장 목록
 *
 *   # 주문
 *   GET  /api/nenova/orders             — 주문 목록
 *   GET  /api/nenova/orders/pivot       — 피벗 테이블
 *   GET  /api/nenova/orders/summary     — 주문 요약
 *   GET  /api/nenova/orders/:key        — 주문 상세
 *
 *   # 출하
 *   GET  /api/nenova/shipments          — 출하 목록
 *   GET  /api/nenova/shipments/summary  — 출하 요약
 *   GET  /api/nenova/shipments/:key     — 출하 상세
 *
 *   # 거래처
 *   GET  /api/nenova/customers          — 거래처 목록
 *   GET  /api/nenova/customers/:key     — 거래처 상세
 *   GET  /api/nenova/customers/:key/products — 거래처별 품목 단가
 *
 *   # 견적
 *   GET  /api/nenova/estimates          — 견적 목록
 *   GET  /api/nenova/estimates/summary  — 견적 요약
 *
 *   # 분석
 *   GET  /api/nenova/analysis/sales     — 매출 분석
 *   GET  /api/nenova/analysis/trends    — 추이 분석
 *   GET  /api/nenova/analysis/ranking   — 순위 분석
 *
 *   # 동기화 (nenova → Orbit)
 *   POST /api/nenova/sync/products      — 상품 동기화
 *   POST /api/nenova/sync/customers     — 거래처 동기화
 *   POST /api/nenova/sync/orders        — 주문 동기화
 *   GET  /api/nenova/connection         — DB 연결 상태
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

// ═══════════════════════════════════════════════════════════════════════════
// SQL Server 연결 설정
// ═══════════════════════════════════════════════════════════════════════════

let sql;
try {
  sql = require('mssql');
} catch (e) {
  console.warn('[nenova-db] mssql 패키지 미설치 — npm install mssql 필요');
  sql = null;
}

const MSSQL_CONFIG = {
  server: 'sql16ssd-014.localnet.kr',
  port: 1433,
  database: 'nenova1_nenova',
  user: 'nenova1_nenova',
  password: process.env.NENOVA_DB_PASSWORD || '',
  options: {
    encrypt: false,
    trustServerCertificate: true,
    requestTimeout: 30000,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

// ── 커넥션 풀 싱글톤 ──
let _pool = null;
let _poolPromise = null;
let _lastError = null;

/**
 * SQL Server 쿼리 안전 검증 — SELECT만 허용
 * nenova DB에는 절대 쓰기 금지 (기존 전산 프로그램 보호)
 */
function validateReadOnly(query) {
  const normalized = query.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().toUpperCase();
  const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'EXEC', 'EXECUTE', 'MERGE'];
  for (const keyword of forbidden) {
    // 쿼리 시작이 금지 키워드인지 확인
    if (normalized.startsWith(keyword)) {
      throw new Error(`[보안] nenova DB에 ${keyword} 쿼리 실행 금지! 읽기 전용입니다.`);
    }
  }
}

/**
 * SQL Server 커넥션 풀 반환 (lazy init)
 */
async function getPool() {
  // mssql 패키지 없으면 에러
  if (!sql) throw new Error('mssql 패키지가 설치되지 않았습니다. npm install mssql');

  // 비밀번호 없으면 에러
  if (!process.env.NENOVA_DB_PASSWORD) {
    throw new Error('NENOVA_DB_PASSWORD 환경변수가 설정되지 않았습니다');
  }

  // 이미 연결된 풀이 있으면 반환
  if (_pool && _pool.connected) return _pool;

  // 동시 연결 시도 방지
  if (_poolPromise) return _poolPromise;

  _poolPromise = (async () => {
    try {
      _pool = await new sql.ConnectionPool(MSSQL_CONFIG).connect();
      _lastError = null;
      console.log('[nenova-db] SQL Server 연결 성공');

      // 연결 끊김 감지
      _pool.on('error', (err) => {
        console.error('[nenova-db] 풀 에러:', err.message);
        _lastError = err.message;
        _pool = null;
      });

      return _pool;
    } catch (err) {
      _lastError = err.message;
      _pool = null;
      throw err;
    } finally {
      _poolPromise = null;
    }
  })();

  return _poolPromise;
}

/**
 * 안전하게 쿼리 실행 — 읽기 전용 검증 + 실패 시 에러 반환
 * nenova SQL Server에는 SELECT만 허용 (기존 전산 프로그램 DB 보호)
 */
async function safeQuery(queryFn) {
  try {
    const pool = await getPool();
    // pool.request().query()를 래핑하여 쓰기 쿼리 차단
    const originalRequest = pool.request.bind(pool);
    const safePool = Object.create(pool);
    safePool.request = function() {
      const req = originalRequest();
      const originalQuery = req.query.bind(req);
      req.query = function(queryStr) {
        validateReadOnly(queryStr);
        return originalQuery(queryStr);
      };
      return req;
    };
    return await queryFn(safePool);
  } catch (err) {
    _lastError = err.message;
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 라우터 팩토리
// ═══════════════════════════════════════════════════════════════════════════

module.exports = function createNenovaDbRouter({ getDb }) {
  const router = express.Router();

  // sync 엔드포인트 인증 미들웨어 (관리자만)
  const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'dlaww584@gmail.com').split(',').map(s => s.trim().toLowerCase());
  router.use('/sync', (req, res, next) => {
    // ADMIN_SECRET 헤더로도 인증 허용 (CLI/자동화용)
    const adminSecret = process.env.ADMIN_SECRET;
    const secretHeader = req.headers['x-admin-secret'] || req.query.adminSecret;
    if (adminSecret && secretHeader === adminSecret) return next();

    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    try {
      const { verifyToken } = require('../src/auth');
      const user = verifyToken(token);
      if (!user || !ADMIN_EMAILS.includes((user.email || '').toLowerCase())) {
        return res.status(403).json({ error: 'admin only' });
      }
      next();
    } catch(e) {
      return res.status(401).json({ error: 'invalid token' });
    }
  });

  // ── 공통 에러 핸들러 ──
  function handleError(res, err, context) {
    console.error(`[nenova-db] ${context}:`, err.message);

    // 연결 관련 에러 구분
    if (err.message.includes('NENOVA_DB_PASSWORD') || err.message.includes('mssql')) {
      return res.status(503).json({
        ok: false,
        error: err.message,
        hint: 'nenova DB 연결 설정을 확인하세요',
      });
    }

    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }

  // ── 페이지네이션 헬퍼 ──
  function parsePagination(query) {
    const limit = Math.min(Math.max(parseInt(query.limit) || 50, 1), 500);
    const offset = Math.max(parseInt(query.offset) || 0, 0);
    return { limit, offset };
  }

  // ── 현재 연도/주차 계산 ──
  function getCurrentWeekInfo() {
    const now = new Date();
    const year = now.getFullYear();
    // ISO 주차 계산
    const startOfYear = new Date(year, 0, 1);
    const days = Math.floor((now - startOfYear) / 86400000);
    const week = Math.ceil((days + startOfYear.getDay() + 1) / 7);
    return { year, week };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                           연결 상태
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/nenova/connection — DB 연결 상태 확인
   */
  router.get('/connection', async (req, res) => {
    try {
      const pool = await getPool();
      const result = await pool.request().query('SELECT GETDATE() AS serverTime, @@VERSION AS version');
      const row = result.recordset[0];
      res.json({
        ok: true,
        connected: true,
        serverTime: row.serverTime,
        version: (row.version || '').split('\n')[0],
        pool: {
          size: pool.pool?.size || 0,
          available: pool.pool?.available || 0,
          pending: pool.pool?.pending || 0,
        },
      });
    } catch (err) {
      res.json({
        ok: false,
        connected: false,
        error: err.message,
        lastError: _lastError,
        config: {
          server: MSSQL_CONFIG.server,
          database: MSSQL_CONFIG.database,
          passwordSet: !!process.env.NENOVA_DB_PASSWORD,
          mssqlInstalled: !!sql,
        },
      });
    }
  });

  /**
   * GET /api/nenova/schema/:table — 테이블 컬럼 구조 조회
   */
  router.get('/schema/:table', async (req, res) => {
    try {
      const pool = await getPool();
      const table = req.params.table.replace(/[^a-zA-Z0-9_가-힣]/g, '');
      const result = await pool.request()
        .input('tableName', sql.NVarChar, table)
        .query(`SELECT c.name AS column_name, tp.name AS data_type, c.max_length, c.is_nullable
                FROM sys.columns c JOIN sys.types tp ON c.user_type_id = tp.user_type_id
                WHERE c.object_id = OBJECT_ID(@tableName) ORDER BY c.column_id`);
      res.json({ ok: true, table, columns: result.recordset });
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });

  /**
   * GET /api/nenova/tables — 전체 테이블 목록 (세션/로그인/사용자 활동 테이블 존재 여부 확인용)
   * 2026-07-04 added: 데몬 없이도 "직원이 어느 화면에 상주 중인지" 서버측 신호가 nenova ERP 자체에 있는지 확인
   */
  router.get('/tables', async (req, res) => {
    try {
      const pool = await getPool();
      const result = await pool.request()
        .query(`SELECT t.name AS table_name, p.rows AS row_count
                FROM sys.tables t
                JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0,1)
                ORDER BY t.name`);
      res.json({ ok: true, count: result.recordset.length, tables: result.recordset });
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                           대시보드
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/nenova/dashboard — 전체 현황 KPI
   * 주문/출하/재고/거래처 전체 개요
   */
  router.get('/dashboard', async (req, res) => {
    try {
      const result = await safeQuery(async (pool) => {
        const r = pool.request();

        // 병렬로 KPI 쿼리 실행
        const [orders, shipments, products, customers, recentOrders, recentShipments, byCountry, byFlower, weeklyOrders] = await Promise.all([
          r.query(`
            SELECT COUNT(*) AS totalOrders, COUNT(DISTINCT CustKey) AS orderCustomers, MAX(OrderDtm) AS lastOrderDate
            FROM OrderMaster WHERE ISNULL(isDeleted, 0) = 0
          `),
          pool.request().query(`
            SELECT COUNT(*) AS totalShipments, COUNT(DISTINCT CustKey) AS shipCustomers
            FROM ShipmentMaster WHERE ISNULL(isDeleted, 0) = 0
          `),
          pool.request().query(`SELECT COUNT(*) AS totalProducts FROM Product`),
          pool.request().query(`SELECT COUNT(*) AS totalCustomers FROM Customer`),
          pool.request().query(`
            SELECT TOP 5 om.OrderMasterKey AS OrderKey, CONVERT(varchar, om.OrderDtm, 23) AS OrderDate, om.OrderWeek,
              c.CustName AS CustomerName,
              (SELECT ISNULL(SUM(od.BoxQuantity),0) FROM OrderDetail od WHERE od.OrderMasterKey = om.OrderMasterKey AND ISNULL(od.isDeleted,0)=0) AS TotalBoxes
            FROM OrderMaster om LEFT JOIN Customer c ON om.CustKey = c.CustKey
            WHERE ISNULL(om.isDeleted, 0) = 0 ORDER BY om.CreateDtm DESC
          `),
          pool.request().query(`
            SELECT TOP 5 sm.ShipmentKey, sm.OrderWeek AS WeekNumber, c.CustName AS CustomerName,
              ISNULL(sm.isFix, 0) AS Confirmed
            FROM ShipmentMaster sm LEFT JOIN Customer c ON sm.CustKey = c.CustKey
            WHERE ISNULL(sm.isDeleted, 0) = 0 ORDER BY sm.CreateDtm DESC
          `),
          // 국가별 주문량
          pool.request().query(`
            SELECT TOP 10 p.CounName AS country, SUM(od.BoxQuantity) AS total
            FROM OrderDetail od
            JOIN Product p ON od.ProdKey = p.ProdKey
            JOIN OrderMaster om ON od.OrderMasterKey = om.OrderMasterKey
            WHERE ISNULL(om.isDeleted,0)=0 AND ISNULL(od.isDeleted,0)=0 AND om.OrderYear = '2026'
            GROUP BY p.CounName ORDER BY total DESC
          `),
          // 꽃 종류별 주문량
          pool.request().query(`
            SELECT TOP 8 p.FlowerName AS flower, SUM(od.BoxQuantity) AS total
            FROM OrderDetail od
            JOIN Product p ON od.ProdKey = p.ProdKey
            JOIN OrderMaster om ON od.OrderMasterKey = om.OrderMasterKey
            WHERE ISNULL(om.isDeleted,0)=0 AND ISNULL(od.isDeleted,0)=0 AND om.OrderYear = '2026'
            GROUP BY p.FlowerName ORDER BY total DESC
          `),
          // 이번주 주문 건수
          pool.request().query(`
            SELECT COUNT(*) AS cnt, MAX(om.OrderWeek) AS weekLabel
            FROM OrderMaster om
            WHERE ISNULL(om.isDeleted,0)=0 AND om.OrderYear = '2026'
              AND om.OrderWeek = (SELECT TOP 1 OrderWeek FROM OrderMaster WHERE OrderYear='2026' AND ISNULL(isDeleted,0)=0 ORDER BY CreateDtm DESC)
          `),
        ]);

        const wk = weeklyOrders.recordset[0] || {};
        return {
          totalProducts: products.recordset[0].totalProducts,
          totalCustomers: customers.recordset[0].totalCustomers,
          weeklyOrders: wk.cnt || 0,
          weeklyShipments: shipments.recordset[0].totalShipments,
          weekLabel: wk.weekLabel || '',
          totalOrders: orders.recordset[0].totalOrders,
          totalShipments: shipments.recordset[0].totalShipments,
          byCountry: byCountry.recordset,
          byFlower: byFlower.recordset,
          recentOrders: recentOrders.recordset,
          recentShipments: recentShipments.recordset,
        };
      });

      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(res, err, 'dashboard');
    }
  });

  /**
   * GET /api/nenova/dashboard/weekly — 주차별 추이 (최근 8주)
   * ?weeks=8 (기본 8주)
   */
  router.get('/dashboard/weekly', async (req, res) => {
    try {
      const weeks = Math.min(parseInt(req.query.weeks) || 8, 52);
      const { year } = getCurrentWeekInfo();

      const result = await safeQuery(async (pool) => {
        // 주차별 주문 집계
        const orderTrend = await pool.request()
          .input('year', sql.Int, year)
          .query(`
            SELECT
              om.OrderYear,
              LEFT(om.OrderWeek, CHARINDEX('-', om.OrderWeek + '-') - 1) AS WeekNo,
              COUNT(DISTINCT om.OrderMasterKey) AS orderCount,
              COUNT(DISTINCT om.CustKey) AS custCount,
              SUM(ISNULL(od.BoxQuantity, 0)) AS totalBox,
              SUM(ISNULL(od.BunchQuantity, 0)) AS totalBunch,
              SUM(ISNULL(od.SteamQuantity, 0)) AS totalSteam
            FROM OrderMaster om
            LEFT JOIN OrderDetail od ON om.OrderMasterKey = od.OrderMasterKey AND ISNULL(od.isDeleted, 0) = 0
            WHERE ISNULL(om.isDeleted, 0) = 0
              AND om.OrderYear = @year
            GROUP BY om.OrderYear, LEFT(om.OrderWeek, CHARINDEX('-', om.OrderWeek + '-') - 1)
            ORDER BY WeekNo DESC
            OFFSET 0 ROWS FETCH NEXT ${weeks} ROWS ONLY
          `);

        // 주차별 출하 집계
        const shipTrend = await pool.request()
          .input('year', sql.Int, year)
          .query(`
            SELECT
              sm.OrderYear,
              sm.OrderWeek,
              COUNT(DISTINCT sm.ShipmentKey) AS shipCount,
              COUNT(DISTINCT sm.CustKey) AS custCount,
              SUM(ISNULL(sd.BoxQuantity, 0)) AS totalBox,
              SUM(ISNULL(sd.BunchQuantity, 0)) AS totalBunch,
              SUM(ISNULL(sd.SteamQuantity, 0)) AS totalSteam,
              SUM(ISNULL(sd.Amount, 0)) AS totalAmount
            FROM ShipmentMaster sm
            LEFT JOIN ShipmentDetail sd ON sm.ShipmentKey = sd.ShipmentKey
            WHERE ISNULL(sm.isDeleted, 0) = 0
              AND sm.OrderYear = @year
            GROUP BY sm.OrderYear, sm.OrderWeek
            ORDER BY sm.OrderWeek DESC
            OFFSET 0 ROWS FETCH NEXT ${weeks} ROWS ONLY
          `);

        return {
          orderTrend: orderTrend.recordset,
          shipmentTrend: shipTrend.recordset,
        };
      });

      // 프론트엔드 기대: 배열 [{week, orders, shipments}]
      const merged = (result.orderTrend || []).map(o => ({
        week: parseInt(o.WeekNo) || 0,
        orders: o.orderCount || 0,
        shipments: 0,
        totalBox: o.totalBox || 0,
      }));
      // 출하 데이터 병합
      for (const s of (result.shipmentTrend || [])) {
        const wk = parseInt(s.WeekNo) || 0;
        const found = merged.find(m => m.week === wk);
        if (found) found.shipments = s.shipCount || 0;
        else merged.push({ week: wk, orders: 0, shipments: s.shipCount || 0, totalBox: 0 });
      }
      merged.sort((a, b) => a.week - b.week);
      res.json(merged);
    } catch (err) {
      handleError(res, err, 'dashboard/weekly');
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                           상품 (Products)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/nenova/products — 상품 목록
   * ?country=콜롬비아 &flower=카네이션 &search=keyword &limit=50 &offset=0
   */
  router.get('/products', async (req, res) => {
    try {
      // /products/stock 먼저 매칭 (Express 라우트 순서 이슈 방지)
      if (req.path === '/products/stock') return; // 아래 stock 라우터에서 처리

      const { country, flower, search } = req.query;
      const { limit, offset } = parsePagination(req.query);

      const result = await safeQuery(async (pool) => {
        const r = pool.request();
        let where = [];

        if (country) {
          r.input('country', sql.NVarChar, `%${country}%`);
          where.push('co.CounName LIKE @country');
        }
        if (flower) {
          r.input('flower', sql.NVarChar, `%${flower}%`);
          where.push('f.FlowerName LIKE @flower');
        }
        if (search) {
          r.input('search', sql.NVarChar, `%${search}%`);
          where.push('(p.ProdName LIKE @search OR p.FlowerName LIKE @search)');
        }

        const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

        // 총 건수
        const countResult = await r.query(`
          SELECT COUNT(*) AS total
          FROM Product p
          LEFT JOIN Flower f ON p.FlowerName = f.FlowerName
          LEFT JOIN Country co ON p.CounName = co.CounName
          ${whereClause}
        `);

        // 상품 목록 (새 request 생성 — input 재사용 불가)
        const r2 = pool.request();
        if (country) r2.input('country', sql.NVarChar, `%${country}%`);
        if (flower) r2.input('flower', sql.NVarChar, `%${flower}%`);
        if (search) r2.input('search', sql.NVarChar, `%${search}%`);

        const data = await r2.query(`
          SELECT
            p.ProdKey,
            p.ProdName,
            p.FlowerName,
            p.CounName,
            f.FlowerName AS flowerCategory,
            co.CounName AS countryName
          FROM Product p
          LEFT JOIN Flower f ON p.FlowerName = f.FlowerName
          LEFT JOIN Country co ON p.CounName = co.CounName
          ${whereClause}
          ORDER BY p.ProdName
          OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
        `);

        return {
          total: countResult.recordset[0].total,
          items: data.recordset,
        };
      });

      res.json({ ok: true, ...result, limit, offset });
    } catch (err) {
      handleError(res, err, 'products');
    }
  });

  /**
   * GET /api/nenova/products/stock — 재고 현황
   * ?low=true (부족 품목만)
   */
  router.get('/products/stock', async (req, res) => {
    try {
      const showLow = req.query.low === 'true';
      const { limit, offset } = parsePagination(req.query);

      const result = await safeQuery(async (pool) => {
        const r = pool.request();

        // ProductStock 테이블에서 재고 조회
        const data = await r.query(`
          SELECT
            ps.ProdKey,
            p.ProdName,
            p.FlowerName,
            p.CounName,
            ps.*
          FROM ProductStock ps
          JOIN Product p ON ps.ProdKey = p.ProdKey
          ORDER BY p.ProdName
          OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
        `);

        return {
          items: data.recordset,
          total: data.recordset.length,
        };
      });

      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(res, err, 'products/stock');
    }
  });

  /**
   * GET /api/nenova/products/:key — 상품 상세 + 재고 + 주문이력
   */
  router.get('/products/:key', async (req, res) => {
    try {
      const prodKey = parseInt(req.params.key);
      if (isNaN(prodKey)) return res.status(400).json({ ok: false, error: 'Invalid ProdKey' });

      const result = await safeQuery(async (pool) => {
        const [product, stock, orderHistory, sortInfo] = await Promise.all([
          // 상품 기본 정보
          pool.request()
            .input('prodKey', sql.Int, prodKey)
            .query(`
              SELECT p.*, co.CounName AS countryName
              FROM Product p
              LEFT JOIN Country co ON p.CounName = co.CounName
              WHERE p.ProdKey = @prodKey
            `),

          // 재고 정보
          pool.request()
            .input('prodKey', sql.Int, prodKey)
            .query(`
              SELECT * FROM ProductStock WHERE ProdKey = @prodKey
            `),

          // 최근 주문 이력 (최근 20건)
          pool.request()
            .input('prodKey', sql.Int, prodKey)
            .query(`
              SELECT TOP 20
                od.OrderDetailKey, od.BoxQuantity, od.BunchQuantity, od.SteamQuantity,
                od.OutQuantity, od.EstQuantity,
                om.OrderMasterKey, om.OrderDtm, om.OrderWeek, om.OrderYear, om.OrderCode,
                c.CustName
              FROM OrderDetail od
              JOIN OrderMaster om ON od.OrderMasterKey = om.OrderMasterKey
              LEFT JOIN Customer c ON om.CustKey = c.CustKey
              WHERE od.ProdKey = @prodKey
                AND ISNULL(od.isDeleted, 0) = 0
                AND ISNULL(om.isDeleted, 0) = 0
              ORDER BY om.CreateDtm DESC
            `),

          // 분류 정보
          pool.request()
            .input('prodKey', sql.Int, prodKey)
            .query(`
              SELECT * FROM ProductSort WHERE ProdKey = @prodKey
            `),
        ]);

        if (product.recordset.length === 0) {
          return null;
        }

        return {
          product: product.recordset[0],
          stock: stock.recordset[0] || null,
          recentOrders: orderHistory.recordset,
          sort: sortInfo.recordset[0] || null,
        };
      });

      if (!result) return res.status(404).json({ ok: false, error: '상품을 찾을 수 없습니다' });
      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(res, err, `products/${req.params.key}`);
    }
  });

  /**
   * GET /api/nenova/flowers — 꽃 종류 목록
   */
  router.get('/flowers', async (req, res) => {
    try {
      const result = await safeQuery(async (pool) => {
        const data = await pool.request().query(`
          SELECT f.*,
            (SELECT COUNT(*) FROM Product p WHERE p.FlowerName = f.FlowerName) AS productCount
          FROM Flower f
          ORDER BY f.FlowerName
        `);
        return data.recordset;
      });
      res.json({ ok: true, flowers: result });
    } catch (err) {
      handleError(res, err, 'flowers');
    }
  });

  /**
   * GET /api/nenova/countries — 국가 목록
   */
  router.get('/countries', async (req, res) => {
    try {
      const result = await safeQuery(async (pool) => {
        const data = await pool.request().query(`
          SELECT co.*,
            (SELECT COUNT(*) FROM Product p WHERE p.CounName = co.CounName) AS productCount
          FROM Country co
          ORDER BY co.CounName
        `);
        return data.recordset;
      });
      res.json({ ok: true, countries: result });
    } catch (err) {
      handleError(res, err, 'countries');
    }
  });

  /**
   * GET /api/nenova/farms — 농장 목록
   */
  router.get('/farms', async (req, res) => {
    try {
      const result = await safeQuery(async (pool) => {
        const data = await pool.request().query(`
          SELECT * FROM Farm ORDER BY FarmName
        `);
        return data.recordset;
      });
      res.json({ ok: true, farms: result });
    } catch (err) {
      handleError(res, err, 'farms');
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                           주문 (Orders)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/nenova/orders — 주문 목록
   * ?week=13-02 &year=2026 &custKey=520 &manager=임재용 &limit=50 &offset=0
   */
  router.get('/orders', async (req, res) => {
    try {
      const { week, year, custKey, manager } = req.query;
      const { limit, offset } = parsePagination(req.query);

      const result = await safeQuery(async (pool) => {
        const r = pool.request();
        let where = ['ISNULL(om.isDeleted, 0) = 0'];

        if (week) {
          r.input('week', sql.NVarChar, week);
          where.push('om.OrderWeek = @week');
        }
        if (year) {
          r.input('year', sql.Int, parseInt(year));
          where.push('om.OrderYear = @year');
        }
        if (custKey) {
          r.input('custKey', sql.Int, parseInt(custKey));
          where.push('om.CustKey = @custKey');
        }
        if (manager) {
          r.input('manager', sql.NVarChar, `%${manager}%`);
          where.push('om.Manager LIKE @manager');
        }

        const whereClause = 'WHERE ' + where.join(' AND ');

        // 총 건수
        const countResult = await r.query(`
          SELECT COUNT(*) AS total
          FROM OrderMaster om
          ${whereClause}
        `);

        // 주문 목록 (새 request)
        const r2 = pool.request();
        if (week) r2.input('week', sql.NVarChar, week);
        if (year) r2.input('year', sql.Int, parseInt(year));
        if (custKey) r2.input('custKey', sql.Int, parseInt(custKey));
        if (manager) r2.input('manager', sql.NVarChar, `%${manager}%`);

        const data = await r2.query(`
          SELECT
            om.OrderMasterKey,
            om.OrderDtm,
            om.OrderYear,
            om.OrderWeek,
            om.OrderCode,
            om.Manager,
            om.CustKey,
            om.CreateID,
            om.CreateDtm,
            om.LastUpdateDtm,
            c.CustName,
            (SELECT COUNT(*) FROM OrderDetail od WHERE od.OrderMasterKey = om.OrderMasterKey AND ISNULL(od.isDeleted, 0) = 0) AS detailCount,
            (SELECT SUM(ISNULL(od.BoxQuantity, 0)) FROM OrderDetail od WHERE od.OrderMasterKey = om.OrderMasterKey AND ISNULL(od.isDeleted, 0) = 0) AS totalBox,
            (SELECT SUM(ISNULL(od.BunchQuantity, 0)) FROM OrderDetail od WHERE od.OrderMasterKey = om.OrderMasterKey AND ISNULL(od.isDeleted, 0) = 0) AS totalBunch,
            (SELECT SUM(ISNULL(od.SteamQuantity, 0)) FROM OrderDetail od WHERE od.OrderMasterKey = om.OrderMasterKey AND ISNULL(od.isDeleted, 0) = 0) AS totalSteam
          FROM OrderMaster om
          LEFT JOIN Customer c ON om.CustKey = c.CustKey
          ${whereClause}
          ORDER BY om.CreateDtm DESC
          OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
        `);

        return {
          total: countResult.recordset[0].total,
          items: data.recordset,
        };
      });

      res.json({ ok: true, ...result, limit, offset });
    } catch (err) {
      handleError(res, err, 'orders');
    }
  });

  /**
   * GET /api/nenova/orders/pivot — 피벗 테이블 (국가×꽃×거래처 크로스탭)
   * ?year=2026 &week=13
   */
  router.get('/orders/pivot', async (req, res) => {
    try {
      const { year, week } = req.query;
      const targetYear = parseInt(year) || getCurrentWeekInfo().year;

      const result = await safeQuery(async (pool) => {
        const r = pool.request();
        r.input('year', sql.Int, targetYear);

        let weekFilter = '';
        if (week) {
          r.input('week', sql.NVarChar, `${week}%`);
          weekFilter = 'AND om.OrderWeek LIKE @week';
        }

        // 국가 × 꽃 × 거래처 크로스탭
        const pivot = await r.query(`
          SELECT
            p.CounName AS country,
            p.FlowerName AS flower,
            c.CustName AS customer,
            om.OrderWeek AS week,
            SUM(ISNULL(od.BoxQuantity, 0)) AS boxQty,
            SUM(ISNULL(od.BunchQuantity, 0)) AS bunchQty,
            SUM(ISNULL(od.SteamQuantity, 0)) AS steamQty,
            COUNT(DISTINCT od.OrderDetailKey) AS lineCount
          FROM OrderDetail od
          JOIN OrderMaster om ON od.OrderMasterKey = om.OrderMasterKey
          JOIN Product p ON od.ProdKey = p.ProdKey
          LEFT JOIN Customer c ON om.CustKey = c.CustKey
          WHERE ISNULL(od.isDeleted, 0) = 0
            AND ISNULL(om.isDeleted, 0) = 0
            AND om.OrderYear = @year
            ${weekFilter}
          GROUP BY p.CounName, p.FlowerName, c.CustName, om.OrderWeek
          ORDER BY p.CounName, p.FlowerName, c.CustName
        `);

        // 요약 (국가별)
        const r2 = pool.request();
        r2.input('year', sql.Int, targetYear);
        if (week) r2.input('week', sql.NVarChar, `${week}%`);

        const byCountry = await r2.query(`
          SELECT
            p.CounName AS country,
            SUM(ISNULL(od.BoxQuantity, 0)) AS boxQty,
            SUM(ISNULL(od.BunchQuantity, 0)) AS bunchQty,
            SUM(ISNULL(od.SteamQuantity, 0)) AS steamQty,
            COUNT(DISTINCT om.OrderMasterKey) AS orderCount,
            COUNT(DISTINCT om.CustKey) AS custCount
          FROM OrderDetail od
          JOIN OrderMaster om ON od.OrderMasterKey = om.OrderMasterKey
          JOIN Product p ON od.ProdKey = p.ProdKey
          WHERE ISNULL(od.isDeleted, 0) = 0
            AND ISNULL(om.isDeleted, 0) = 0
            AND om.OrderYear = @year
            ${weekFilter}
          GROUP BY p.CounName
          ORDER BY boxQty DESC
        `);

        return {
          pivot: pivot.recordset,
          byCountry: byCountry.recordset,
          year: targetYear,
          week: week || 'all',
        };
      });

      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(res, err, 'orders/pivot');
    }
  });

  /**
   * GET /api/nenova/orders/summary — 주문 요약 (국가별/꽃별/거래처별 집계)
   * ?year=2026 &week=13 &groupBy=country|flower|customer
   */
  router.get('/orders/summary', async (req, res) => {
    try {
      const { year, week, groupBy } = req.query;
      const targetYear = parseInt(year) || getCurrentWeekInfo().year;

      const result = await safeQuery(async (pool) => {
        const r = pool.request();
        r.input('year', sql.Int, targetYear);

        let weekFilter = '';
        if (week) {
          r.input('week', sql.NVarChar, `${week}%`);
          weekFilter = 'AND om.OrderWeek LIKE @week';
        }

        // 그룹 기준 결정
        let groupCol, groupName;
        switch (groupBy) {
          case 'flower':
            groupCol = 'p.FlowerName';
            groupName = 'flower';
            break;
          case 'customer':
            groupCol = 'c.CustName';
            groupName = 'customer';
            break;
          case 'country':
          default:
            groupCol = 'p.CounName';
            groupName = 'country';
            break;
        }

        const summary = await r.query(`
          SELECT
            ${groupCol} AS [group],
            COUNT(DISTINCT om.OrderMasterKey) AS orderCount,
            COUNT(DISTINCT od.OrderDetailKey) AS lineCount,
            COUNT(DISTINCT om.CustKey) AS custCount,
            SUM(ISNULL(od.BoxQuantity, 0)) AS totalBox,
            SUM(ISNULL(od.BunchQuantity, 0)) AS totalBunch,
            SUM(ISNULL(od.SteamQuantity, 0)) AS totalSteam,
            SUM(ISNULL(od.OutQuantity, 0)) AS totalOut,
            SUM(ISNULL(od.EstQuantity, 0)) AS totalEst
          FROM OrderDetail od
          JOIN OrderMaster om ON od.OrderMasterKey = om.OrderMasterKey
          JOIN Product p ON od.ProdKey = p.ProdKey
          LEFT JOIN Customer c ON om.CustKey = c.CustKey
          WHERE ISNULL(od.isDeleted, 0) = 0
            AND ISNULL(om.isDeleted, 0) = 0
            AND om.OrderYear = @year
            ${weekFilter}
          GROUP BY ${groupCol}
          ORDER BY totalBox DESC
        `);

        // 전체 합계
        const r2 = pool.request();
        r2.input('year', sql.Int, targetYear);
        if (week) r2.input('week', sql.NVarChar, `${week}%`);

        const totals = await r2.query(`
          SELECT
            COUNT(DISTINCT om.OrderMasterKey) AS orderCount,
            COUNT(DISTINCT od.OrderDetailKey) AS lineCount,
            COUNT(DISTINCT om.CustKey) AS custCount,
            SUM(ISNULL(od.BoxQuantity, 0)) AS totalBox,
            SUM(ISNULL(od.BunchQuantity, 0)) AS totalBunch,
            SUM(ISNULL(od.SteamQuantity, 0)) AS totalSteam
          FROM OrderDetail od
          JOIN OrderMaster om ON od.OrderMasterKey = om.OrderMasterKey
          WHERE ISNULL(od.isDeleted, 0) = 0
            AND ISNULL(om.isDeleted, 0) = 0
            AND om.OrderYear = @year
            ${weekFilter}
        `);

        return {
          groupBy: groupName,
          summary: summary.recordset,
          totals: totals.recordset[0],
          year: targetYear,
          week: week || 'all',
        };
      });

      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(res, err, 'orders/summary');
    }
  });

  /**
   * GET /api/nenova/orders/:key — 주문 상세 (Master + Detail 조인)
   */
  router.get('/orders/:key', async (req, res) => {
    try {
      const orderKey = parseInt(req.params.key);
      if (isNaN(orderKey)) return res.status(400).json({ ok: false, error: 'Invalid OrderMasterKey' });

      const result = await safeQuery(async (pool) => {
        const [master, details, history] = await Promise.all([
          // 마스터 정보
          pool.request()
            .input('key', sql.Int, orderKey)
            .query(`
              SELECT om.*, c.CustName
              FROM OrderMaster om
              LEFT JOIN Customer c ON om.CustKey = c.CustKey
              WHERE om.OrderMasterKey = @key
            `),

          // 디테일 목록
          pool.request()
            .input('key', sql.Int, orderKey)
            .query(`
              SELECT
                od.*,
                p.ProdName,
                p.FlowerName,
                p.CounName
              FROM OrderDetail od
              JOIN Product p ON od.ProdKey = p.ProdKey
              WHERE od.OrderMasterKey = @key
                AND ISNULL(od.isDeleted, 0) = 0
              ORDER BY od.OrderDetailKey
            `),

          // 변경 이력
          pool.request()
            .input('key', sql.Int, orderKey)
            .query(`
              SELECT * FROM OrderHistory
              WHERE OrderMasterKey = @key
              ORDER BY CreateDtm DESC
            `),
        ]);

        if (master.recordset.length === 0) return null;

        // 수량 합계 계산
        const summary = details.recordset.reduce((acc, d) => {
          acc.totalBox += d.BoxQuantity || 0;
          acc.totalBunch += d.BunchQuantity || 0;
          acc.totalSteam += d.SteamQuantity || 0;
          acc.totalOut += d.OutQuantity || 0;
          acc.totalEst += d.EstQuantity || 0;
          return acc;
        }, { totalBox: 0, totalBunch: 0, totalSteam: 0, totalOut: 0, totalEst: 0 });

        return {
          master: master.recordset[0],
          details: details.recordset,
          history: history.recordset,
          summary: {
            ...summary,
            detailCount: details.recordset.length,
          },
        };
      });

      if (!result) return res.status(404).json({ ok: false, error: '주문을 찾을 수 없습니다' });
      res.json({ ok: true, order: result });
    } catch (err) {
      handleError(res, err, `orders/${req.params.key}`);
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                           출하 (Shipments)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/nenova/shipments — 출하 목록
   * ?year=2026 &week=13 &custKey=520 &confirmed=true &limit=50 &offset=0
   */
  router.get('/shipments', async (req, res) => {
    try {
      const { year, week, custKey, confirmed } = req.query;
      const { limit, offset } = parsePagination(req.query);

      const result = await safeQuery(async (pool) => {
        const r = pool.request();
        let where = ['ISNULL(sm.isDeleted, 0) = 0'];

        if (year) {
          r.input('year', sql.Int, parseInt(year));
          where.push('sm.OrderYear = @year');
        }
        if (week) {
          r.input('week', sql.NVarChar, week);
          where.push('sm.OrderWeek = @week');
        }
        if (custKey) {
          r.input('custKey', sql.Int, parseInt(custKey));
          where.push('sm.CustKey = @custKey');
        }
        if (confirmed === 'true') {
          where.push('ISNULL(sm.isDeleted, 0) = 1');
        } else if (confirmed === 'false') {
          where.push('ISNULL(sm.isDeleted, 0) = 0');
        }

        const whereClause = 'WHERE ' + where.join(' AND ');

        // 총 건수
        const countResult = await r.query(`
          SELECT COUNT(*) AS total FROM ShipmentMaster sm ${whereClause}
        `);

        // 출하 목록
        const r2 = pool.request();
        if (year) r2.input('year', sql.Int, parseInt(year));
        if (week) r2.input('week', sql.NVarChar, week);
        if (custKey) r2.input('custKey', sql.Int, parseInt(custKey));

        const data = await r2.query(`
          SELECT
            sm.ShipmentKey,
            sm.OrderYear,
            sm.OrderWeek,
            sm.OrderYearWeek,
            sm.CustKey,
            sm.EstimateName,
            ISNULL(sm.isFix, 0) AS isFix,
            sm.CreateID,
            sm.CreateDtm,
            c.CustName,
            (SELECT COUNT(*) FROM ShipmentDetail sd WHERE sd.ShipmentKey = sm.ShipmentKey) AS detailCount,
            (SELECT SUM(ISNULL(sd.BoxQuantity, 0)) FROM ShipmentDetail sd WHERE sd.ShipmentKey = sm.ShipmentKey) AS totalBox,
            (SELECT SUM(ISNULL(sd.BunchQuantity, 0)) FROM ShipmentDetail sd WHERE sd.ShipmentKey = sm.ShipmentKey) AS totalBunch,
            (SELECT SUM(ISNULL(sd.Amount, 0)) FROM ShipmentDetail sd WHERE sd.ShipmentKey = sm.ShipmentKey) AS totalAmount
          FROM ShipmentMaster sm
          LEFT JOIN Customer c ON sm.CustKey = c.CustKey
          ${whereClause}
          ORDER BY sm.CreateDtm DESC
          OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
        `);

        return {
          total: countResult.recordset[0].total,
          items: data.recordset,
        };
      });

      res.json({ ok: true, ...result, limit, offset });
    } catch (err) {
      handleError(res, err, 'shipments');
    }
  });

  /**
   * GET /api/nenova/shipments/summary — 출하 요약
   * ?year=2026 &week=13 &groupBy=country|flower|customer
   */
  router.get('/shipments/summary', async (req, res) => {
    try {
      const { year, week, groupBy } = req.query;
      const targetYear = parseInt(year) || getCurrentWeekInfo().year;

      const result = await safeQuery(async (pool) => {
        const r = pool.request();
        r.input('year', sql.Int, targetYear);

        let weekFilter = '';
        if (week) {
          r.input('week', sql.NVarChar, week);
          weekFilter = 'AND sm.OrderWeek = @week';
        }

        // 그룹 기준
        let groupCol, groupName;
        switch (groupBy) {
          case 'flower':
            groupCol = 'p.FlowerName';
            groupName = 'flower';
            break;
          case 'customer':
            groupCol = 'c.CustName';
            groupName = 'customer';
            break;
          case 'country':
          default:
            groupCol = 'p.CounName';
            groupName = 'country';
            break;
        }

        const summary = await r.query(`
          SELECT
            ${groupCol} AS [group],
            COUNT(DISTINCT sm.ShipmentKey) AS shipCount,
            SUM(ISNULL(sd.BoxQuantity, 0)) AS totalBox,
            SUM(ISNULL(sd.BunchQuantity, 0)) AS totalBunch,
            SUM(ISNULL(sd.SteamQuantity, 0)) AS totalSteam,
            SUM(ISNULL(sd.OutQuantity, 0)) AS totalOut,
            SUM(ISNULL(sd.Cost, 0)) AS totalCost,
            SUM(ISNULL(sd.Amount, 0)) AS totalAmount,
            SUM(ISNULL(sd.Vat, 0)) AS totalVat,
            SUM(ISNULL(sd.Amount, 0)) + SUM(ISNULL(sd.Vat, 0)) AS grandTotal
          FROM ShipmentDetail sd
          JOIN ShipmentMaster sm ON sd.ShipmentKey = sm.ShipmentKey
          JOIN Product p ON sd.ProdKey = p.ProdKey
          LEFT JOIN Customer c ON sd.CustKey = c.CustKey
          WHERE ISNULL(sm.isDeleted, 0) = 0
            AND sm.OrderYear = @year
            ${weekFilter}
          GROUP BY ${groupCol}
          ORDER BY totalAmount DESC
        `);

        // 전체 합계
        const r2 = pool.request();
        r2.input('year', sql.Int, targetYear);
        if (week) r2.input('week', sql.NVarChar, week);

        const totals = await r2.query(`
          SELECT
            COUNT(DISTINCT sm.ShipmentKey) AS shipCount,
            SUM(ISNULL(sd.BoxQuantity, 0)) AS totalBox,
            SUM(ISNULL(sd.BunchQuantity, 0)) AS totalBunch,
            SUM(ISNULL(sd.SteamQuantity, 0)) AS totalSteam,
            SUM(ISNULL(sd.Cost, 0)) AS totalCost,
            SUM(ISNULL(sd.Amount, 0)) AS totalAmount,
            SUM(ISNULL(sd.Vat, 0)) AS totalVat,
            SUM(ISNULL(sd.Amount, 0)) + SUM(ISNULL(sd.Vat, 0)) AS grandTotal
          FROM ShipmentDetail sd
          JOIN ShipmentMaster sm ON sd.ShipmentKey = sm.ShipmentKey
          WHERE ISNULL(sm.isDeleted, 0) = 0
            AND sm.OrderYear = @year
            ${weekFilter}
        `);

        return {
          groupBy: groupName,
          summary: summary.recordset,
          totals: totals.recordset[0],
          year: targetYear,
          week: week || 'all',
        };
      });

      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(res, err, 'shipments/summary');
    }
  });

  /**
   * GET /api/nenova/shipments/:key — 출하 상세 (Master + Detail 조인)
   */
  router.get('/shipments/:key', async (req, res) => {
    try {
      const shipKey = parseInt(req.params.key);
      if (isNaN(shipKey)) return res.status(400).json({ ok: false, error: 'Invalid ShipmentKey' });

      const result = await safeQuery(async (pool) => {
        const [master, details, dates, farms, history] = await Promise.all([
          // 마스터 정보
          pool.request()
            .input('key', sql.Int, shipKey)
            .query(`
              SELECT sm.*, c.CustName
              FROM ShipmentMaster sm
              LEFT JOIN Customer c ON sm.CustKey = c.CustKey
              WHERE sm.ShipmentKey = @key
            `),

          // 디테일 목록
          pool.request()
            .input('key', sql.Int, shipKey)
            .query(`
              SELECT
                sd.*,
                p.ProdName,
                p.FlowerName,
                p.CounName,
                c.CustName
              FROM ShipmentDetail sd
              JOIN Product p ON sd.ProdKey = p.ProdKey
              LEFT JOIN Customer c ON sd.CustKey = c.CustKey
              WHERE sd.ShipmentKey = @key
              ORDER BY sd.SdetailKey
            `),

          // 출하 일자
          pool.request()
            .input('key', sql.Int, shipKey)
            .query(`
              SELECT * FROM ShipmentDate WHERE ShipmentKey = @key ORDER BY ShipmentDtm
            `),

          // 농장 정보
          pool.request()
            .input('key', sql.Int, shipKey)
            .query(`
              SELECT sf.*, fa.FarmName
              FROM ShipmentFarm sf
              LEFT JOIN Farm fa ON sf.FarmKey = fa.FarmKey
              WHERE sf.ShipmentKey = @key
            `),

          // 변경 이력
          pool.request()
            .input('key', sql.Int, shipKey)
            .query(`
              SELECT * FROM ShipmentHistory WHERE ShipmentKey = @key ORDER BY CreateDtm DESC
            `),
        ]);

        if (master.recordset.length === 0) return null;

        // 금액 합계
        const summary = details.recordset.reduce((acc, d) => {
          acc.totalBox += d.BoxQuantity || 0;
          acc.totalBunch += d.BunchQuantity || 0;
          acc.totalSteam += d.SteamQuantity || 0;
          acc.totalCost += d.Cost || 0;
          acc.totalAmount += d.Amount || 0;
          acc.totalVat += d.Vat || 0;
          return acc;
        }, { totalBox: 0, totalBunch: 0, totalSteam: 0, totalCost: 0, totalAmount: 0, totalVat: 0 });

        summary.grandTotal = summary.totalAmount + summary.totalVat;
        summary.detailCount = details.recordset.length;

        return {
          master: master.recordset[0],
          details: details.recordset,
          dates: dates.recordset,
          farms: farms.recordset,
          history: history.recordset,
          summary,
        };
      });

      if (!result) return res.status(404).json({ ok: false, error: '출하를 찾을 수 없습니다' });
      res.json({ ok: true, shipment: result });
    } catch (err) {
      handleError(res, err, `shipments/${req.params.key}`);
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                           차수 확정 상태 (Round Confirmation)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/nenova/rounds/confirmation-status
   * 차수 × 카테고리(CounName) 단위로 출하 확정 상태 집계
   * ?year=2026  (필수: 연도, 기본값=올해)
   * 응답:
   *   {
   *     year: 2026,
   *     rounds: [
   *       {
   *         orderWeek: "20-01",
   *         orderYearWeek: "2026-20-01",
   *         totalShipments, confirmedShipments, totalBox, confirmedBox,
   *         categories: [
   *           { counName, totalShipments, confirmedShipments, totalBox, confirmedBox, status: 'confirmed'|'partial'|'pending' }
   *         ]
   *       }
   *     ]
   *   }
   */
  router.get('/rounds/confirmation-status', async (req, res) => {
    try {
      const year = parseInt(req.query.year) || new Date().getFullYear();

      const result = await safeQuery(async (pool) => {
        const r = pool.request();
        r.input('year', sql.Int, year);

        // 차수 × 카테고리(CounName) 그룹 집계
        const data = await r.query(`
          SELECT
            sm.OrderYear,
            sm.OrderWeek,
            sm.OrderYearWeek,
            p.CounName,
            COUNT(DISTINCT sm.ShipmentKey) AS totalShipments,
            COUNT(DISTINCT CASE WHEN sm.isFix = 1 THEN sm.ShipmentKey END) AS confirmedShipments,
            SUM(ISNULL(sd.BoxQuantity, 0)) AS totalBox,
            SUM(CASE WHEN sm.isFix = 1 THEN ISNULL(sd.BoxQuantity, 0) ELSE 0 END) AS confirmedBox
          FROM ShipmentMaster sm
          JOIN ShipmentDetail sd ON sm.ShipmentKey = sd.ShipmentKey
          JOIN Product p          ON sd.ProdKey   = p.ProdKey
          WHERE sm.OrderYear = @year
            AND ISNULL(sm.isDeleted, 0) = 0
          GROUP BY sm.OrderYear, sm.OrderWeek, sm.OrderYearWeek, p.CounName
          ORDER BY sm.OrderWeek, p.CounName
        `);

        // 차수별로 그룹화
        const roundMap = new Map();
        for (const row of data.recordset) {
          const key = row.OrderWeek;
          if (!roundMap.has(key)) {
            roundMap.set(key, {
              orderWeek: row.OrderWeek,
              orderYearWeek: row.OrderYearWeek,
              totalShipments: 0,
              confirmedShipments: 0,
              totalBox: 0,
              confirmedBox: 0,
              categories: [],
            });
          }
          const round = roundMap.get(key);
          const cat = {
            counName: row.CounName || '(미지정)',
            totalShipments: Number(row.totalShipments || 0),
            confirmedShipments: Number(row.confirmedShipments || 0),
            totalBox: Number(row.totalBox || 0),
            confirmedBox: Number(row.confirmedBox || 0),
          };
          // 상태 판정: confirmed / partial / pending
          if (cat.totalShipments === 0) cat.status = 'pending';
          else if (cat.confirmedShipments === cat.totalShipments) cat.status = 'confirmed';
          else if (cat.confirmedShipments === 0) cat.status = 'pending';
          else cat.status = 'partial';
          round.categories.push(cat);
          // 차수 합계 누적 (ShipmentKey 단위 중복 카운트 주의 — 한 ShipmentMaster가 여러 카테고리에 걸칠 수 있음)
          round.totalShipments += cat.totalShipments;
          round.confirmedShipments += cat.confirmedShipments;
          round.totalBox += cat.totalBox;
          round.confirmedBox += cat.confirmedBox;
        }
        return Array.from(roundMap.values()).sort((a, b) => a.orderWeek.localeCompare(b.orderWeek));
      });

      res.json({ ok: true, year, rounds: result });
    } catch (err) {
      handleError(res, err, 'rounds/confirmation-status');
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                           거래처 (Customers)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/nenova/customers — 거래처 목록
   * ?search=keyword &limit=50 &offset=0
   */
  router.get('/customers', async (req, res) => {
    try {
      const { search } = req.query;
      const { limit, offset } = parsePagination(req.query);

      const result = await safeQuery(async (pool) => {
        const r = pool.request();
        let whereClause = '';

        if (search) {
          r.input('search', sql.NVarChar, `%${search}%`);
          whereClause = 'WHERE c.CustName LIKE @search';
        }

        // 총 건수
        const countResult = await r.query(`
          SELECT COUNT(*) AS total FROM Customer c ${whereClause}
        `);

        // 거래처 목록 + 주문/출하 건수
        const r2 = pool.request();
        if (search) r2.input('search', sql.NVarChar, `%${search}%`);

        const data = await r2.query(`
          SELECT
            c.*,
            (SELECT COUNT(*) FROM OrderMaster om WHERE om.CustKey = c.CustKey AND ISNULL(om.isDeleted, 0) = 0) AS orderCount,
            (SELECT COUNT(*) FROM ShipmentMaster sm WHERE sm.CustKey = c.CustKey AND ISNULL(sm.isDeleted, 0) = 0) AS shipmentCount,
            (SELECT MAX(om.OrderDtm) FROM OrderMaster om WHERE om.CustKey = c.CustKey AND ISNULL(om.isDeleted, 0) = 0) AS lastOrderDate,
            (SELECT MAX(sm.CreateDtm) FROM ShipmentMaster sm WHERE sm.CustKey = c.CustKey AND ISNULL(sm.isDeleted, 0) = 0) AS lastShipDate
          FROM Customer c
          ${whereClause}
          ORDER BY c.CustName
          OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
        `);

        return {
          total: countResult.recordset[0].total,
          items: data.recordset,
        };
      });

      res.json({ ok: true, ...result, limit, offset });
    } catch (err) {
      handleError(res, err, 'customers');
    }
  });

  /**
   * GET /api/nenova/customers/:key — 거래처 상세 + 최근 주문/출하
   */
  router.get('/customers/:key', async (req, res) => {
    try {
      const custKey = parseInt(req.params.key);
      if (isNaN(custKey)) return res.status(400).json({ ok: false, error: 'Invalid CustKey' });

      const result = await safeQuery(async (pool) => {
        const [customer, recentOrders, recentShipments, topProducts] = await Promise.all([
          // 거래처 기본 정보
          pool.request()
            .input('key', sql.Int, custKey)
            .query(`SELECT * FROM Customer WHERE CustKey = @key`),

          // 최근 주문 10건
          pool.request()
            .input('key', sql.Int, custKey)
            .query(`
              SELECT TOP 10
                om.OrderMasterKey, om.OrderDtm, om.OrderWeek, om.OrderYear, om.OrderCode,
                (SELECT COUNT(*) FROM OrderDetail od WHERE od.OrderMasterKey = om.OrderMasterKey AND ISNULL(od.isDeleted, 0) = 0) AS detailCount,
                (SELECT SUM(ISNULL(od.BoxQuantity, 0)) FROM OrderDetail od WHERE od.OrderMasterKey = om.OrderMasterKey AND ISNULL(od.isDeleted, 0) = 0) AS totalBox
              FROM OrderMaster om
              WHERE om.CustKey = @key AND ISNULL(om.isDeleted, 0) = 0
              ORDER BY om.CreateDtm DESC
            `),

          // 최근 출하 10건
          pool.request()
            .input('key', sql.Int, custKey)
            .query(`
              SELECT TOP 10
                sm.ShipmentKey, sm.OrderYear, sm.OrderWeek, sm.OrderYearWeek,
                ISNULL(sm.isFix, 0) AS isFix,
                (SELECT SUM(ISNULL(sd.Amount, 0)) FROM ShipmentDetail sd WHERE sd.ShipmentKey = sm.ShipmentKey) AS totalAmount
              FROM ShipmentMaster sm
              WHERE sm.CustKey = @key AND ISNULL(sm.isDeleted, 0) = 0
              ORDER BY sm.CreateDtm DESC
            `),

          // 자주 주문하는 품목 Top 10
          pool.request()
            .input('key', sql.Int, custKey)
            .query(`
              SELECT TOP 10
                p.ProdKey, p.ProdName, p.FlowerName, p.CounName,
                COUNT(*) AS orderFrequency,
                SUM(ISNULL(od.BoxQuantity, 0)) AS totalBox,
                SUM(ISNULL(od.BunchQuantity, 0)) AS totalBunch
              FROM OrderDetail od
              JOIN OrderMaster om ON od.OrderMasterKey = om.OrderMasterKey
              JOIN Product p ON od.ProdKey = p.ProdKey
              WHERE om.CustKey = @key
                AND ISNULL(od.isDeleted, 0) = 0
                AND ISNULL(om.isDeleted, 0) = 0
              GROUP BY p.ProdKey, p.ProdName, p.FlowerName, p.CounName
              ORDER BY orderFrequency DESC
            `),
        ]);

        if (customer.recordset.length === 0) return null;

        return {
          customer: customer.recordset[0],
          recentOrders: recentOrders.recordset,
          recentShipments: recentShipments.recordset,
          topProducts: topProducts.recordset,
        };
      });

      if (!result) return res.status(404).json({ ok: false, error: '거래처를 찾을 수 없습니다' });
      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(res, err, `customers/${req.params.key}`);
    }
  });

  /**
   * GET /api/nenova/customers/:key/products — 거래처별 품목 단가
   */
  router.get('/customers/:key/products', async (req, res) => {
    try {
      const custKey = parseInt(req.params.key);
      if (isNaN(custKey)) return res.status(400).json({ ok: false, error: 'Invalid CustKey' });

      const result = await safeQuery(async (pool) => {
        // CustomerProdCost 에서 단가 조회
        const costData = await pool.request()
          .input('key', sql.Int, custKey)
          .query(`
            SELECT
              cpc.*,
              p.ProdName,
              p.FlowerName,
              p.CounName
            FROM CustomerProdCost cpc
            JOIN Product p ON cpc.ProdKey = p.ProdKey
            WHERE cpc.CustKey = @key
            ORDER BY p.ProdName
          `);

        // 거래처명
        const cust = await pool.request()
          .input('key', sql.Int, custKey)
          .query(`SELECT CustName FROM Customer WHERE CustKey = @key`);

        return {
          customerName: cust.recordset[0]?.CustName || '',
          products: costData.recordset,
          total: costData.recordset.length,
        };
      });

      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(res, err, `customers/${req.params.key}/products`);
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                           견적 (Estimates)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/nenova/estimates — 견적 목록
   * ?shipmentKey=3266 &limit=50 &offset=0
   */
  router.get('/estimates', async (req, res) => {
    try {
      const { shipmentKey } = req.query;
      const { limit, offset } = parsePagination(req.query);

      const result = await safeQuery(async (pool) => {
        const r = pool.request();
        let whereClause = '';

        if (shipmentKey) {
          r.input('shipmentKey', sql.Int, parseInt(shipmentKey));
          whereClause = 'WHERE e.ShipmentKey = @shipmentKey';
        }

        const data = await r.query(`
          SELECT
            e.*,
            c.CustName,
            p.ProdName,
            p.FlowerName
          FROM Estimate e
          LEFT JOIN Customer c ON e.CustKey = c.CustKey
          LEFT JOIN Product p ON e.ProdKey = p.ProdKey
          ${whereClause}
          ORDER BY e.CreateDtm DESC
          OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
        `);

        // 총 건수
        const r2 = pool.request();
        if (shipmentKey) r2.input('shipmentKey', sql.Int, parseInt(shipmentKey));

        const count = await r2.query(`
          SELECT COUNT(*) AS total FROM Estimate e ${whereClause}
        `);

        return {
          total: count.recordset[0].total,
          items: data.recordset,
        };
      });

      res.json({ ok: true, ...result, limit, offset });
    } catch (err) {
      handleError(res, err, 'estimates');
    }
  });

  /**
   * GET /api/nenova/estimates/summary — 견적 요약 (매출/VAT 집계)
   * ?year=2026 &groupBy=customer|country|flower
   */
  router.get('/estimates/summary', async (req, res) => {
    try {
      const { year, groupBy } = req.query;

      const result = await safeQuery(async (pool) => {
        const r = pool.request();

        let yearFilter = '';
        if (year) {
          r.input('year', sql.Int, parseInt(year));
          yearFilter = 'AND YEAR(e.CreateDtm) = @year';
        }

        // 그룹 기준
        let groupCol, groupName;
        switch (groupBy) {
          case 'flower':
            groupCol = 'p.FlowerName';
            groupName = 'flower';
            break;
          case 'country':
            groupCol = 'p.CounName';
            groupName = 'country';
            break;
          case 'customer':
          default:
            groupCol = 'c.CustName';
            groupName = 'customer';
            break;
        }

        const summary = await r.query(`
          SELECT
            ${groupCol} AS [group],
            COUNT(*) AS estCount,
            SUM(ISNULL(e.Amount, 0)) AS totalAmount,
            SUM(ISNULL(e.Vat, 0)) AS totalVat,
            SUM(ISNULL(e.Amount, 0)) + SUM(ISNULL(e.Vat, 0)) AS grandTotal,
            SUM(ISNULL(e.BoxQuantity, 0)) AS totalBox,
            SUM(ISNULL(e.BunchQuantity, 0)) AS totalBunch
          FROM Estimate e
          LEFT JOIN Customer c ON e.CustKey = c.CustKey
          LEFT JOIN Product p ON e.ProdKey = p.ProdKey
          WHERE 1=1 ${yearFilter}
          GROUP BY ${groupCol}
          ORDER BY totalAmount DESC
        `);

        // 전체 합계
        const r2 = pool.request();
        if (year) r2.input('year', sql.Int, parseInt(year));

        const totals = await r2.query(`
          SELECT
            COUNT(*) AS estCount,
            SUM(ISNULL(e.Amount, 0)) AS totalAmount,
            SUM(ISNULL(e.Vat, 0)) AS totalVat,
            SUM(ISNULL(e.Amount, 0)) + SUM(ISNULL(e.Vat, 0)) AS grandTotal
          FROM Estimate e
          WHERE 1=1 ${yearFilter}
        `);

        return {
          groupBy: groupName,
          summary: summary.recordset,
          totals: totals.recordset[0],
          year: year || 'all',
        };
      });

      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(res, err, 'estimates/summary');
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                           분석 (Analysis)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/nenova/analysis/sales — 매출 분석
   * ?year=2026 &dimension=country|flower|customer|week &period=yearly|weekly
   */
  router.get('/analysis/sales', async (req, res) => {
    try {
      const { year, dimension, period } = req.query;
      const targetYear = parseInt(year) || getCurrentWeekInfo().year;

      const result = await safeQuery(async (pool) => {
        const r = pool.request();
        r.input('year', sql.Int, targetYear);

        // 매출 기준: ShipmentDetail의 Amount + Vat (확정 출하)
        let groupCol, groupName;
        switch (dimension) {
          case 'flower':
            groupCol = 'p.FlowerName';
            groupName = 'flower';
            break;
          case 'customer':
            groupCol = 'c.CustName';
            groupName = 'customer';
            break;
          case 'week':
            groupCol = 'sm.OrderWeek';
            groupName = 'week';
            break;
          case 'country':
          default:
            groupCol = 'p.CounName';
            groupName = 'country';
            break;
        }

        const sales = await r.query(`
          SELECT
            ${groupCol} AS [dimension],
            COUNT(DISTINCT sm.ShipmentKey) AS shipCount,
            COUNT(DISTINCT sd.SdetailKey) AS lineCount,
            SUM(ISNULL(sd.BoxQuantity, 0)) AS totalBox,
            SUM(ISNULL(sd.BunchQuantity, 0)) AS totalBunch,
            SUM(ISNULL(sd.SteamQuantity, 0)) AS totalSteam,
            SUM(ISNULL(sd.Cost, 0)) AS totalCost,
            SUM(ISNULL(sd.Amount, 0)) AS revenue,
            SUM(ISNULL(sd.Vat, 0)) AS vat,
            SUM(ISNULL(sd.Amount, 0)) + SUM(ISNULL(sd.Vat, 0)) AS grandTotal,
            CASE WHEN SUM(ISNULL(sd.BoxQuantity, 0)) > 0
              THEN SUM(ISNULL(sd.Amount, 0)) / SUM(ISNULL(sd.BoxQuantity, 0))
              ELSE 0
            END AS avgPricePerBox
          FROM ShipmentDetail sd
          JOIN ShipmentMaster sm ON sd.ShipmentKey = sm.ShipmentKey
          JOIN Product p ON sd.ProdKey = p.ProdKey
          LEFT JOIN Customer c ON sd.CustKey = c.CustKey
          WHERE ISNULL(sm.isDeleted, 0) = 0
            AND sm.OrderYear = @year
          GROUP BY ${groupCol}
          ORDER BY revenue DESC
        `);

        // 전체 매출 합계
        const r2 = pool.request();
        r2.input('year', sql.Int, targetYear);

        const totals = await r2.query(`
          SELECT
            SUM(ISNULL(sd.Cost, 0)) AS totalCost,
            SUM(ISNULL(sd.Amount, 0)) AS totalRevenue,
            SUM(ISNULL(sd.Vat, 0)) AS totalVat,
            SUM(ISNULL(sd.Amount, 0)) + SUM(ISNULL(sd.Vat, 0)) AS grandTotal,
            SUM(ISNULL(sd.Amount, 0)) - SUM(ISNULL(sd.Cost, 0)) AS grossProfit,
            CASE WHEN SUM(ISNULL(sd.Amount, 0)) > 0
              THEN ROUND((SUM(ISNULL(sd.Amount, 0)) - SUM(ISNULL(sd.Cost, 0))) * 100.0 / SUM(ISNULL(sd.Amount, 0)), 2)
              ELSE 0
            END AS profitMarginPct
          FROM ShipmentDetail sd
          JOIN ShipmentMaster sm ON sd.ShipmentKey = sm.ShipmentKey
          WHERE ISNULL(sm.isDeleted, 0) = 0
            AND sm.OrderYear = @year
        `);

        return {
          dimension: groupName,
          sales: sales.recordset,
          totals: totals.recordset[0],
          year: targetYear,
        };
      });

      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(res, err, 'analysis/sales');
    }
  });

  /**
   * GET /api/nenova/analysis/trends — 추이 분석 (주차별 주문/출하 비교)
   * ?year=2026 &weeks=12
   */
  router.get('/analysis/trends', async (req, res) => {
    try {
      const targetYear = parseInt(req.query.year) || getCurrentWeekInfo().year;
      const weeks = Math.min(parseInt(req.query.weeks) || 12, 52);

      const result = await safeQuery(async (pool) => {
        // 주차별 주문 추이
        const orderTrend = await pool.request()
          .input('year', sql.Int, targetYear)
          .query(`
            SELECT
              LEFT(om.OrderWeek, CHARINDEX('-', om.OrderWeek + '-') - 1) AS weekNo,
              COUNT(DISTINCT om.OrderMasterKey) AS orderCount,
              COUNT(DISTINCT om.CustKey) AS custCount,
              SUM(ISNULL(od.BoxQuantity, 0)) AS totalBox,
              SUM(ISNULL(od.BunchQuantity, 0)) AS totalBunch,
              SUM(ISNULL(od.SteamQuantity, 0)) AS totalSteam,
              COUNT(DISTINCT od.ProdKey) AS productVariety
            FROM OrderMaster om
            LEFT JOIN OrderDetail od ON om.OrderMasterKey = od.OrderMasterKey AND ISNULL(od.isDeleted, 0) = 0
            WHERE ISNULL(om.isDeleted, 0) = 0
              AND om.OrderYear = @year
            GROUP BY LEFT(om.OrderWeek, CHARINDEX('-', om.OrderWeek + '-') - 1)
            ORDER BY weekNo DESC
            OFFSET 0 ROWS FETCH NEXT ${weeks} ROWS ONLY
          `);

        // 주차별 출하 추이
        const shipTrend = await pool.request()
          .input('year', sql.Int, targetYear)
          .query(`
            SELECT
              sm.OrderWeek AS weekNo,
              COUNT(DISTINCT sm.ShipmentKey) AS shipCount,
              COUNT(DISTINCT sm.CustKey) AS custCount,
              SUM(ISNULL(sd.BoxQuantity, 0)) AS totalBox,
              SUM(ISNULL(sd.BunchQuantity, 0)) AS totalBunch,
              SUM(ISNULL(sd.Amount, 0)) AS revenue,
              SUM(ISNULL(sd.Cost, 0)) AS cost,
              SUM(ISNULL(sd.Amount, 0)) - SUM(ISNULL(sd.Cost, 0)) AS profit
            FROM ShipmentMaster sm
            LEFT JOIN ShipmentDetail sd ON sm.ShipmentKey = sd.ShipmentKey
            WHERE ISNULL(sm.isDeleted, 0) = 0
              AND sm.OrderYear = @year
            GROUP BY sm.OrderWeek
            ORDER BY sm.OrderWeek DESC
            OFFSET 0 ROWS FETCH NEXT ${weeks} ROWS ONLY
          `);

        // 주문 vs 출하 비교 (주차 매핑)
        const comparison = await pool.request()
          .input('year', sql.Int, targetYear)
          .query(`
            SELECT
              COALESCE(o.weekNo, s.weekNo) AS weekNo,
              ISNULL(o.orderBox, 0) AS orderedBox,
              ISNULL(s.shippedBox, 0) AS shippedBox,
              ISNULL(o.orderBox, 0) - ISNULL(s.shippedBox, 0) AS gapBox,
              CASE WHEN ISNULL(o.orderBox, 0) > 0
                THEN ROUND(ISNULL(s.shippedBox, 0) * 100.0 / ISNULL(o.orderBox, 0), 1)
                ELSE 0
              END AS fulfillmentPct
            FROM (
              SELECT
                LEFT(om.OrderWeek, CHARINDEX('-', om.OrderWeek + '-') - 1) AS weekNo,
                SUM(ISNULL(od.BoxQuantity, 0)) AS orderBox
              FROM OrderMaster om
              LEFT JOIN OrderDetail od ON om.OrderMasterKey = od.OrderMasterKey AND ISNULL(od.isDeleted, 0) = 0
              WHERE ISNULL(om.isDeleted, 0) = 0 AND om.OrderYear = @year
              GROUP BY LEFT(om.OrderWeek, CHARINDEX('-', om.OrderWeek + '-') - 1)
            ) o
            FULL OUTER JOIN (
              SELECT
                sm.OrderWeek AS weekNo,
                SUM(ISNULL(sd.BoxQuantity, 0)) AS shippedBox
              FROM ShipmentMaster sm
              LEFT JOIN ShipmentDetail sd ON sm.ShipmentKey = sd.ShipmentKey
              WHERE ISNULL(sm.isDeleted, 0) = 0 AND sm.OrderYear = @year
              GROUP BY sm.OrderWeek
            ) s ON o.weekNo = s.weekNo
            ORDER BY weekNo DESC
            OFFSET 0 ROWS FETCH NEXT ${weeks} ROWS ONLY
          `);

        return {
          orderTrend: orderTrend.recordset,
          shipmentTrend: shipTrend.recordset,
          comparison: comparison.recordset,
          year: targetYear,
        };
      });

      res.json({ ok: true, trends: result });
    } catch (err) {
      handleError(res, err, 'analysis/trends');
    }
  });

  /**
   * GET /api/nenova/analysis/ranking — 순위 분석
   * ?year=2026 &type=customer|product|flower|country &limit=20
   */
  router.get('/analysis/ranking', async (req, res) => {
    try {
      const targetYear = parseInt(req.query.year) || getCurrentWeekInfo().year;
      const rankType = req.query.type || 'customer';
      const topN = Math.min(parseInt(req.query.limit) || 20, 100);

      const result = await safeQuery(async (pool) => {
        // 거래처 매출 순위
        const customerRank = await pool.request()
          .input('year', sql.Int, targetYear)
          .query(`
            SELECT TOP ${topN}
              c.CustKey,
              c.CustName,
              COUNT(DISTINCT sm.ShipmentKey) AS shipCount,
              SUM(ISNULL(sd.BoxQuantity, 0)) AS totalBox,
              SUM(ISNULL(sd.Amount, 0)) AS revenue,
              SUM(ISNULL(sd.Amount, 0)) + SUM(ISNULL(sd.Vat, 0)) AS grandTotal,
              ROW_NUMBER() OVER (ORDER BY SUM(ISNULL(sd.Amount, 0)) DESC) AS rank
            FROM ShipmentDetail sd
            JOIN ShipmentMaster sm ON sd.ShipmentKey = sm.ShipmentKey
            LEFT JOIN Customer c ON sd.CustKey = c.CustKey
            WHERE ISNULL(sm.isDeleted, 0) = 0
              AND sm.OrderYear = @year
            GROUP BY c.CustKey, c.CustName
            ORDER BY revenue DESC
          `);

        // 품목 인기 순위 (주문 빈도)
        const productRank = await pool.request()
          .input('year', sql.Int, targetYear)
          .query(`
            SELECT TOP ${topN}
              p.ProdKey,
              p.ProdName,
              p.FlowerName,
              p.CounName,
              COUNT(DISTINCT od.OrderDetailKey) AS orderLineCount,
              COUNT(DISTINCT om.OrderMasterKey) AS orderCount,
              SUM(ISNULL(od.BoxQuantity, 0)) AS totalBox,
              SUM(ISNULL(od.BunchQuantity, 0)) AS totalBunch,
              COUNT(DISTINCT om.CustKey) AS custCount,
              ROW_NUMBER() OVER (ORDER BY COUNT(DISTINCT od.OrderDetailKey) DESC) AS rank
            FROM OrderDetail od
            JOIN OrderMaster om ON od.OrderMasterKey = om.OrderMasterKey
            JOIN Product p ON od.ProdKey = p.ProdKey
            WHERE ISNULL(od.isDeleted, 0) = 0
              AND ISNULL(om.isDeleted, 0) = 0
              AND om.OrderYear = @year
            GROUP BY p.ProdKey, p.ProdName, p.FlowerName, p.CounName
            ORDER BY orderLineCount DESC
          `);

        // 꽃 종류별 매출 순위
        const flowerRank = await pool.request()
          .input('year', sql.Int, targetYear)
          .query(`
            SELECT TOP ${topN}
              p.FlowerName,
              COUNT(DISTINCT sd.SdetailKey) AS lineCount,
              SUM(ISNULL(sd.BoxQuantity, 0)) AS totalBox,
              SUM(ISNULL(sd.Amount, 0)) AS revenue,
              COUNT(DISTINCT sd.CustKey) AS custCount,
              ROW_NUMBER() OVER (ORDER BY SUM(ISNULL(sd.Amount, 0)) DESC) AS rank
            FROM ShipmentDetail sd
            JOIN ShipmentMaster sm ON sd.ShipmentKey = sm.ShipmentKey
            JOIN Product p ON sd.ProdKey = p.ProdKey
            WHERE ISNULL(sm.isDeleted, 0) = 0
              AND sm.OrderYear = @year
            GROUP BY p.FlowerName
            ORDER BY revenue DESC
          `);

        // 국가별 매출 순위
        const countryRank = await pool.request()
          .input('year', sql.Int, targetYear)
          .query(`
            SELECT TOP ${topN}
              p.CounName,
              COUNT(DISTINCT sd.SdetailKey) AS lineCount,
              SUM(ISNULL(sd.BoxQuantity, 0)) AS totalBox,
              SUM(ISNULL(sd.Amount, 0)) AS revenue,
              COUNT(DISTINCT sd.CustKey) AS custCount,
              COUNT(DISTINCT p.ProdKey) AS productVariety,
              ROW_NUMBER() OVER (ORDER BY SUM(ISNULL(sd.Amount, 0)) DESC) AS rank
            FROM ShipmentDetail sd
            JOIN ShipmentMaster sm ON sd.ShipmentKey = sm.ShipmentKey
            JOIN Product p ON sd.ProdKey = p.ProdKey
            WHERE ISNULL(sm.isDeleted, 0) = 0
              AND sm.OrderYear = @year
            GROUP BY p.CounName
            ORDER BY revenue DESC
          `);

        return {
          customerRanking: customerRank.recordset,
          productRanking: productRank.recordset,
          flowerRanking: flowerRank.recordset,
          countryRanking: countryRank.recordset,
          year: targetYear,
        };
      });

      res.json({ ok: true, ranking: result });
    } catch (err) {
      handleError(res, err, 'analysis/ranking');
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                    동기화 (nenova → Orbit AI)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Orbit PostgreSQL DB 헬퍼
   */
  function getOrbitDb() {
    const db = getDb();
    if (!db || !db.query) throw new Error('Orbit PostgreSQL DB를 사용할 수 없습니다');
    return db;
  }

  /**
   * Orbit 동기화 테이블 초기화
   */
  async function ensureSyncTables() {
    const db = getOrbitDb();

    // 기존 테이블에 nenova_key 컬럼 추가 (이미 있으면 무시)
    try { await db.query(`ALTER TABLE master_products ADD COLUMN IF NOT EXISTS nenova_key INT`); } catch {}
    try { await db.query(`ALTER TABLE master_products ADD COLUMN IF NOT EXISTS flower_name TEXT`); } catch {}
    try { await db.query(`ALTER TABLE master_products ADD COLUMN IF NOT EXISTS country TEXT`); } catch {}
    try { await db.query(`ALTER TABLE master_products ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ`); } catch {}
    try { await db.query(`ALTER TABLE master_products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`); } catch {}

    try { await db.query(`ALTER TABLE master_customers ADD COLUMN IF NOT EXISTS nenova_key INT`); } catch {}
    try { await db.query(`ALTER TABLE master_customers ADD COLUMN IF NOT EXISTS contact TEXT`); } catch {}
    try { await db.query(`ALTER TABLE master_customers ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ`); } catch {}
    try { await db.query(`ALTER TABLE master_customers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`); } catch {}

    // parsed_orders에도 nenova 키 컬럼 추가
    try { await db.query(`ALTER TABLE parsed_orders ADD COLUMN IF NOT EXISTS nenova_order_key INT`); } catch {}
    try { await db.query(`ALTER TABLE parsed_orders ADD COLUMN IF NOT EXISTS nenova_detail_key INT`); } catch {}
    try { await db.query(`ALTER TABLE parsed_orders ADD COLUMN IF NOT EXISTS order_week TEXT`); } catch {}
    try { await db.query(`ALTER TABLE parsed_orders ADD COLUMN IF NOT EXISTS order_year INT`); } catch {}
    try { await db.query(`ALTER TABLE parsed_orders ADD COLUMN IF NOT EXISTS order_date TIMESTAMPTZ`); } catch {}
    try { await db.query(`ALTER TABLE parsed_orders ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ`); } catch {}

    // 인덱스 (실패해도 무시)
    try { await db.query(`CREATE INDEX IF NOT EXISTS idx_mp_nenova_key ON master_products(nenova_key)`); } catch {}
    try { await db.query(`CREATE INDEX IF NOT EXISTS idx_mc_nenova_key ON master_customers(nenova_key)`); } catch {}
    try { await db.query(`CREATE INDEX IF NOT EXISTS idx_po_nenova_order ON parsed_orders(nenova_order_key)`); } catch {}
  }

  // 초기화 + 거래처 자동 동기화 (서버 시작 시)
  async function _autoSyncCustomers() {
    try {
      const orbitDb = getOrbitDb();
      if (!orbitDb?.query) return;
      await ensureSyncTables();

      // Descr 있는 활성 거래처만 동기화
      const nenovaCustomers = await safeQuery(async (pool) => {
        const r = await pool.request().query(`SELECT CustKey, CustName, Descr, Manager FROM Customer ORDER BY CustKey`);
        return r.recordset;
      }).catch(() => []);

      // nenova_key unique constraint 확보
      try { await orbitDb.query(`ALTER TABLE master_customers ADD CONSTRAINT uq_mc_nenova_key UNIQUE (nenova_key)`); } catch (_) {}

      const activeCustomers = nenovaCustomers.filter(c => c.Descr && c.Descr.trim());
      let synced = 0;
      for (const cust of activeCustomers) {
        try {
          const descrName = (cust.Descr || '').split('/')[0].trim();
          const commonName = descrName || cust.CustName || '';
          if (!commonName) continue;
          const aliases = JSON.stringify([cust.CustName].filter(a => a && a !== commonName));

          // check → update or insert (constraint 없어도 동작)
          const ex = await orbitDb.query(`SELECT id FROM master_customers WHERE nenova_key=$1 LIMIT 1`, [cust.CustKey]);
          if (ex.rows.length > 0) {
            await orbitDb.query(
              `UPDATE master_customers SET name=$1, name_alias=$2, source='nenova', synced_at=NOW() WHERE nenova_key=$3`,
              [commonName, aliases, cust.CustKey]
            );
          } else {
            await orbitDb.query(
              `INSERT INTO master_customers (nenova_key, name, name_alias, source, first_seen, last_seen, seen_count, synced_at)
               VALUES ($1,$2,$3,'nenova',NOW(),NOW(),1,NOW())`,
              [cust.CustKey, commonName, aliases]
            );
          }
          synced++;
        } catch (_) {}
      }
      if (synced > 0) console.log(`[nenova-db] 거래처 자동 동기화: ${synced}/${activeCustomers.length}건`);
    } catch (e) {
      console.warn('[nenova-db] 거래처 자동 동기화 실패:', e.message);
    }
  }

  try {
    const db = getDb();
    if (db && db.query) {
      ensureSyncTables()
        .then(() => setTimeout(_autoSyncCustomers, 3000)) // 서버 완전 시작 후 3초 대기
        .catch(e => console.warn('[nenova-db] sync 테이블 초기화 실패:', e.message));
    }
  } catch (_) { /* DB 미연결 시 무시 */ }

  /**
   * POST /api/nenova/sync/products — nenova Product → Orbit master_products 동기화
   */
  router.post('/sync/products', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();
      await ensureSyncTables();

      // nenova에서 전체 상품 조회
      const nenovaProducts = await safeQuery(async (pool) => {
        const data = await pool.request().query(`
          SELECT ProdKey, ProdName, FlowerName, CounName
          FROM Product
          ORDER BY ProdKey
        `);
        return data.recordset;
      });

      let synced = 0, updated = 0, errors = 0;

      for (const prod of nenovaProducts) {
        try {
          // 기존 name으로 매칭 시도, 없으면 INSERT
          const existing = await orbitDb.query(`SELECT id FROM master_products WHERE name = $1 LIMIT 1`, [prod.ProdName || '']);
          let result;
          if (existing.rows.length > 0) {
            result = await orbitDb.query(`
              UPDATE master_products SET nenova_key=$1, flower_name=$2, country=$3, category=$4, origin=$3, source='nenova', synced_at=NOW(), updated_at=NOW()
              WHERE name=$5
            `, [prod.ProdKey, prod.FlowerName||'', prod.CounName||'', prod.FlowerName||'', prod.ProdName||'']);
            updated++;
          } else {
            result = await orbitDb.query(`
              INSERT INTO master_products (nenova_key, name, name_en, flower_name, country, category, origin, source, first_seen, last_seen, seen_count, synced_at)
              VALUES ($1, $2, $2, $3, $4, $5, $4, 'nenova', NOW(), NOW(), 1, NOW())
              ON CONFLICT DO NOTHING
            `, [prod.ProdKey, prod.ProdName||'', prod.FlowerName||'', prod.CounName||'', prod.FlowerName||'']);
          }

          if (result.rowCount > 0) {
            // ON CONFLICT에서 UPDATE 실행됨 → 업데이트
            // INSERT 성공 → 신규
            synced++;
          }
        } catch (e) {
          errors++;
          if (errors <= 3) console.error(`[nenova-db] sync/products 오류 (ProdKey=${prod.ProdKey}):`, e.message);
        }
      }

      console.log(`[nenova-db] 상품 동기화 완료: ${synced}건 처리, ${errors}건 오류`);
      res.json({
        ok: true,
        sync: 'products',
        total: nenovaProducts.length,
        synced,
        errors,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'sync/products');
    }
  });

  /**
   * POST /api/nenova/sync/customers — nenova Customer → Orbit master_customers 동기화
   * Descr 필드에서 통용명(박스라벨 = 카톡 호칭) 추출하여 name으로 저장
   * Descr 형식: "통용명/품종-출고요일/.../CL번호"
   */
  router.post('/sync/customers', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();
      await ensureSyncTables();

      // nenova에서 전체 거래처 조회 (Descr 포함)
      const nenovaCustomers = await safeQuery(async (pool) => {
        const data = await pool.request().query(`
          SELECT CustKey, CustName, Descr, Manager FROM Customer ORDER BY CustKey
        `);
        return data.recordset;
      });

      // Descr 있는 활성 거래처만 처리 (통용명 추출)
      const activeCustomers = nenovaCustomers.filter(c => c.Descr && c.Descr.trim());

      let synced = 0, errors = 0, skipped = 0;

      for (const cust of activeCustomers) {
        try {
          // Descr 첫 슬래쉬 앞 = 통용명(박스라벨 = 카톡 호칭)
          const descrName = (cust.Descr || '').split('/')[0].trim();
          // 통용명이 없으면 CustName 사용
          const commonName = descrName || cust.CustName || '';
          if (!commonName) { skipped++; continue; }

          // alias: CustName (사업자명) + descrName (통용명) 모두 포함
          const aliases = [cust.CustName].filter(a => a && a !== commonName);

          // 기존 레코드 확인 (nenova_key 기준)
          const existing = await orbitDb.query(
            `SELECT id FROM master_customers WHERE nenova_key = $1 LIMIT 1`, [cust.CustKey]
          );

          if (existing.rows.length > 0) {
            await orbitDb.query(
              `UPDATE master_customers SET
                name=$1, name_alias=$2, nenova_key=$3,
                source='nenova', synced_at=NOW(), updated_at=NOW()
               WHERE nenova_key=$3`,
              [commonName, JSON.stringify(aliases), cust.CustKey]
            );
          } else {
            await orbitDb.query(
              `INSERT INTO master_customers
                (nenova_key, name, name_alias, source, first_seen, last_seen, seen_count, synced_at)
               VALUES ($1,$2,$3,'nenova',NOW(),NOW(),1,NOW())
               ON CONFLICT (nenova_key) DO UPDATE SET
                name=$2, name_alias=$3, synced_at=NOW()`,
              [cust.CustKey, commonName, JSON.stringify(aliases)]
            );
          }
          synced++;
        } catch (e) {
          errors++;
          if (errors <= 3) console.error(`[nenova-db] sync/customers 오류 (CustKey=${cust.CustKey}):`, e.message);
        }
      }

      console.log(`[nenova-db] 거래처 동기화: 활성 ${activeCustomers.length}건 처리, ${synced}성공, ${errors}오류`);
      res.json({
        ok: true,
        sync: 'customers',
        total: nenovaCustomers.length,
        active: activeCustomers.length,
        synced,
        errors,
        skipped,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'sync/customers');
    }
  });

  /**
   * POST /api/nenova/sync/orders — nenova 최근 주문 → Orbit parsed_orders 동기화
   * body: { year, week, limit }
   */
  router.post('/sync/orders', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();
      await ensureSyncTables();

      const { year, week } = req.body || {};
      const syncLimit = Math.min(parseInt(req.body?.limit) || 200, 1000);

      // nenova에서 최근 주문 조회 (Master + Detail)
      const nenovaOrders = await safeQuery(async (pool) => {
        const r = pool.request();
        let where = ['ISNULL(om.isDeleted, 0) = 0', 'ISNULL(od.isDeleted, 0) = 0'];

        if (year) {
          r.input('year', sql.Int, parseInt(year));
          where.push('om.OrderYear = @year');
        }
        if (week) {
          r.input('week', sql.NVarChar, `${week}%`);
          where.push('om.OrderWeek LIKE @week');
        }

        const data = await r.query(`
          SELECT TOP ${syncLimit}
            om.OrderMasterKey,
            om.OrderDtm,
            om.OrderYear,
            om.OrderWeek,
            om.OrderCode,
            c.CustName,
            od.OrderDetailKey,
            od.ProdKey,
            p.ProdName,
            p.FlowerName,
            p.CounName,
            od.BoxQuantity,
            od.BunchQuantity,
            od.SteamQuantity,
            od.OutQuantity,
            od.EstQuantity
          FROM OrderDetail od
          JOIN OrderMaster om ON od.OrderMasterKey = om.OrderMasterKey
          JOIN Product p ON od.ProdKey = p.ProdKey
          LEFT JOIN Customer c ON om.CustKey = c.CustKey
          WHERE ${where.join(' AND ')}
          ORDER BY om.CreateDtm DESC, od.OrderDetailKey
        `);

        return data.recordset;
      });

      let synced = 0, skipped = 0, errors = 0;

      for (const order of nenovaOrders) {
        try {
          // 이미 동기화된 항목 확인
          const existing = await orbitDb.query(
            'SELECT id FROM parsed_orders WHERE nenova_detail_key = $1',
            [order.OrderDetailKey]
          );

          if (existing.rows.length > 0) {
            skipped++;
            continue;
          }

          // parsed_orders 형식으로 변환
          await orbitDb.query(`
            INSERT INTO parsed_orders
              (source_event_id, source_type, nenova_order_key, nenova_detail_key, customer, product, quantity, unit, action, raw_text, confidence, order_week, order_year, order_date, synced_at)
            VALUES
              ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
          `, [
            `nenova_order_${order.OrderDetailKey}`,
            'nenova_sync',
            order.OrderMasterKey,
            order.OrderDetailKey,
            order.CustName || '',
            `${order.ProdName || ''} (${order.FlowerName || ''}, ${order.CounName || ''})`,
            order.BoxQuantity || 0,
            'box',
            'order',
            `주문코드: ${order.OrderCode || ''}, Box: ${order.BoxQuantity || 0}, Bunch: ${order.BunchQuantity || 0}, Steam: ${order.SteamQuantity || 0}`,
            1.0,
            order.OrderWeek || '',
            order.OrderYear || 0,
            order.OrderDtm || null,
          ]);

          synced++;
        } catch (e) {
          errors++;
          if (errors <= 3) console.error(`[nenova-db] sync/orders 오류 (DetailKey=${order.OrderDetailKey}):`, e.message);
        }
      }

      console.log(`[nenova-db] 주문 동기화 완료: ${synced}건 신규, ${skipped}건 건너뜀, ${errors}건 오류`);
      res.json({
        ok: true,
        sync: 'orders',
        total: nenovaOrders.length,
        synced,
        skipped,
        errors,
        filters: { year: year || 'all', week: week || 'all' },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'sync/orders');
    }
  });

  // ── 외부 PUSH import (로컬 PC → Railway: 내부망 우회) ──────────────────────
  // POST /api/nenova/import/products  { products: [{ProdKey, ProdName, FlowerName, CounName}] }
  router.post('/import/products', async (req, res) => {
    const adminSecret = process.env.ADMIN_SECRET;
    const secretHeader = req.headers['x-admin-secret'] || req.query.adminSecret;
    if (!adminSecret || secretHeader !== adminSecret) return res.status(403).json({ error: 'forbidden' });

    const { products = [] } = req.body || {};
    if (!Array.isArray(products) || products.length === 0) return res.status(400).json({ error: 'products array required' });

    const db = getOrbitDb();
    await ensureSyncTables();
    let synced = 0, errors = 0;

    for (const p of products) {
      try {
        await db.query(`
          INSERT INTO master_products (nenova_key, name, name_en, flower_name, country, category, origin, source, first_seen, last_seen, seen_count, synced_at)
          VALUES ($1,$2,$2,$3,$4,$5,$4,'nenova',NOW(),NOW(),1,NOW())
          ON CONFLICT (name) DO UPDATE SET
            nenova_key=EXCLUDED.nenova_key, flower_name=EXCLUDED.flower_name,
            country=EXCLUDED.country, category=EXCLUDED.category, origin=EXCLUDED.origin,
            source='nenova', last_seen=NOW(), seen_count=master_products.seen_count+1, synced_at=NOW(), updated_at=NOW()
        `, [p.ProdKey||'', p.ProdName||'', p.FlowerName||'', p.CounName||'', p.FlowerName||'']);
        synced++;
      } catch (e) { errors++; }
    }
    res.json({ ok: true, synced, errors, total: products.length });
  });

  // POST /api/nenova/import/customers  { customers: [{CustKey, CustName}] }
  router.post('/import/customers', async (req, res) => {
    const adminSecret = process.env.ADMIN_SECRET;
    const secretHeader = req.headers['x-admin-secret'] || req.query.adminSecret;
    if (!adminSecret || secretHeader !== adminSecret) return res.status(403).json({ error: 'forbidden' });

    const { customers = [] } = req.body || {};
    if (!Array.isArray(customers) || customers.length === 0) return res.status(400).json({ error: 'customers array required' });

    const db = getOrbitDb();
    await ensureSyncTables();
    let synced = 0, errors = 0;

    for (const c of customers) {
      try {
        await db.query(`
          INSERT INTO master_customers (nenova_key, name, source, first_seen, last_seen, seen_count, synced_at)
          VALUES ($1,$2,'nenova',NOW(),NOW(),1,NOW())
          ON CONFLICT (name) DO UPDATE SET
            nenova_key=EXCLUDED.nenova_key, source='nenova',
            last_seen=NOW(), seen_count=master_customers.seen_count+1, synced_at=NOW(), updated_at=NOW()
        `, [c.CustKey||'', c.CustName||'']);
        synced++;
      } catch (e) { errors++; }
    }
    res.json({ ok: true, synced, errors, total: customers.length });
  });

  // POST /api/nenova/import/orders  { orders: [{OrderMasterKey, OrderDetailKey, ...}] }
  router.post('/import/orders', async (req, res) => {
    const adminSecret = process.env.ADMIN_SECRET;
    const secretHeader = req.headers['x-admin-secret'] || req.query.adminSecret;
    if (!adminSecret || secretHeader !== adminSecret) return res.status(403).json({ error: 'forbidden' });

    const { orders = [] } = req.body || {};
    if (!Array.isArray(orders) || orders.length === 0) return res.status(400).json({ error: 'orders array required' });

    const db = getOrbitDb();
    await ensureSyncTables();
    let synced = 0, skipped = 0, errors = 0;

    for (const o of orders) {
      try {
        const existing = await db.query(
          'SELECT id FROM parsed_orders WHERE nenova_detail_key = $1',
          [o.OrderDetailKey]
        );
        if (existing.rows.length > 0) { skipped++; continue; }

        await db.query(`
          INSERT INTO parsed_orders
            (source_event_id, source_type, nenova_order_key, nenova_detail_key, customer, product,
             quantity, unit, action, raw_text, confidence, order_week, order_year, order_date, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
        `, [
          `nenova_order_${o.OrderDetailKey}`,
          'nenova_sync',
          o.OrderMasterKey,
          o.OrderDetailKey,
          o.CustName || '',
          `${o.ProdName || ''} (${o.FlowerName || ''}, ${o.CounName || ''})`,
          o.BoxQuantity || 0,
          'box',
          'order',
          `주문코드: ${o.OrderCode || ''}, Box: ${o.BoxQuantity || 0}, Bunch: ${o.BunchQuantity || 0}, Steam: ${o.SteamQuantity || 0}`,
          1.0,
          o.OrderWeek || '',
          o.OrderYear || 0,
          o.OrderDtm || null,
        ]);
        synced++;
      } catch (e) {
        errors++;
        if (errors <= 3) console.error(`[nenova-db] import/orders 오류 (DetailKey=${o.OrderDetailKey}):`, e.message);
      }
    }

    console.log(`[nenova-db] import/orders: ${synced}건 신규, ${skipped}건 건너뜀, ${errors}건 오류 / total ${orders.length}`);
    res.json({ ok: true, synced, skipped, errors, total: orders.length });
  });

  // ── 라우터 반환 ──
  return router;
};
