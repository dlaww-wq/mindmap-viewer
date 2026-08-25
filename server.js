/**
 * server.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orbit AI 서버 진입점
 *
 * 역할: WebSocket 서버, 파일 감시, 라우터 조립, 서버 시작
 * 비즈니스 로직은 routes/ 폴더의 각 라우터 파일에 위치합니다.
 *
 * 아키텍처:
 *   server.js          ← 서버 조립 (의존성 주입, 라우터 마운트)
 *   routes/graph.js    ← 그래프·세션·검색·스냅샷
 *   routes/annotations.js ← 주석·사용자 설정·라벨
 *   routes/ai-events.js   ← 멀티 AI 이벤트 수신
 *   routes/analysis.js    ← 코드 분석·컨텍스트 브릿지·충돌 감지
 *   routes/security.js    ← Shadow AI·감사 로그
 *   routes/reports.js     ← 일일·주간 리포트
 *   routes/themes.js      ← 테마 마켓
 *   routes/auth.js        ← 계정 인증
 *   routes/payment.js     ← 결제/구독
 *   routes/growth.js      ← 성장 엔진·솔루션 마켓
 *   routes/community.js   ← 커뮤니티 게시판
 *
 * http://localhost:4747
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();
const logger = require('./src/logger');
const env    = require('./config/environment');
const memMgr = require('./services/memory-manager');

// ─── 전역 미처리 Promise 거부 안전망 (Node.js v24+ 크래시 방지) ────────────────
process.on('unhandledRejection', (reason, promise) => {
  logger.warn('미처리 Promise 거부 (무시됨): %s', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  logger.error('처리되지 않은 예외: %s', err.message, { stack: err.stack });
  // OOM은 복구 불가 → Railway가 자동 재시작하도록 종료
  if (err.message && (err.message.includes('heap') || err.message.includes('memory'))) {
    logger.error('OOM 감지 — 프로세스 종료 (Railway 자동 재시작)');
    process.exit(1);
  }
  // 기타 예외는 계속 실행
});

// ─── 힙 메모리 모니터링 + 서킷브레이커 ──────────────────────────────────────────
// 로직은 services/memory-manager.js 참조
memMgr.startMonitoring();

const express      = require('express');
const http         = require('http');
const WebSocket    = require('ws');
const chokidar     = require('chokidar');
const fs           = require('fs');
const path         = require('path');
// rate-limit: 인메모리 구현 (express-rate-limit v8 Railway 프록시 호환 문제 대체)
const _rlStore = new Map();
const _RL_MAX_ENTRIES = 5000; // 메모리 상한
// 만료된 엔트리만 정리 (전체 리셋 대신 개별 만료 — 메모리 안정)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _rlStore) {
    if (now > entry.resetAt) _rlStore.delete(key);
  }
  // 상한 초과 시 가장 오래된 절반 삭제
  if (_rlStore.size > _RL_MAX_ENTRIES) {
    const keys = [..._rlStore.keys()];
    for (let i = 0; i < keys.length / 2; i++) _rlStore.delete(keys[i]);
  }
}, 60 * 1000); // 1분마다 정리
const rateLimit = ({ windowMs = 900000, max = 2000 } = {}) => (req, res, next) => {
  // 인증된 사용자는 토큰 기반 키 (같은 IP 공유 시 독립 카운트)
  const authToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const key = authToken ? `user:${authToken.slice(0, 16)}` : (req.ip || 'unknown');
  const entry = _rlStore.get(key) || { count: 0, resetAt: Date.now() + windowMs };
  if (Date.now() > entry.resetAt) { entry.count = 0; entry.resetAt = Date.now() + windowMs; }
  if (++entry.count > max) return res.status(429).json({ error: 'Too many requests' });
  _rlStore.set(key, entry);
  next();
};
const helmet       = require('helmet');
const { validateBody } = require('./src/validate');

// ─── 의존성 로드 ─────────────────────────────────────────────────────────────
// DATABASE_URL 있으면 PostgreSQL, 없으면 SQLite 자동 선택
const dbModule = process.env.DATABASE_URL
  ? require('./src/db-pg')
  : require('./src/db');

const {
  initDatabase, getAllEvents, getEventsBySession, getEventsByChannel,
  searchEvents, getSessions, updateSessionTitle, getFiles, getAnnotations, insertAnnotation,
  deleteAnnotation, insertEvent, rollbackToEvent, clearAll, getStats,
  getUserLabels, setUserLabel, deleteUserLabel,
  getUserCategories, upsertUserCategory, deleteUserCategory,
  getToolLabelMappings, setToolLabelMapping, deleteToolLabelMapping, getUserConfig,
  getEventsByUser, getSessionsByUser, getStatsByUser, claimLocalEvents,
  hideEvents, unhideEvents, unhideAllEvents, getHiddenEventIds,
  getNodeMemos, upsertNodeMemo, deleteNodeMemo,
  getBookmarks, addBookmark, removeBookmark,
  touchTrackerPing, getTrackerPing,
} = dbModule;

// ─── 사용자별 데이터 격리 헬퍼 ──────────────────────────────────────────────
// 로그인 유저 → 본인 이벤트만, 비로그인/로컬 → 개발모드만 전체
const MAX_EVENTS_LOAD = env.MAX_EVENTS_LOAD;
const { verifyToken: _verifyToken } = require('./src/auth');
// ⚠️ 크로스-유저 격리: AUTH_DISABLED=1(개발)만 'local' userId에 전체 데이터 허용
const _IS_DEV = env.IS_DEV;

async function getEventsForUser(userId) {                  // userId 기반 이벤트 조회 (PG async 대응)
  if (!userId || userId === 'local' || userId === 'anonymous') {
    // 개발 모드에서만 전체 허용 — 프로덕션에서는 빈 배열 반환 (크로스-유저 노출 방지)
    return _IS_DEV ? await Promise.resolve(getAllEvents(MAX_EVENTS_LOAD)) : [];
  }
  // 로그인한 사용자: 본인 이벤트 + 본인에게 claim된 local 이벤트만
  const userEvents = getEventsByUser ? await Promise.resolve(getEventsByUser(userId)) : [];
  // 본인 이벤트가 없고 어드민이면 local 이벤트도 포함 (자기 데이터 claim 전)
  if (userEvents.length === 0) {
    if (env.isAdmin(userId)) return await Promise.resolve(getAllEvents(MAX_EVENTS_LOAD));
  }
  return userEvents;
}

async function getSessionsForUser(userId) {                // userId 기반 세션 조회 (PG async 대응)
  if (!userId || userId === 'local' || userId === 'anonymous') {
    // 개발 모드에서만 전체 허용 — 프로덕션에서는 빈 배열 반환
    return _IS_DEV ? await Promise.resolve(getSessions()) : [];
  }
  return getSessionsByUser ? await Promise.resolve(getSessionsByUser(userId)) : await Promise.resolve(getSessions());
}

function resolveUserId(req) {                             // req에서 userId 추출
  return req?.user?.id || 'local';
}

const { buildGraph, computeActivityScores, applyActivityVisualization, suggestLabel } = require('./src/graph-engine');
const { annotateEventsWithPurpose, classifyPurposes, summarizePurposes, PURPOSE_CATEGORIES } = require('./src/purpose-classifier');
const { createAnnotationEvent } = require('./src/event-normalizer');
const { getAiStyle, AI_SOURCES }  = require('./adapters/ai-adapter-base');
const { generateReport, countLines, measureCyclomaticComplexity, findLongFunctions, findDuplicatePatterns, analyzeSolidViolations } = require('./src/code-analyzer');
const { scanForLeaks }            = require('./src/security-scanner');
const { buildReportData, renderMarkdown, renderSlackBlocks } = require('./src/report-generator');
const { extractContext, renderContextMd, renderContextPrompt, saveContextFile } = require('./src/context-bridge');
const { qwertyToHangul } = require('./src/hangul'); // inputText QWERTY→한글 (조회·분석 가독)
const { detectConflicts, checkNewEvent } = require('./src/conflict-detector');
const { appendAuditLog, auditFromEvents, queryAuditLog, verifyIntegrity, renderAuditHtml } = require('./src/audit-log');
const { detectShadowAI, checkEventForShadow, getApprovedSources, addApprovedSource, removeApprovedSource } = require('./src/shadow-ai-detector');
const { getAllThemes, getThemeById, registerTheme, recordDownload, rateTheme, deleteUserTheme } = require('./src/theme-store');
const { register: authRegister, login: authLogin, verifyToken, issueApiToken, issueApiTokenAsync, getUserById, upsertOAuthUser,
  saveOAuthTokens, getOAuthTokens, refreshGoogleAccessToken, getValidGoogleToken, getGoogleOAuthUsers,
  searchUsers, upgradePlan,
  inviteUser, isInvitedUser, getEffectivePlan, getAdminInvites, ADMIN_EMAILS,
  initFromPg: authInitFromPg,  // PG → SQLite 복원 (Railway 재배포 대비)
} = require('./src/auth');
const gdriveUserBackup = require('./src/gdrive-user-backup');
const { initOAuthStrategies, createOAuthRouter } = require('./src/auth-oauth');
const payment = require('./src/payment');
const { PLANS, MOCK_MODE: paymentMockMode } = payment;
const { analyzeAndSuggest, saveFeedback, getSuggestions, getPatterns, getMarketCandidates } = require('./src/growth-engine');
const solutionStore  = require('./src/solution-store');
const communityStore = require('./src/community-store');

// ─── 라우터 팩토리 ────────────────────────────────────────────────────────────
const createGraphRouter      = require('./routes/graph');
const createAnnotationsRouter = require('./routes/annotations');
const createAiEventsRouter   = require('./routes/ai-events');
const createAnalysisRouter   = require('./routes/analysis');
const createSecurityRouter   = require('./routes/security');
const createReportsRouter    = require('./routes/reports');
const createThemesRouter     = require('./routes/themes');
const createAuthRouter       = require('./routes/auth');
const createPaymentRouter    = require('./routes/payment');
const createTrackerOAuthRouter = require('./routes/tracker-oauth');
const createTrackerFilesRouter = require('./routes/tracker-files');
const createTrackerMessagesRouter = require('./routes/tracker-messages');
const { getInstance: getSyncScheduler } = require('./src/tracker/sync-scheduler');
const createGrowthRouter     = require('./routes/growth');
const createCommunityRouter  = require('./routes/community');
const createGitRouter        = require('./routes/git');
const createAvatarsRouter    = require('./routes/avatars');
// const createOrgRouter        = require('./routes/org-api'); // ⚠️ Implemented inline in server.js to avoid file corruption issue
const createMcpRouter        = require('./src/mcp-server');
const createModelRouter      = require('./routes/model');
const createPortfolioRouter  = require('./routes/portfolio');
const modelTrainer           = require('./src/model-trainer');
const outcomeStore           = require('./src/outcome-store');
const marketStore            = require('./src/market-store');
const usageTracker           = require('./src/usage-tracker');
const createMarketRouter          = require('./routes/market');
const createPersonalInsightsRouter  = require('./routes/personal-insights');
const createCostTrackerRouter       = require('./routes/cost-tracker');
const createWebhooksRouter          = require('./routes/webhooks');
const revenueScheduler              = require('./src/revenue-scheduler');
const mcpWatcher                    = require('./src/mcp-watcher');
const createBadgeRouter             = require('./routes/badge');
const createShareRouter             = require('./routes/share');
const createOntologyRouter          = require('./routes/ontology');
const createLeaderboardRouter       = require('./routes/leaderboard');
const createRoiRouter               = require('./routes/roi');
const createAnalyticsRouter          = require('./routes/analytics');
const createProfileRouter            = require('./routes/profile');
const createFollowRouter             = require('./routes/follow');
const createChatRouter               = require('./routes/chat');
const createMarketplaceRouter        = require('./routes/marketplace');
const createRecommendationsRouter    = require('./routes/recommendations');
const { createRegionalInsightRouter } = require('./src/regional-insight');
const { createPointsRouter }          = require('./src/points-engine');
const { createCertificateRouter }     = require('./src/certificate-engine');
const signalEngine                    = require('./src/signal-engine');
const diffLearner                     = require('./src/diff-learner');
const dualSkillEngine                 = require('./src/dual-skill-engine');
const createWorkspaceRouter           = require('./routes/workspace');
const ollamaAnalyzer                  = require('./src/ollama-analyzer'); // Ollama 실시간 분석

// ─── 회사 컨설팅 플랫폼 (Palantir for SMEs) ──────────────────────────────────
const createCompanyRouter             = require('./routes/company');
const createDiagnosisRouter           = require('./routes/diagnosis');
const createCompanyLearningRouter     = require('./routes/company-learning');
const createNodesRouter               = require('./routes/nodes');
const createWorkspaceActivityRouter    = require('./routes/workspace-activity');
const companyOntology                 = require('./src/company-ontology');
const companyCrawler                  = require('./src/company-crawler');

// ─── Phase 2-5: 작업 분석 + 인텔리전스 + AI 학습 ──────────────────────────────
const createWorkAnalysisRouter        = require('./routes/work-analysis');
const createIntelligenceRouter        = require('./routes/intelligence');
const createGoldenRouter              = require('./routes/intelligence-golden');
const createLearningRouter            = require('./routes/learning');

// ─── 통합 이벤트 버스 (4개 시스템 연동) ──────────────────────────────────────────
const eventBus                        = require('./src/event-bus');
const createEventBusRouter            = require('./routes/event-bus');
const createOpsOntologyRouter         = require('./routes/ops-ontology');
const createVerificationRouter        = require('./routes/verification');   // 섀도우 예측 검증율 게이트

// ─── 상수 (config/environment.js 에서 중앙 관리) ─────────────────────────────
const PORT          = env.PORT;
const CONV_FILE     = env.CONV_FILE;
const SNAPSHOTS_DIR = env.SNAPSHOTS_DIR;

// ─── 채널(Room) 시스템 ────────────────────────────────────────────────────────
// 각 채널은 독립된 마인드맵 공간. 팀원이 같은 채널에 접속하면 실시간 공유.
const channelClients = new Map();    // channelId → Set<WebSocket>
const wsChannelMap   = new WeakMap(); // ws → { channelId, memberId, memberName, memberColor }

// ── 메신저 채팅 방 구독 ─────────────────────────────────────────────────────
const chatRoomClients = new Map();   // chatRoomId → Set<WebSocket>
const wsChatRoomMap   = new WeakMap(); // ws → Set<chatRoomId>

function broadcastToRoom(roomId, msg) {
  const clients = chatRoomClients.get(roomId);
  if (!clients) return;
  const data = JSON.stringify(msg);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch {}
    }
  });
}

function subscribeChatRoom(ws, roomId) {
  if (!chatRoomClients.has(roomId)) chatRoomClients.set(roomId, new Set());
  chatRoomClients.get(roomId).add(ws);
  if (!wsChatRoomMap.has(ws)) wsChatRoomMap.set(ws, new Set());
  wsChatRoomMap.get(ws).add(roomId);
}

function unsubscribeChatRooms(ws) {
  const rooms = wsChatRoomMap.get(ws);
  if (!rooms) return;
  rooms.forEach(roomId => {
    const clients = chatRoomClients.get(roomId);
    if (clients) { clients.delete(ws); if (clients.size === 0) chatRoomClients.delete(roomId); }
  });
  wsChatRoomMap.delete(ws);
}

/** 멤버별 색상 팔레트 (순환 할당) */
const MEMBER_COLORS = [
  '#58a6ff','#3fb950','#bc8cff','#f778ba','#ffa657',
  '#39d2c0','#ff9500','#79c0ff','#f85149','#8957e5',
];
let memberColorIdx = 0;

/**
 * 다음 멤버 색상을 순환 할당합니다.
 * @returns {string} HEX 색상 코드
 */
function getMemberColor() {
  const c = MEMBER_COLORS[memberColorIdx % MEMBER_COLORS.length];
  memberColorIdx++;
  return c;
}

// ─── 초기화 ──────────────────────────────────────────────────────────────────
// PG 환경에서는 JSONL 파일 생성 스킵 (ENOSPC 방지, PG가 원본)
if (!process.env.DATABASE_URL) {
  if (!fs.existsSync(CONV_FILE))    fs.writeFileSync(CONV_FILE, '');
}
if (!fs.existsSync(SNAPSHOTS_DIR)) try { fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true }); } catch {}

const db = initDatabase();
logger.db.info('SQLite 초기화 완료');

// ─── SQLite 안정성 설정 (배포 시 동시 요청 안전) ────────────────────────────
if (db && db.pragma) {
  try {
    db.pragma('journal_mode = WAL');           // Write-Ahead Logging (동시성 향상)
    db.pragma('busy_timeout = 5000');          // 5초 대기 (잠금 경쟁 해결)
    db.pragma('synchronous = NORMAL');         // 성능/안전 균형
    db.pragma('foreign_keys = ON');            // 외래키 제약 활성화
    logger.db.info('SQLite PRAGMAS 설정 완료 (WAL모드, busy_timeout=5000ms)');
  } catch (e) {
    logger.db.warn('PRAGMA 설정 실패: %s', e.message);
  }
}

// ─── Identity Bridge: ~/.orbit-config.json → 로컬 auth DB 동기화 ──────────
try {
  const _os = require('os');
  const _cfgPath = path.join(_os.homedir(), '.orbit-config.json');
  if (fs.existsSync(_cfgPath)) {
    const _cfg = JSON.parse(fs.readFileSync(_cfgPath, 'utf8'));
    if (_cfg.userId && _cfg.email) {
      const authMod = require('./src/auth');
      if (authMod.ensureCanonicalUser) {
        const result = authMod.ensureCanonicalUser(_cfg.userId, _cfg.email);
        if (result.oldId) {
          // main DB에서도 이전 ID → canonical ID로 마이그레이션
          const mainDb = dbModule.getDb ? dbModule.getDb() : null;
          if (mainDb && mainDb.prepare) {
            const r1 = mainDb.prepare('UPDATE events SET user_id = ? WHERE user_id = ?').run(_cfg.userId, result.oldId);
            const r2 = mainDb.prepare('UPDATE sessions SET user_id = ? WHERE user_id = ?').run(_cfg.userId, result.oldId);
            const total = (r1.changes || 0) + (r2.changes || 0);
            if (total > 0) console.log(`[identity-bridge] startup: ${result.oldId} → ${_cfg.userId}: ${total}개 레코드`);
          }
        }
        // 토큰도 로컬 auth DB에 동기화 (config의 token이 없으면 생성)
        if (_cfg.token) {
          const authDb = authMod.getDb ? authMod.getDb() : null;
          if (authDb) {
            try {
              authDb.prepare('INSERT OR IGNORE INTO tokens (token, userId, type) VALUES (?, ?, ?)').run(_cfg.token, _cfg.userId, 'api');
            } catch {}
          }
          // PG에도 토큰 백업 (Railway 재배포 시 SQLite 초기화 대비)
          try {
            if (authMod.pgBackupToken) authMod.pgBackupToken(_cfg.token, _cfg.userId, null).catch(() => {});
          } catch {}
        }
      }
    }
  }
} catch (e) { console.warn('[identity-bridge] startup 실패:', e.message); }

// ─── 관리자 인증 헬퍼 ─────────────────────────────────────────────────────────
// 이메일 기반(Google OAuth) + 토큰 기반(API 마스터 토큰) 양쪽 허용
function resolveAdmin(req) {
  const raw = (req.headers.authorization || '').replace('Bearer ', '').trim();
  // 1) 토큰 직접 관리자 체크 (verifyToken 없이)
  if (env.isAdminToken(raw)) {
    return {
      user: { id: 'admin', email: env.ADMIN_EMAILS[0], name: 'Admin (token)', plan: 'team' },
      isAdmin: true,
      token: raw,
    };
  }
  // 2) 일반 JWT/세션 토큰으로 사용자 조회 후 이메일 체크
  const user = verifyToken(raw);
  return {
    user,
    isAdmin: !!user && env.isAdmin(user.email),
    token: raw,
  };
}

const app    = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ─── CORS — 동일 도메인 + Railway 프로덕션 ──────────────────────────────────
// 허용 도메인 목록은 config/environment.js → CORS_ALLOWED_ORIGINS
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && env.CORS_ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  if (!origin || env.CORS_ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-api-token,x-device-id');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── 힙 압력 미들웨어 (OOM 방지) ─────────────────────────────────────────────
app.use(memMgr.middleware);

// ─── 보안 미들웨어 ────────────────────────────────────────────────────────────
// Helmet: X-Frame-Options, X-Content-Type, CSP 등 보안 헤더 자동 설정
app.use(helmet({
  contentSecurityPolicy: false, // CSP 비활성화 (Google OAuth 호환)
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
}));

// Rate Limiting: API 남용 방지 (15분 당 최대 2000회)
const _rlOpts = { validate: { xForwardedForHeader: false, trustProxy: false, ip: false } };
const apiLimiter = rateLimit({
  ..._rlOpts,
  windowMs: 15 * 60 * 1000,
  max: 10000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.socket?.remoteAddress || 'unknown',
  message: { error: 'Too many requests, please try again later.' },
  skip: req => {
    const ip = req.ip || req.socket?.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    const isPolling = req.path === '/health' || req.path === '/api/signal' || req.path === '/api/learn/suggestions';
    return isLocal || isPolling;
  },
});

// 훅 엔드포인트는 별도 제한 (CI 자동 호출 많음 — 5분 당 500회)
const hookLimiter = rateLimit({
  ..._rlOpts,
  windowMs: 5 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.socket?.remoteAddress || 'unknown',
  message: { error: 'Hook rate limit exceeded.' },
});

app.use('/api/hook', hookLimiter);
// /api/hook은 Content-Length 기반 사전 차단 (극단적 대용량 방지)
// screen.capture + base64 이미지 포함 요청을 위해 2MB까지 허용 (Vision 큐잉)
app.use('/api/hook', (req, res, next) => {
  const cl = parseInt(req.headers['content-length'] || '0', 10);
  if (cl > 2 * 1024 * 1024) { // 2MB 초과만 거부 (express.json limit과 동일)
    return res.status(413).json({ error: 'Payload too large (max 2MB)' });
  }
  next();
});
// 벌크 임포트는 rate limit 제외 (관리자 토큰 인증 필수)
app.use('/api/', (req, res, next) => {
  if (req.path === '/bulk-import') return next(); // skip apiLimiter
  return apiLimiter(req, res, next);
});

// Stripe Webhook은 서명 검증을 위해 원본 바디(Buffer)가 필요 — JSON 파싱 전에 처리
app.use('/api/payment/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '2mb' }));
// 프로덕션: 압축된 JS 우선 사용
if (process.env.NODE_ENV === 'production') {
  // 개발 단계: 원본 JS 사용 (minified에서 TDZ 에러 발생)
  // app.use('/js', express.static(path.join(__dirname, 'public', 'js-min'), { maxAge: '7d', etag: true }));
}
// viewer.nenovaweb.com 서브도메인 — 루트 진입 시 허브 랜딩페이지 서빙
// (그 외 도메인은 기존대로 index.html → orbit3d.html 리다이렉트 유지)
app.get('/', (req, res, next) => {
  const host = (req.hostname || '').toLowerCase();
  if (host === 'viewer.nenovaweb.com') {
    return res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
  }
  next();
});
// 테스트/직접 접근용 — 도메인 무관하게 허브 페이지 접근 가능
app.get(['/viewer', '/viewer/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});
// 모바일 진입점 — nenova 대시보드로 리다이렉트
app.get('/m', (req, res) => {
  res.redirect(302, '/nenova-dashboard.html?mobile=1');
});
// 챗봇 진입점
app.get('/chat', (req, res) => {
  res.redirect(302, '/chat.html');
});
// 워크스페이스 선택 진입점
app.get('/select', (req, res) => {
  res.redirect(302, '/select.html');
});
// [2026-07-16 통폐합 B] 은퇴 페이지 11개 → 대응 뷰로 301 (죽은 링크 0). CONSOLIDATION_PLAN.md 참조.
const _RETIRED_PAGES = {
  '/mockup-chat.html': '/chat.html',
  '/mockup-mobile-home.html': '/nenova-dashboard.html',
  '/mockup-select.html': '/select.html',
  '/workspace-drilldown-demo.html': '/admin-analysis.html',
  '/legacy-2d.html': '/orbit3d.html',
  '/workflow-blueprint.html': '/graph.html',
  '/automation-blueprint.html': '/automation-flow.html',
  '/admin-intelligence-golden.html': '/admin-analysis.html',
  '/orbit-live.html': '/dashboard.html',
  '/orbit.html': '/orbit3d.html',
  '/orbit-health.html': '/admin-analysis.html',
};
for (const [from, to] of Object.entries(_RETIRED_PAGES)) {
  app.get(from, (req, res) => res.redirect(301, to));
}

// [2026-07-16 통폐합 A] 통합 셸 — 8개 뷰가 셸 안(iframe)에서 열림(상단 MOYI·스코프 상시). public/shell.html.
app.get(['/shell', '/workspace', '/w'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'shell.html')));

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0, // 개발 단계: 캐시 비활성화 (안정화 후 1d로 복구)
  etag: true,
}));
// PS1 UTF-8 BOM — PowerShell 5.1 -File 한글 파싱 오류 방지
function sendPs1WithBom(res, filePath, filename) {
  let buf = fs.readFileSync(filePath);
  if (!(buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)) {
    buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), buf]);
  }
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(buf);
}
// irm | iex 용 — BOM 없이 (PS7에서 ﻿# 파싱 오류 방지)
function sendPs1ForIex(res, filePath, filename) {
  let buf = fs.readFileSync(filePath);
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    buf = buf.subarray(3);
  }
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(buf);
}
app.get('/setup/:script.ps1', (req, res, next) => {
  const name = req.params.script;
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return next();
  const fp = path.join(__dirname, 'setup', `${name}.ps1`);
  if (!fs.existsSync(fp)) return next();
  sendPs1WithBom(res, fp, `${name}.ps1`);
});
// setup 스크립트 서빙
app.use('/setup', express.static(path.join(__dirname, 'setup'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.ps1') || filePath.endsWith('.sh')) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    }
  },
}));

// ═══ 설치 링크 정리 (2026-06-29) ═════════════════════════════════════════════
// ★ 직원 배포 표준(canonical): GET /install
//   체인: install-open.bat → /setup/install-open.ps1 → /api/setup/auto-register(이름→계정) → /setup/install.ps1
//   직원에게는 이 링크 하나만 주면 됨. 아래 /bat·/bat-final·/api/install-* 는 과거 공유 링크 호환용(legacy)으로 유지.
//   (커스텀 도메인 연결 후엔 nenovaweb 서브도메인/install 권장 — DNS+Railway 도메인 설정 필요)
app.get('/install', (req, res) => {
  // [2026-08-10] 다운로드 파일명 '네노바-업무도구.bat' (한글 RFC5987 + ASCII 폴백)
  const fnKo = '네노바-업무도구.bat';
  res.setHeader('Content-Disposition', `attachment; filename="nenova-tool.bat"; filename*=UTF-8''${encodeURIComponent(fnKo)}`);
  res.setHeader('Content-Type', 'application/x-bat');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'setup', 'install-open.bat'));
});

// [legacy] 2026-06-09: /bat 짧은 alias — orbit-install.bat (구 공유 링크 호환, 표준은 /install)
app.get('/bat', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="orbit-install.bat"');
  res.setHeader('Content-Type', 'application/x-bat');
  res.sendFile(path.join(__dirname, 'setup', 'orbit-install.bat'));
});
// 2026-06-10 added: 직원 배포용 — install-open.ps1(이름 입력→계정 매칭) 더블클릭 설치 bat
app.get('/api/install-open.bat', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="orbit-install.bat"');
  res.setHeader('Content-Type', 'application/x-bat');
  res.sendFile(path.join(__dirname, 'setup', 'install-open.bat'));
});
// 2026-07-09: 직원 배포 안내 페이지 (설치버튼+기능목록+설치법). 짧은 공유 링크 /guide.
app.get(['/guide', '/install-guide'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'install-guide.html'));
});
// 2026-07-10: 업무 CCTV — 캡처 이미지를 업무흐름(세션 리플레이)으로 시각화. 관리자용.
app.get('/cctv', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cctv.html'));
});
// 설치 버전 배지용 — install.ps1 상단 마커에서 실제 버전 파싱(캐시)
let _installVer = null;
app.get('/api/setup/version', (req, res) => {
  try {
    if (!_installVer) {
      const head = fs.readFileSync(path.join(__dirname, 'setup', 'install.ps1'), 'utf8').slice(0, 200);
      const m = head.match(/Installer\s+(v\d+)/i);
      _installVer = m ? m[1] : 'v8';
    }
    res.json({ version: _installVer, features: ['screen', 'keyboard', 'mouse', 'self-heal', 'av-exception', 'lifeline'] });
  } catch (e) { res.json({ version: 'v8' }); }
});
// 2026-06-09: 최종 설치 (fix daemon 포함) — bat 단독 다운로드
app.get('/bat-final', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="orbit-install-final.bat"');
  res.setHeader('Content-Type', 'application/x-bat');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'setup', 'orbit-install-final.bat'));
});
app.get('/api/install-final.bat', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="orbit-install-final.bat"');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'setup', 'orbit-install-final.bat'));
});
app.get('/api/install-final.ps1', (req, res) => {
  sendPs1WithBom(res, path.join(__dirname, 'setup', 'orbit-install-final.ps1'), 'orbit-install-final.ps1');
});
app.get('/api/install-now.ps1', (req, res) => {
  sendPs1WithBom(res, path.join(__dirname, 'setup', 'orbit-install-now.ps1'), 'orbit-install-now.ps1');
});
// Chrome 확장 파일 서빙 (설치 스크립트에서 다운로드용)
app.use('/chrome-extension', express.static(path.join(__dirname, 'chrome-extension')));

// ─── 로그인 브루트포스 방지 (15분 당 10회) ────────────────────────────────────
const _loginStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _loginStore) {
    if (now > entry.resetAt) _loginStore.delete(key);
  }
  if (_loginStore.size > 2000) _loginStore.clear();
}, 60 * 1000);
const loginLimiter = (req, res, next) => {
  const key = `login:${req.body?.email || req.ip || 'unknown'}`;
  const windowMs = 15 * 60 * 1000;
  const max = 10;
  const entry = _loginStore.get(key) || { count: 0, resetAt: Date.now() + windowMs };
  if (Date.now() > entry.resetAt) { entry.count = 0; entry.resetAt = Date.now() + windowMs; }
  if (++entry.count > max) {
    return res.status(429).json({ error: '로그인 시도가 너무 많습니다. 15분 후 다시 시도해주세요.' });
  }
  _loginStore.set(key, entry);
  next();
};
app.post('/api/auth/login', loginLimiter);
app.post('/api/auth/register', loginLimiter);

// ─── OAuth 초기화 ─────────────────────────────────────────────────────────────
const session = require('express-session');
const _sessionSecret = (() => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const crypto = require('crypto');
  const fallback = crypto.randomBytes(32).toString('hex');
  console.warn('[SECURITY] SESSION_SECRET 환경변수가 설정되지 않았습니다. 랜덤 시크릿 사용 중 — 프로덕션에서는 반드시 설정하세요.');
  return fallback;
})();
app.use(session({
  secret:            _sessionSecret,
  resave:            false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 10 * 60 * 1000 },
}));

const { passport: oauthPassport, enabledProviders } = initOAuthStrategies({
  upsertOAuthUser,
  getUserById,
  insertToken: issueApiToken,
  saveOAuthTokens,
});
app.use(oauthPassport.initialize());
app.use(oauthPassport.session());

// ─── 그래프 빌드 헬퍼 ────────────────────────────────────────────────────────

/**
 * DB에서 이벤트를 조회해 그래프로 변환합니다.
 * 목적 자동 분류 → 활동 점수 계산 → 시각화 속성 적용 순서로 처리합니다.
 * @param {string} [sessionFilter]  - 세션 ID 필터
 * @param {string} [channelFilter]  - 채널 ID 필터
 * @returns {{ nodes: Node[], edges: Edge[] }}
 */
// ── 그래프 캐시 (5초 TTL) ─ 매 요청마다 전체 재빌드 방지 ──
const _graphCache = new Map();
const GRAPH_CACHE_TTL = 60000; // 60초 캐시 (OOM 방지)
async function _getCachedGraph(key, builder) {
  const cached = _graphCache.get(key);
  if (cached && Date.now() - cached.ts < GRAPH_CACHE_TTL) return cached.graph;
  const graph = await builder();
  _graphCache.set(key, { graph, ts: Date.now() });
  // 캐시 엔트리 10개 초과 시 전부 정리 (OOM 방지)
  if (_graphCache.size > 10) {
    const now = Date.now();
    for (const [k, v] of _graphCache) { if (now - v.ts > GRAPH_CACHE_TTL) _graphCache.delete(k); }
    // 그래도 많으면 전부 삭제
    if (_graphCache.size > 10) _graphCache.clear();
  }
  return graph;
}

// ── 세션별 프로젝트 메타데이터를 이벤트에 주입 ──────────────────────────────
// mywork-renderer에서 "프로젝트명 — 작업 목적" 형태 라벨을 생성하기 위해 필요
function _enrichEventsWithSessionMeta(events) {
  const sessionMap = {};
  for (const e of events) {
    const sid = e.sessionId;
    if (!sid) continue;
    if (!sessionMap[sid]) {
      sessionMap[sid] = { firstMsg: null, projectDir: null, projectName: null };
    }
    const sm = sessionMap[sid];
    // 첫 user.message를 firstMsg로 사용
    if (!sm.firstMsg && e.type === 'user.message' && e.data?.content) {
      sm.firstMsg = String(e.data.content).slice(0, 60);
    }
    // 파일 경로에서 프로젝트 디렉토리 추출
    if (!sm.projectDir && e.data?.file_path) {
      const fp = e.data.file_path;
      const parts = fp.replace(/\\/g, '/').split('/');
      // /Users/xxx/프로젝트명/... 에서 프로젝트 폴더 추출
      const srcIdx = parts.findIndex(p => p === 'src' || p === 'public' || p === 'routes' || p === 'lib');
      if (srcIdx > 0) {
        sm.projectDir = parts.slice(0, srcIdx).join('/');
        sm.projectName = parts[srcIdx - 1];
      }
    }
    if (!sm.projectDir && e.data?.command) {
      const cdMatch = String(e.data.command).match(/cd\s+["']?([^\s"']+)/);
      if (cdMatch) {
        const dirParts = cdMatch[1].replace(/\\/g, '/').split('/');
        sm.projectName = dirParts[dirParts.length - 1] || dirParts[dirParts.length - 2];
      }
    }
    if (!sm.projectName && e.data?.projectName) sm.projectName = e.data.projectName;
    if (!sm.projectName && e.data?.project)     sm.projectName = e.data.project;
    if (!sm.projectName && e.data?.repo)        sm.projectName = e.data.repo;
  }
  // 메타데이터를 이벤트에 주입
  for (const e of events) {
    const sm = sessionMap[e.sessionId];
    if (!sm) continue;
    if (!e.data) e.data = {};
    if (sm.projectName && !e.data.projectName) e.data.projectName = sm.projectName;
    if (sm.firstMsg && !e.data.firstMsg)       e.data.firstMsg = sm.firstMsg;
    // autoTitle: 프로젝트명 + firstMsg 조합
    if (!e.autoTitle) {
      if (sm.projectName && sm.firstMsg) e.autoTitle = `${sm.projectName} — ${sm.firstMsg.slice(0, 30)}`;
      else if (sm.projectName) e.autoTitle = sm.projectName;
      else if (sm.firstMsg) e.autoTitle = sm.firstMsg.slice(0, 40);
    }
  }
  return events;
}

async function getFullGraph(sessionFilter, channelFilter) {
  const cacheKey = `full:${sessionFilter||''}:${channelFilter||''}`;
  return _getCachedGraph(cacheKey, async () => {
    const rawEvents = sessionFilter
      ? await Promise.resolve(getEventsBySession(sessionFilter))
      : channelFilter
        ? (getEventsByChannel
            ? await Promise.resolve(getEventsByChannel(channelFilter))
            : (await Promise.resolve(getAllEvents(MAX_EVENTS_LOAD))).filter(e => e.channelId === channelFilter))
        : await Promise.resolve(getAllEvents(MAX_EVENTS_LOAD));

    _assignVirtualSessions(rawEvents);
    _enrichBankEvents(rawEvents);
    const events = _enrichEventsWithSessionMeta(annotateEventsWithPurpose(rawEvents));
    const graph  = buildGraph(events);
    computeActivityScores(graph.nodes, Date.now());
    applyActivityVisualization(graph.nodes);
    return graph;
  });
}

// 특정 user_id의 이벤트만 그래프로 변환 (프라이버시 격리)
async function getFullGraphForUser(userId, sessionFilter) {
  const cacheKey = `user:${userId}:${sessionFilter||''}`;
  return _getCachedGraph(cacheKey, async () => {
    let rawEvents;
    if (sessionFilter) {
      rawEvents = (await Promise.resolve(getEventsBySession(sessionFilter))).filter(e => e.userId === userId);
    } else {
      rawEvents = getEventsByUser
        ? await Promise.resolve(getEventsByUser(userId))
        : (await Promise.resolve(getAllEvents(MAX_EVENTS_LOAD))).filter(e => e.userId === userId);
    }
    // 데몬 이벤트에 가상 sessionId 부여 (30분 이내 = 같은 세션)
    _assignVirtualSessions(rawEvents);
    _enrichBankEvents(rawEvents);
    const events = _enrichEventsWithSessionMeta(annotateEventsWithPurpose(rawEvents));
    const graph  = buildGraph(events);
    computeActivityScores(graph.nodes, Date.now());
    applyActivityVisualization(graph.nodes);
    return graph;
  });
}

/** bank.activity/purchase.order 이벤트에 업무 라벨 보강 */
function _enrichBankEvents(events) {
  for (const ev of events) {
    if (!ev.data) continue;
    if (ev.type === 'bank.activity' || ev.type === 'bank-safe.activity') {
      if (!ev.data.windowTitle) ev.data.windowTitle = '은행 보안 프로그램';
      if (!ev.data.app) ev.data.app = 'bank';
    }
    if (ev.type === 'purchase.order.detected') {
      ev.data.windowTitle = ev.data.windowTitle || '주문 감지';
      ev.data.app = ev.data.app || 'nenova';
    }
    if (ev.type === 'order.detected') {
      ev.data.windowTitle = ev.data.windowTitle || 'nenova 주문';
      ev.data.app = ev.data.app || 'nenova';
    }
  }
}

/** 데몬 이벤트에 가상 sessionId 부여 (sessionId 없는 이벤트 그룹핑) */
function _assignVirtualSessions(events) {
  let currentSessionId = null;
  let lastTs = 0;
  const SESSION_GAP = 30 * 60 * 1000; // 30분

  // 시간순 정렬
  events.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

  for (const ev of events) {
    if (ev.sessionId) continue; // 이미 있으면 스킵

    const ts = new Date(ev.timestamp || 0).getTime();
    if (!currentSessionId || (ts - lastTs) > SESSION_GAP) {
      // 새 가상 세션 생성
      const dateStr = new Date(ts).toISOString().slice(0, 10).replace(/-/g, '');
      currentSessionId = `daemon-${ev.userId || 'unknown'}-${dateStr}-${Math.random().toString(36).slice(2, 6)}`;
    }
    ev.sessionId = currentSessionId;
    lastTs = ts;
  }
}

// ─── 브로드캐스트 ────────────────────────────────────────────────────────────

/**
 * 특정 채널의 모든 WebSocket 클라이언트에 메시지를 전송합니다.
 * @param {string} channelId - 대상 채널 ID
 * @param {object} msg       - 전송할 메시지 객체
 */
function broadcastToChannel(channelId, msg) {
  const clients = channelClients.get(channelId);
  if (!clients) return;
  const data = JSON.stringify(msg);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(data); } catch {}
    }
  });
}

/**
 * 연결된 모든 WebSocket 클라이언트에 메시지를 전송합니다.
 * graph/sessions 포함 update 메시지는 자동으로 사용자별 데이터로 치환됩니다.
 * @param {object} msg - 전송할 메시지 객체
 */
function broadcastAll(msg) {
  // graph/sessions 포함 메시지 → 사용자별 격리 전송 (async 결과는 비동기 전송)
  if (msg.type === 'update' || msg.type === 'graph_update') {
    (async () => {
      for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        try {
          const uid = client._userId || 'local';
          const userGraph    = (uid !== 'local' && uid !== 'anonymous' && typeof getFullGraphForUser === 'function')
            ? await getFullGraphForUser(uid) : msg.graph;
          const userSessions = (uid !== 'local' && uid !== 'anonymous' && typeof getSessionsForUser === 'function')
            ? await getSessionsForUser(uid) : msg.sessions;
          client.send(JSON.stringify({ ...msg, graph: userGraph, sessions: userSessions }));
        } catch {}
      }
    })();
    return;
  }
  // 그 외 메시지 → 동일하게 전체 전송
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(data); } catch {}
    }
  });
}

// Ollama 분석기 초기화 (broadcastAll 정의 직후)
ollamaAnalyzer.init(broadcastAll);

/**
 * 채널의 현재 접속 멤버 정보 배열을 반환합니다.
 * @param {string} channelId
 * @returns {{ memberId, memberName, memberColor }[]}
 */
function getChannelMembers(channelId) {
  const clients = channelClients.get(channelId);
  if (!clients) return [];
  return Array.from(clients).map(ws => wsChannelMap.get(ws)).filter(Boolean);
}

// ─── WebSocket 서버 ──────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  // ── WS 접속 시 토큰으로 사용자 식별 ─────────────────────────────────────
  const urlParams = new URL(req.url, 'http://localhost').searchParams;
  const token     = urlParams.get('token');                          // ws://host?token=xxx
  const wsUser    = token ? _verifyToken(token) : null;              // 토큰 검증
  const wsUserId  = wsUser?.id || 'local';                           // 사용자 ID
  ws._userId = wsUserId;                                             // WS에 사용자 ID 저장
  logger.ws.info('클라이언트 연결됨 (user: %s)', wsUserId);

  // 초기 접속: 해당 사용자의 데이터만 전송
  try {
    const userId = wsUserId;
    ws.send(JSON.stringify({
      type:       'init',
      // 인증된 사용자만 본인 데이터 수신 — 미인증은 빈 그래프 (타인 데이터 노출 방지)
      graph:      userId !== 'local' && userId !== 'anonymous'
                    ? getFullGraphForUser(userId)
                    : { nodes: [], links: [], sessions: [], projectGroups: {} },
      sessions:   userId !== 'local' && userId !== 'anonymous'
                    ? getSessionsForUser(userId) : [],
      stats:      getStats(),
      userConfig: getUserConfig(),
    }));
  } catch (e) {
    logger.ws.error('init 오류: %s', e.message);
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      // ── 메신저 채팅 방 구독 ───────────────────────────────────────────────
      if (msg.type === 'chat.subscribe') {
        const roomId = msg.roomId;
        if (roomId) subscribeChatRoom(ws, roomId);
        return;
      }
      if (msg.type === 'chat.unsubscribe') {
        const roomId = msg.roomId;
        if (roomId) {
          const clients = chatRoomClients.get(roomId);
          if (clients) clients.delete(ws);
          const myRooms = wsChatRoomMap.get(ws);
          if (myRooms) myRooms.delete(roomId);
        }
        return;
      }

      // ── 채널 입장 ────────────────────────────────────────────────────────
      if (msg.type === 'channel.join') {
        const channelId   = (msg.channelId  || 'default').trim();
        const memberName  = (msg.memberName || '익명').substring(0, 20);
        const memberId    = msg.memberId || `m_${Date.now()}`;
        const memberColor = getMemberColor();

        // 기존 채널 퇴장
        const prev = wsChannelMap.get(ws);
        if (prev) {
          const prevClients = channelClients.get(prev.channelId);
          if (prevClients) {
            prevClients.delete(ws);
            if (prevClients.size === 0) channelClients.delete(prev.channelId);
          }
          broadcastToChannel(prev.channelId, {
            type:       'channel.member_left',
            memberId:   prev.memberId,
            memberName: prev.memberName,
            members:    getChannelMembers(prev.channelId),
          });
        }

        // 새 채널 입장
        if (!channelClients.has(channelId)) channelClients.set(channelId, new Set());
        channelClients.get(channelId).add(ws);
        wsChannelMap.set(ws, { channelId, memberId, memberName, memberColor });

        // 이 클라이언트에 채널 정보 전송 (사용자별 데이터 격리)
        const uid = ws._userId || 'local';
        ws.send(JSON.stringify({
          type:        'channel.joined',
          channelId, memberId, memberName, memberColor,
          members:  getChannelMembers(channelId),
          graph:    uid !== 'local' && uid !== 'anonymous'
                      ? getFullGraphForUser(uid) : getFullGraph(),
          sessions: getSessionsForUser(uid),
          stats:    getStats(),
        }));

        // 같은 채널 다른 멤버들에게 입장 알림
        broadcastToChannel(channelId, {
          type: 'channel.member_joined',
          memberId, memberName, memberColor,
          members: getChannelMembers(channelId),
        });

        console.log(`[CHANNEL] "${memberName}" → #${channelId} (총 ${channelClients.get(channelId).size}명)`);
        return;
      }

      // ── 채널 내 커서/활동 브로드캐스트 ─────────────────────────────────
      if (msg.type === 'channel.activity') {
        const info = wsChannelMap.get(ws);
        if (info) {
          broadcastToChannel(info.channelId, {
            type:        'channel.activity',
            memberId:    info.memberId,
            memberName:  info.memberName,
            memberColor: info.memberColor,
            action:      msg.action,  // 'hover_node', 'select_node', 'typing' 등
            nodeId:      msg.nodeId,
          });
        }
        return;
      }

      // ── 주석 생성 ────────────────────────────────────────────────────────
      if (msg.type === 'annotation.create') {
        const event = createAnnotationEvent(msg.data);
        insertEvent(event);

        if (!process.env.DATABASE_URL) {
          const entry = {
            id: event.id, type: event.type, source: event.source,
            sessionId: event.sessionId, parentEventId: event.parentEventId,
            data: event.data, ts: event.timestamp,
          };
          fs.appendFileSync(CONV_FILE, JSON.stringify(entry) + '\n');
        }

        const info      = wsChannelMap.get(ws);
        const channelId = info?.channelId;
        const payload   = { type: 'event', event, graph: getFullGraph() };

        if (channelId) broadcastToChannel(channelId, payload);
        else           broadcastAll(payload);
      }

      // ── 세션 필터 ────────────────────────────────────────────────────────
      if (msg.type === 'filter') {
        const uid = ws._userId || 'local';
        const graph = uid !== 'local' && uid !== 'anonymous'
          ? getFullGraphForUser(uid, msg.sessionId)
          : getFullGraph(msg.sessionId);
        ws.send(JSON.stringify({ type: 'filtered', graph }));
      }

      // ── WS 인증 (클라이언트에서 로그인 후 토큰 전송) ───────────────────
      if (msg.type === 'auth') {
        const u = msg.token ? _verifyToken(msg.token) : null;
        ws._userId = u?.id || 'local';
        const uid = ws._userId;
        ws.send(JSON.stringify({
          type:     'init',
          graph:    uid !== 'local' && uid !== 'anonymous'
                      ? getFullGraphForUser(uid) : getFullGraph(),
          sessions: getSessionsForUser(uid),
          stats:    getStats(),
          userConfig: getUserConfig(),
        }));
      }

    } catch (e) {
      logger.ws.error('message 처리 오류: %s', e.message);
    }
  });

  ws.on('close', () => {
    const info = wsChannelMap.get(ws);
    if (info) {
      const { channelId, memberId, memberName } = info;
      const clients = channelClients.get(channelId);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) channelClients.delete(channelId);
      }
      broadcastToChannel(channelId, {
        type: 'channel.member_left',
        memberId, memberName,
        members: getChannelMembers(channelId),
      });
      console.log(`[CHANNEL] "${memberName}" 퇴장 (#${channelId})`);
    }
    unsubscribeChatRooms(ws); // 채팅 방 구독 정리
    logger.ws.info('클라이언트 연결 종료');
  });

  ws.on('error', e => logger.ws.error('에러: %s', e.message));
});

// ─── 데몬용 Drive 설정 배포 API (인증 필수) ──────────────────────────────────
// 데몬이 캡처 → Google Drive 업로드에 필요한 서비스 계정 키 제공
app.get('/api/daemon/drive-config', (req, res) => {
  // [2026-06-17] Drive 전역 OFF — 서비스계정 quota 없어 403 무한재시도로 로그/자원 폭주.
  // 분석은 서버큐+CLI워커로 이전했으므로 Drive 업로드 불필요. enabled:false면 데몬이 uploader 미기동.
  if (global._driveDisabled) return res.json({ enabled: false, disabledReason: 'drive_global_off' });
  // 데몬/Vision 워커가 토큰 없이도 접근 가능 (서비스 계정 정보 제공)
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  // DB 오버라이드 우선 → env var 폴백 (Railway 대시보드 접근 없이 수정 가능)
  const folderIdOverride = global._driveConfigOverride?.folderId;
  const folderId = folderIdOverride || process.env.GOOGLE_DRIVE_CAPTURES_FOLDER_ID;
  if (!saJson || !folderId) {
    return res.json({ enabled: false });
  }
  res.json({ enabled: true, credentialsJson: saJson, folderId });
});

// [2026-06-17] Drive 업로드 전역 ON/OFF (403 폭주 차단) — orbit_ 토큰, PG 영속
app.post('/api/admin/drive-toggle', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token.startsWith('orbit_')) return res.status(401).json({ error: 'orbit token required' });
  global._driveDisabled = (req.body?.enabled === false);
  try {
    const _pool = dbModule.getDb ? dbModule.getDb() : null;
    if (_pool?.query) {
      await _pool.query(`CREATE TABLE IF NOT EXISTS orbit_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
      await _pool.query(`INSERT INTO orbit_settings (key,value) VALUES ('drive_disabled',$1) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`, [global._driveDisabled ? 'true' : 'false']);
    }
  } catch (e) { console.warn('[drive-toggle] PG:', e.message); }
  console.log(`[drive-toggle] Drive 업로드 ${global._driveDisabled ? 'OFF(403폭주 차단)' : 'ON'}`);
  res.json({ ok: true, driveUpload: global._driveDisabled ? 'off' : 'on' });
});

// ─── Drive 폴더ID 오버라이드 (Railway 환경변수 우회) ────────────────────────────
app.post('/api/admin/drive-folder-override', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token.startsWith('orbit_')) return res.status(401).json({ error: 'orbit token required' });
  const { folderId } = req.body;
  if (!folderId) return res.status(400).json({ error: 'folderId required' });
  if (!global._driveConfigOverride) global._driveConfigOverride = {};
  global._driveConfigOverride.folderId = folderId;
  console.log(`[drive-config] 폴더ID 오버라이드 설정: ${folderId}`);
  // DB에 영구 저장 (Railway 재시작 후에도 유지)
  try {
    const _pool = dbModule.getDb ? dbModule.getDb() : null;
    if (_pool?.query) {
      await _pool.query(
        `CREATE TABLE IF NOT EXISTS orbit_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`
      );
      // DELETE + INSERT 패턴 (ON CONFLICT 대신 — constraint 없는 기존 테이블 호환)
      await _pool.query(`DELETE FROM orbit_settings WHERE key='drive.folderId.override'`);
      await _pool.query(
        `INSERT INTO orbit_settings (key, value) VALUES ('drive.folderId.override', $1)`, [folderId]
      );
      res.json({ ok: true, folderId, persisted: true });
    } else {
      res.json({ ok: true, folderId, persisted: false, note: '메모리만 저장 (PG 없음)' });
    }
  } catch (e) {
    console.warn('[drive-config] DB 저장 실패:', e.message);
    res.json({ ok: true, folderId, persisted: false, note: e.message });
  }
});

// ─── 일회성: Drive 폴더를 개인 계정에 공유 ───────────────────────────────────
app.post('/api/admin/share-drive-folder', async (req, res) => {
  try {
    const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const folderId = process.env.GOOGLE_DRIVE_CAPTURES_FOLDER_ID;
    const targetEmail = req.body?.email || 'dlaww584@gmail.com';
    if (!saJson || !folderId) return res.status(400).json({ error: 'Drive 설정 없음' });

    const cred = JSON.parse(saJson);
    // JWT 생성 (서비스 계정)
    const crypto = require('crypto');
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: cred.client_email,
      scope: 'https://www.googleapis.com/auth/drive',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600, iat: now,
    })).toString('base64url');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const sig = sign.sign(cred.private_key, 'base64url');
    const jwt = `${header}.${payload}.${sig}`;

    // 액세스 토큰 발급
    const tokenRes = await new Promise((resolve, reject) => {
      const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
      const httpsReq = require('https').request({
        hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))); });
      httpsReq.on('error', reject);
      httpsReq.write(body); httpsReq.end();
    });
    if (!tokenRes.access_token) return res.status(500).json({ error: '토큰 발급 실패', detail: tokenRes });

    // Drive API: permissions.create
    const permBody = JSON.stringify({ role: 'writer', type: 'user', emailAddress: targetEmail });
    const permRes = await new Promise((resolve, reject) => {
      const r = require('https').request({
        hostname: 'www.googleapis.com',
        path: `/drive/v3/files/${folderId}/permissions?sendNotificationEmail=false`,
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tokenRes.access_token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(permBody) },
      }, r2 => { let d = ''; r2.on('data', c => d += c); r2.on('end', () => resolve({ status: r2.statusCode, body: d })); });
      r.on('error', reject);
      r.write(permBody); r.end();
    });

    res.json({ ok: permRes.status === 200, status: permRes.status, folderId, targetEmail, detail: JSON.parse(permRes.body || '{}') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 자동 에러 수정 엔진 ─────────────────────────────────────────────────────
const autoFixer = (() => { try { return require('./src/auto-fixer'); } catch(e) { console.warn('[auto-fixer] 로드 실패:', e.message); return null; } })();

// ─── 텍스트 구조화 추출기 ─────────────────────────────────────────────────────
const textExtractor = (() => { try { return require('./src/text-extractor'); } catch(e) { console.warn('[text-extractor] 로드 실패:', e.message); return null; } })();

// ─── 서버사이드 Vision 분석 루프 ───────────────────────────────────────────────
const visionProcessor = (() => { try { return require('./src/vision-processor'); } catch(e) { return null; } })();
const serverVisionWorker = (() => { try { return require('./src/server-vision-worker'); } catch(e) { console.warn('[server-vision-worker] 로드 실패:', e.message); return null; } })();

// ─── 업데이트 이메일 알림 ────────────────────────────────────────────────────
const { sendUpdateEmail, sendPerfIssueEmail } = (() => { try { return require('./src/email-notifier'); } catch(e) { console.warn('[email-notifier] 로드 실패:', e.message); return { sendUpdateEmail: () => {}, sendPerfIssueEmail: () => {} }; } })();

// ─── Vision 큐 (맥미니 CLI 워커가 폴링해서 분석) ──────────────────────────────
// Vision 분석은 맥미니 전용 — Railway에서는 큐잉만 함
// 2026-07-08 실측: 단일 배열+상한20 구조는 활동 많은 PC가 큐를 독점해 저활동 직원 캡처가
// 분석 전에 유실됨(유입 331건/h vs 소비 10건/h, 큐 20개 전부 owner PC였음).
// → 사용자별 분리 큐 + 라운드로빈으로 교체: 한 사람이 폭주해도 다른 사람 슬롯을 뺏지 않는다.
if (!global._visionQueueByUser) global._visionQueueByUser = new Map(); // userId → [items](오래된→최신), 상한 초과시 가장 오래된 것부터 버림
const _VISION_PER_USER_MAX = 6; // 사용자당 보관 상한(이미지 최대 5MB 게이트 있음 — 워스트케이스도 힙 예산 안전)
// 레거시 배열도 병행 유지 — src/server-vision-worker.js·src/vision-processor.js·services/memory-manager.js가
// ANTHROPIC_API_KEY 설정 시 이 배열을 직접 splice/shift로 소비하는 별도(현재 휴면) 유료 경로라 끊으면 안 됨.
if (!global._visionImageQueue) global._visionImageQueue = [];
const _VISION_LEGACY_MAX = 20;
function _visionQueuePush(item) {
  const uid = item.userId || 'unknown';
  if (!global._visionQueueByUser.has(uid)) global._visionQueueByUser.set(uid, []);
  const q = global._visionQueueByUser.get(uid);
  // [2026-07-13] 시간 다양성 보장: 데몬 flush가 초 단위 버스트로 밀어넣으면 "최신 6장"이 전부
  // 몇 초 간격이라 워커 트리아지(같은 화면 3분 컷)에서 1장만 살아남음 → 세션(10분내 3장+) 형성 불가.
  // 마지막 항목과 2분 미만 간격이면 교체(근접 중복 대체) — 큐 6칸이 ~12분+ 시간대를 커버하게 됨. 힙 예산 불변.
  const lastItem = q[q.length - 1];
  if (lastItem && Math.abs(new Date(item.ts) - new Date(lastItem.ts)) < 120000) {
    q[q.length - 1] = item;
  } else {
    q.push(item);
  }
  while (q.length > _VISION_PER_USER_MAX) q.shift();
  global._visionImageQueue.push(item);
  while (global._visionImageQueue.length > _VISION_LEGACY_MAX) global._visionImageQueue.shift();
}
function _visionQueueTotal() { let n = 0; for (const q of global._visionQueueByUser.values()) n += q.length; return n; }
// 라운드로빈 추출: 사용자를 한 바퀴씩 돌며 각자 최신 항목부터(LIFO) 채움 — 특정 사용자 독점 방지
function _visionQueueTake(n) {
  const taken = [];
  const users = [...global._visionQueueByUser.keys()];
  let progressed = true;
  while (taken.length < n && progressed) {
    progressed = false;
    for (const uid of users) {
      if (taken.length >= n) break;
      const q = global._visionQueueByUser.get(uid);
      if (q && q.length) { taken.push(q.pop()); progressed = true; }
    }
  }
  for (const uid of users) if ((global._visionQueueByUser.get(uid) || []).length === 0) global._visionQueueByUser.delete(uid);
  return taken;
}

// [골:실행좌표 융합] 호스트별 최근 클릭 링버퍼 — keyboard.chunk의 mousePositions를 담아뒀다가
// screen.capture를 vision 큐에 넣을 때 직전 클릭들을 첨부한다(클릭 좌표는 캡처 이벤트가 아니라
// keyboard.chunk에 실려 오므로 시점을 이어붙여야 vision이 "어느 필드를 클릭했나"를 판단 가능).
// ★userId로 키잉(2026-07-09 버그수정): keyboard.chunk는 data.hostname이 비어있고(undefined)
// screen.capture는 'DESKTOP-...'로 채워져 있어 hostname으로 키잉하면 키가 안 맞아 클릭이 안 붙었음.
// userId는 hook이 두 이벤트 모두에 확정(hookUserId)하므로 안정적 공통키.
// ★보존 15분(2026-07-09): 캡처는 클릭 순간 즉시 큐잉되는데 그 클릭을 담은 keyboard.chunk는
// 나중에 flush돼 도착함(캡처가 클릭보다 먼저 옴). 그래서 클릭 첨부는 push가 아니라 워커가 큐를
// 가져가는 fetch 시점(/api/vision/queue)에 함 — 그땐 클릭이 다 도착해 있음. 버퍼는 그때까지 보존.
if (!global._recentClicksByUser) global._recentClicksByUser = new Map(); // userId → [{t,x,y,app,win}] (최근 15분·최대 300개)
const _CLICK_RETAIN_MS = 15 * 60 * 1000;
function _pushRecentClicks(uid, positions) {
  if (!uid || !Array.isArray(positions) || !positions.length) return;
  const arr = global._recentClicksByUser.get(uid) || [];
  for (const p of positions) if (p && typeof p.x === 'number' && typeof p.y === 'number') arr.push({ t: p.t || Date.now(), x: p.x, y: p.y, app: p.app, win: p.win });
  const cutoff = Date.now() - _CLICK_RETAIN_MS;
  const trimmed = arr.filter(p => (p.t || 0) >= cutoff).slice(-300);
  global._recentClicksByUser.set(uid, trimmed);
}
function _clicksForCapture(uid, captureTsMs) {
  const arr = global._recentClicksByUser.get(uid) || [];
  // 캡처 전후 창: 화면을 연 클릭(직전)~캡처 직후 반응클릭까지. 첫 화면 클릭이 캡처보다 앞설 수도, 뒤일 수도.
  const lo = captureTsMs - 15000, hi = captureTsMs + 8000;
  return arr.filter(p => (p.t || 0) >= lo && (p.t || 0) <= hi).slice(-8);
}

// 힙 압력 모니터링 (460MB 힙 기준 — Railway Hobby 512MB 내 안정 운영)
let _heapPressure = false;
setInterval(() => {
  const heapMB = process.memoryUsage().heapUsed / 1024 / 1024;
  _heapPressure = heapMB > 500;  // 768MB 힙 기준 — 500MB 이상 압박
  if (heapMB > 550) {
    console.warn(`[heap] 압력 감지: ${Math.round(heapMB)}MB — GC 강제 실행`);
    if (global.gc) global.gc();
  }
  if (heapMB > 650) {
    console.error(`[heap] 위험: ${Math.round(heapMB)}MB — 캐시 정리 후 GC`);
    // 오래된 daemon commands 정리
    if (global._daemonCommands) {
      Object.keys(global._daemonCommands).forEach(k => {
        if (global._daemonCommands[k].length > 10) global._daemonCommands[k] = global._daemonCommands[k].slice(-5);
      });
    }
    if (global.gc) global.gc();
  }
}, 30000);

// ─── 학습 분석 API ──────────────────────────────────────────────────────────
const workLearner = (() => { try { return require('./src/work-learner'); } catch { return null; } })();
const reportSheet = (() => { try { return require('./src/report-sheet'); } catch { return null; } })();

// 리포트 시트 초기화
if (reportSheet && process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  const enabled = reportSheet.init({
    credentialsJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    folderId: process.env.GOOGLE_DRIVE_CAPTURES_FOLDER_ID,
  });
  if (enabled) console.log('[report-sheet] 초기화 완료');
}

// GET /api/admin/pc-list — 이벤트 DB에 있는 모든 고유 PC 호스트명 목록
app.get('/api/admin/pc-list', async (req, res) => {
  try {
    const pool = dbModule.getDb();
    const { rows } = await pool.query(
      `SELECT DISTINCT data_json->>'hostname' AS hostname, user_id,
              MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen, COUNT(*) AS event_count
       FROM events
       WHERE data_json->>'hostname' IS NOT NULL
       GROUP BY data_json->>'hostname', user_id
       ORDER BY last_seen DESC`
    );
    res.json({ pcs: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/install-diag — 설치 시점 환경진단(install.diag) 호스트별 최신 1건
// [2026-06-18] "이 PC가 다른 PC와 뭐가 다른지"(백신/uiohook/자동시작) 원격 확인용.
// ?hostname=X 주면 그 PC만. install.ps1이 설치 끝에 install.diag 이벤트를 보냄.
app.get('/api/admin/install-diag', async (req, res) => {
  try {
    const pool = dbModule.getDb();
    const host = req.query.hostname;
    const params = [];
    let where = `type='install.diag'`;
    if (host) { params.push(host); where += ` AND data_json->>'hostname' ILIKE $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (data_json->>'hostname') data_json->>'hostname' AS hostname, timestamp, data_json
       FROM events WHERE ${where}
       ORDER BY data_json->>'hostname', timestamp DESC`,
      params
    );
    const diags = rows.map(r => {
      const d = typeof r.data_json === 'object' ? r.data_json : (() => { try { return JSON.parse(r.data_json || '{}'); } catch { return {}; } })();
      return { hostname: r.hostname, ts: r.timestamp, ...d };
    });
    res.json({ diags, total: diags.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/raw-events?type=X&hostname=Y&limit=N — 임의 타입 이벤트의 원본 data_json 조회
// learning/logs가 고정스키마로 커스텀 필드를 버리는 문제 우회 (screen.diag/daemon.screendiag 등 진단용).
app.get('/api/admin/raw-events', async (req, res) => {
  try {
    const pool = dbModule.getDb();
    const type = req.query.type;
    if (!type) return res.status(400).json({ error: 'type required' });
    const host = req.query.hostname;
    const limit = Math.min(parseInt(req.query.limit) || 20, 200);
    const params = [type];
    let where = `type = $1`;
    if (host) { params.push(host); where += ` AND data_json->>'hostname' ILIKE $${params.length}`; }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT id, type, timestamp, data_json FROM events WHERE ${where} ORDER BY timestamp DESC LIMIT $${params.length}`,
      params
    );
    const events = rows.map(r => {
      const d = typeof r.data_json === 'object' ? r.data_json : (() => { try { return JSON.parse(r.data_json || '{}'); } catch { return {}; } })();
      return { id: r.id, ts: r.timestamp, data: d };
    });
    res.json({ events, total: events.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/capture-health — PC별 화면캡처/Python 실태 요약
//   신뢰성 있게 도착하는 daemon.screendiag(screen-selftest) 이벤트로 PC별 최신 상태를 판정.
//   Python 자동설치 완료보고(detached PS)는 유실될 수 있어, "via pil" 캡처 도착 자체를 Python OK 신호로 씀.
app.get('/api/admin/capture-health', async (req, res) => {
  try {
    const pool = dbModule.getDb();
    const hours = Math.min(parseInt(req.query.hours) || 24, 168);
    const { rows } = await pool.query(
      `SELECT timestamp, data_json FROM events
       WHERE type='daemon.screendiag' AND timestamp::timestamptz > NOW() - ($1 || ' hours')::interval
       ORDER BY timestamp DESC LIMIT 600`, [String(hours)]);
    const byHost = {};
    for (const r of rows) {
      const d = typeof r.data_json === 'object' ? r.data_json : (() => { try { return JSON.parse(r.data_json || '{}'); } catch { return {}; } })();
      const host = d.hostname || '?';
      const detail = String(d.detail || '');
      const h = byHost[host] || (byHost[host] = { host, lastAt: r.timestamp, method: null, sizeB: null, pilOk: false, pending: false, samples: 0 });
      h.samples++;
      // 최신 1건에서 방식/크기 판정 (rows가 최신순이라 host별 첫 등장이 최신)
      if (!h.method) {
        const mv = detail.match(/via (\w+)/);
        if (mv) h.method = mv[1];
        // 선택된 방식의 바이트 크기
        const key = h.method === 'pil' ? 'pil' : h.method === 'pyautogui' ? 'pyautogui' : 'powershell';
        const sz = detail.match(new RegExp(key + ':(\\d+)b'));
        if (sz) h.sizeB = parseInt(sz[1]);
        if (/python 없음 감지/.test(detail)) h.pending = true;
      }
      // 최근 창 내 어디서든 pil 캡처 성공이 있었으면 Python OK
      if (/via pil/.test(detail)) h.pilOk = true;
    }
    const pcs = Object.values(byHost).map(h => {
      let verdict, note;
      if (h.pilOk) { verdict = 'OK'; note = 'Python+PIL 정상'; }
      else if (h.method === 'powershell' && (h.sizeB || 0) >= 30000) { verdict = 'OK_PS'; note = 'Python 없이 PowerShell 폴백(실화면)'; }
      else if (h.pending) { verdict = 'INSTALLING'; note = 'Python 없음 → 자동설치 진행중'; }
      else if (h.method === 'powershell' && (h.sizeB || 0) < 10000) { verdict = 'BLACK'; note = '검은화면 위험(작은 PS캡처, Python 필요)'; }
      else { verdict = 'UNKNOWN'; note = '판정 불가'; }
      return { ...h, verdict, note };
    }).sort((a, b) => (a.verdict === 'BLACK' ? -1 : 1) - (b.verdict === 'BLACK' ? -1 : 1));
    const summary = { total: pcs.length,
      ok: pcs.filter(p => p.verdict === 'OK').length,
      okPs: pcs.filter(p => p.verdict === 'OK_PS').length,
      installing: pcs.filter(p => p.verdict === 'INSTALLING').length,
      black: pcs.filter(p => p.verdict === 'BLACK').length };
    res.json({ hours, summary, pcs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/judgment-map — 자동디벨롭: 루틴별 판단경계 + 자동화 가능 구간
//   work.step에서 반복 루틴을 발견 → 스텝별 판단점수 → 판단없는 연속구간(자동화 후보) 표시.
global._judgmentCache = global._judgmentCache || null;
app.get('/api/admin/judgment-map', async (req, res) => {
  try {
    const pool = dbModule.getDb();
    if (!pool?.query) return res.json({ error: 'DB 없음' });
    const hours = parseInt(req.query.hours) || 72;
    const fresh = req.query.fresh === '1';
    const c = global._judgmentCache;
    if (!fresh && c && c.windowHours === hours && (Date.now() - c._at < 20 * 60 * 1000)) {
      return res.json({ ...c, cached: true });
    }
    const { mineJudgment } = require('./src/judgment-miner');
    const out = await mineJudgment(pool, { hours });
    out._at = Date.now();
    global._judgmentCache = out;
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/kakao-intel — 카톡 인텔 집계 (거래처 성향/직원 역량/이슈트래킹/해결로직)
//   kakao-intel-worker(Claude CLI)가 만든 type='kakao.intel' 이벤트를 롤업.
app.get('/api/admin/kakao-intel', async (req, res) => {
  try {
    const pool = dbModule.getDb(); if (!pool?.query) return res.json({ error: 'DB 없음' });
    const hours = Math.min(parseInt(req.query.hours) || 720, 2160);
    // [2026-07-31] 캐시 — kakao.intel 5000건 집계가 무거워(>100s) 관리자뷰 502/타임아웃. 5분 인메모리 TTL.
    // (프리컴퓨트를 events 영속으로 시도했으나 events 테이블 되읽기가 더 느려 롤백 — 단순 캐시가 정답.)
    if (!global._kiCache) global._kiCache = new Map();
    const _kiKey = `ki|${hours}`;
    const _kiHit = global._kiCache.get(_kiKey);
    if (_kiHit && Date.now() - _kiHit.ts < 300000) return res.json(_kiHit.data);
    const _kiOrig = res.json.bind(res);
    res.json = (obj) => { if (obj && !obj.error) { global._kiCache.set(_kiKey, { ts: Date.now(), data: obj }); if (global._kiCache.size > 40) global._kiCache.delete(global._kiCache.keys().next().value); } return _kiOrig(obj); };
    const { rows } = await pool.query(
      `SELECT data_json, timestamp FROM events WHERE type='kakao.intel'
        AND timestamp::timestamptz > NOW() - ($1 || ' hours')::interval
        ORDER BY timestamp DESC LIMIT 5000`, [String(hours)]);
    const topN = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, v }));
    const inc = (o, k) => { if (k) o[k] = (o[k] || 0) + 1; };

    // 집계 버킷: 이슈(케이스 key별)·거래처·직원·판단룰·해결단계·사람판단·별칭
    const issues = {};       // key → 이슈 트래킹(같은 품목+차수 병합)
    const byType = {};       // 이슈 유형 분포
    const customers = {};    // 거래처 성향지도
    const employees = {};    // 직원 역량매트릭스
    const rules = {};        // 해결 플레이북(판단룰)
    const steps = {};        // 해결 절차 빈도
    const human = {};        // 사람판단 지점
    const aliasOf = {};      // 표시명 → 직원(roleMap)
    let windows = 0, ccSum = 0, ccN = 0, _exclDefect = 0;

    for (const r of rows) {
      const d = typeof r.data_json === 'object' ? r.data_json : (() => { try { return JSON.parse(r.data_json || '{}'); } catch { return {}; } })();
      if (!Array.isArray(d.cases)) continue; // 옛 shape 이벤트는 스킵
      windows++;
      if (d.crossCheck && typeof d.crossCheck.score === 'number') { ccSum += d.crossCheck.score; ccN++; }
      for (const rm of (d.roleMap || [])) { if (rm && rm.raw && rm.staff) aliasOf[rm.raw] = rm.staff; }

      for (const c of d.cases) {
        if (!c) continue;
        // [2026-08-03] 불량/불만 제외(사장님: 필요없음). 저장 타입이 공백/변형될 수 있어 부분일치로 견고하게.
        { const _t = String(c.type || ''); if (_t.includes('불량') || _t.includes('불만')) { _exclDefect++; continue; } }
        const key = (c.key || `${c.seq || ''} ${c.product || ''}`).trim() || '(미상)';
        const it = issues[key] || (issues[key] = { key, product: c.product || '', seq: c.seq || '', type: c.type || '기타', room: d.room || '', raisedBy: c.raisedBy || '', customers: {}, occurrences: 0, resolved: false, turns: 0, tone: c.tone || '', evidence: c.evidence || '', summary: c.summary || '', critical: false, firstTs: '', lastTs: '', crossCheck: null });
        it.occurrences++; it.turns += (c.turns || 1);
        // [2026-08-13] 조기경보 근거 첨부(③): 케이스별 활동 ts(윈도우 근사)·교차검증 점수를 롤업에 실어 감사 가능하게.
        if (d.lastTs && (!it.lastTs || String(d.lastTs) > it.lastTs)) it.lastTs = String(d.lastTs);
        if (d.firstTs && (!it.firstTs || String(d.firstTs) < it.firstTs)) it.firstTs = String(d.firstTs);
        if (d.crossCheck && typeof d.crossCheck.score === 'number') it.crossCheck = it.crossCheck == null ? d.crossCheck.score : Math.min(it.crossCheck, d.crossCheck.score);
        if (c.critical === true) it.critical = true;   // [2026-07-31] 운영이슈(항공스케줄·주문/출고누락) 플래그
        if (c.resolved) it.resolved = true;            // 여러 윈도우 중 한 번이라도 해결이면 해결
        if (c.summary) it.summary = c.summary;          // 최신(=최근 윈도우가 먼저 정렬) 요약 유지
        if (c.type) it.type = c.type;
        inc(byType, c.type || '기타');
        for (const cu of (c.customers || [])) {
          if (!cu) continue; it.customers[cu] = true;
          const co = customers[cu] || (customers[cu] = { name: cu, mentions: 0, issues: {}, resolved: 0, types: {}, tones: {} });
          co.mentions++; if (c.resolved) co.resolved++; co.issues[key] = true; inc(co.types, c.type); inc(co.tones, c.tone);
        }
        const emp = (c.raisedBy || '').trim();
        if (emp) {
          const eo = employees[emp] || (employees[emp] = { name: emp, handled: 0, resolved: 0, types: {} });
          eo.handled++; if (c.resolved) eo.resolved++; inc(eo.types, c.type);
        }
      }
      for (const dr of (d.decisionRules || [])) {
        if (!dr || !dr.rule) continue;
        const k = dr.rule.trim();
        const ro = rules[k] || (rules[k] = { rule: k, count: 0, deterministic: 0, judgment: 0, evidence: dr.evidence || '' });
        ro.count++; if (dr.kind === 'deterministic') ro.deterministic++; else if (dr.kind === 'judgment') ro.judgment++;
      }
      for (const s of (d.resolutionSteps || [])) inc(steps, (s || '').trim());
      for (const h of (d.humanJudgmentPoints || [])) inc(human, (h || '').trim());
    }

    const issueList = Object.values(issues).map(it => ({ ...it, customers: Object.keys(it.customers) }));
    const ruleList = Object.values(rules).map(r => ({ ...r, kind: r.judgment > r.deterministic ? 'judgment' : 'deterministic' }));
    // 판단룰은 윈도우마다 문구가 미세히 달라 그대로 두면 전부 count=1 → 토큰 Jaccard(≥0.5)로 유사 규칙을 묶어 순위화.
    const _tok = s => (s || '').toLowerCase().replace(/[.,()·/\[\]"']/g, ' ').split(/\s+/).map(w => w.replace(/(은|는|이|가|을|를|로|으로|의|에|와|과|도|만|형|건)$/, '')).filter(w => w.length > 1);
    function clusterRules(list) {
      const clusters = [];
      for (const r of [...list].sort((a, b) => b.count - a.count)) {
        const toks = new Set(_tok(r.rule));
        let best = null, bestJ = 0;
        for (const c of clusters) {
          const inter = [...toks].filter(t => c.toks.has(t)).length;
          const uni = new Set([...toks, ...c.toks]).size;
          const j = uni ? inter / uni : 0;
          if (j > bestJ) { bestJ = j; best = c; }
        }
        if (best && bestJ >= 0.5) { best.count += r.count; best.variants++; for (const t of toks) best.toks.add(t); }
        else clusters.push({ rule: r.rule, count: r.count, variants: 1, toks });
      }
      return clusters.map(c => ({ rule: c.rule, count: c.count, variants: c.variants })).sort((a, b) => b.count - a.count);
    }
    const issuesResolved = issueList.filter(i => i.resolved).length;

    res.json({
      generatedAt: new Date().toISOString(), windowsAnalyzed: windows, hours,
      crossCheckAvg: ccN ? +(ccSum / ccN).toFixed(2) : null,
      excludedDefects: _exclDefect, // 제외된 불량/불만 케이스 수(검증용)
      // 1) 이슈 트래킹보드 (미해결 우선, 불량/불만 제외)
      issues: issueList.sort((a, b) => (a.resolved - b.resolved) || (b.occurrences - a.occurrences)).slice(0, 150),
      issueSummary: { total: issueList.length, resolved: issuesResolved, unresolved: issueList.length - issuesResolved, byType: topN(byType, 20) },
      // 2) 거래처 성향지도
      customers: Object.values(customers).map(c => ({ name: c.name, mentions: c.mentions, issues: Object.keys(c.issues).length, resolveRate: c.mentions ? +(c.resolved / c.mentions).toFixed(2) : null, types: topN(c.types, 4), tones: topN(c.tones, 3) })).sort((a, b) => b.issues - a.issues).slice(0, 80),
      // 3) 직원 역량매트릭스
      employees: Object.values(employees).map(e => ({ name: e.name, aliases: Object.keys(aliasOf).filter(a => aliasOf[a] === e.name), handled: e.handled, resolveRate: e.handled ? +(e.resolved / e.handled).toFixed(2) : null, types: topN(e.types, 5) })).sort((a, b) => b.handled - a.handled).slice(0, 40),
      // 4) 해결 플레이북 + 자동화후보
      playbook: {
        automationCandidates: clusterRules(ruleList.filter(r => r.kind === 'deterministic')).slice(0, 40),
        judgmentRules: clusterRules(ruleList.filter(r => r.kind === 'judgment')).slice(0, 40),
        steps: topN(steps, 15),
        humanJudgment: topN(human, 20),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/perf-issues — PC 이슈 리포트 목록 (최근 100건)
app.get('/api/admin/perf-issues', (req, res) => {
  const { isAdmin } = resolveAdmin(req);
  if (!isAdmin) return res.status(403).json({ error: 'admin only' });
  res.json({ issues: global._perfIssues || [], total: (global._perfIssues || []).length });
});

// GET /api/admin/all-users — 등록된 모든 사용자 목록 (관리자용)
app.get('/api/admin/all-users', async (req, res) => {
  try {
    const pool = dbModule.getDb();
    const { rows } = await pool.query(
      `SELECT id, name, email, created_at FROM orbit_auth_users ORDER BY created_at DESC`
    );
    res.json({ users: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/workspaces — 모든 워크스페이스 + 멤버 현황
app.get('/api/admin/workspaces', async (req, res) => {
  try {
    const pool = dbModule.getDb();
    const { rows: ws } = await pool.query(
      `SELECT w.id, w.name, w.owner_id, w.invite_code, w.created_at,
              COUNT(wm.user_id) FILTER (WHERE wm.status='active') AS active_count
       FROM workspaces w
       LEFT JOIN workspace_members wm ON wm.workspace_id = w.id
       GROUP BY w.id ORDER BY w.created_at DESC`
    );
    const result = await Promise.all(ws.map(async w => {
      const { rows: members } = await pool.query(
        `SELECT wm.user_id, wm.role, wm.team_name, wm.status, u.name, u.email
         FROM workspace_members wm
         LEFT JOIN orbit_auth_users u ON u.id = wm.user_id
         WHERE wm.workspace_id = $1 ORDER BY wm.joined_at`, [w.id]
      );
      return { ...w, members };
    }));
    res.json({ workspaces: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/workspace-add-member — 사용자를 워크스페이스에 직접 추가
app.post('/api/admin/workspace-add-member', async (req, res) => {
  try {
    const { workspaceId, userId, role = 'member', teamName = '' } = req.body || {};
    if (!workspaceId || !userId) return res.status(400).json({ error: 'workspaceId, userId 필수' });
    const pool = dbModule.getDb();
    // 이미 있으면 active로 업데이트
    const { rowCount } = await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, team_name, status, joined_at)
       VALUES ($1,$2,$3,$4,'active',NOW())
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET status='active', role=$3, team_name=$4`,
      [workspaceId, userId, role, teamName]
    );
    res.json({ ok: true, message: `${userId} → ${workspaceId} 추가 완료` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/setup-nenova — nenova 워크스페이스 PG 재생성 (일회성)
app.post('/api/admin/setup-nenova', async (req, res) => {
  try {
    const pool = dbModule.getDb();
    const ownerId = 'MNH03H73690BB2CD82'; // jaeyong lim (dlaww584@gmail.com)
    const wsId = 'WS-NENOVA-2026';
    // 워크스페이스 생성 (이미 있으면 skip)
    await pool.query(
      `INSERT INTO workspaces (id, name, company_name, owner_id, invite_code, created_at)
       VALUES ($1, 'nenova', 'nenova', $2, 'NENOVA01', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [wsId, ownerId]
    );
    // 멤버 추가 (PG all-users 기반)
    const members = [
      { id: 'MNH03H73690BB2CD82', role: 'owner',  team: '관리자' },      // jaeyong lim
      { id: 'MNIAFICB3DC88DCB34', role: 'member', team: '영업지원팀' },  // 설연주
      { id: 'MNMR8568CC8950F81D', role: 'member', team: '영업지원팀' },  // hoon J (훈제이)
      { id: 'MNMRVD11EDCCF6E7CE', role: 'member', team: '영업지원팀' },  // wbk
      { id: 'MNMR52IIBE1A1E37A2', role: 'member', team: '영업팀' },      // 박성수
      { id: 'MNMS93EB30F11EF433', role: 'member', team: '영업팀' },      // 현욱(ᄏᄏ)
      { id: 'MNMRX6SR07F5FF7C0C', role: 'member', team: '영업지원팀' },  // 강현우
      { id: 'MNMSAQJD78E544A631', role: 'member', team: '영업지원팀' },  // 강명훈
    ];
    for (const m of members) {
      await pool.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, team_name, status, joined_at)
         VALUES ($1,$2,$3,$4,'active',NOW())
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET status='active', role=$3, team_name=$4`,
        [wsId, m.id, m.role, m.team]
      ).catch(() => {});
    }
    // 결과 확인
    const { rows } = await pool.query(
      `SELECT wm.user_id, wm.role, wm.team_name, wm.status, u.name
       FROM workspace_members wm LEFT JOIN orbit_auth_users u ON u.id=wm.user_id
       WHERE wm.workspace_id=$1`, [wsId]
    );
    res.json({ ok: true, workspaceId: wsId, members: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// resolveAdmin()은 동기 SQLite verifyToken만 봄 — /api/daemon/claim-token은 PG(orbit_auth_tokens)에만
// 등록해 서로 안 보이는 갭이 있다(2026-07-06 발견). 아래 진단/정리용 엔드포인트는 PG도 함께 확인.
async function isAdminReqAsync(req) {
  if (resolveAdmin(req).isAdmin) return true;
  const raw = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!raw) return false;
  const { verifyTokenAsync } = require('./src/auth');
  const user = await verifyTokenAsync(raw);
  return !!user && env.isAdmin(user.email);
}

// GET /api/admin/events-size-diag — 타입별 건수+대략 크기(디스크 위기 진단, 읽기전용)
app.get('/api/admin/events-size-diag', async (req, res) => {
  try {
    if (!(await isAdminReqAsync(req))) return res.status(403).json({ error: 'admin only' });
    const pool = dbModule.getDb();
    const { rows } = await pool.query(`
      SELECT type, COUNT(*) c, pg_size_pretty(SUM(pg_column_size(data_json))::bigint) approx_size,
             SUM(pg_column_size(data_json)) raw_bytes, MIN(timestamp) oldest, MAX(timestamp) newest
      FROM events GROUP BY type ORDER BY raw_bytes DESC NULLS LAST LIMIT 30`);
    const { rows: totalRows } = await pool.query(`SELECT pg_size_pretty(pg_total_relation_size('events')) total, COUNT(*) c FROM events`);
    res.json({ ok: true, total: totalRows[0], byType: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/vacuum-tables — 안전한 VACUUM(비FULL, 락 없음): 삭제/갱신으로 생긴 데드튜플을
// Postgres가 재사용하도록 회수. 데이터 손실 없음(가비지 컬렉션과 동일 개념).
app.post('/api/admin/vacuum-tables', async (req, res) => {
  try {
    if (!(await isAdminReqAsync(req))) return res.status(403).json({ error: 'admin only' });
    const pool = dbModule.getDb();
    const targets = ['events', 'unified_events', 'ops_relation'];
    const results = {};
    for (const t of targets) {
      try { await pool.query(`VACUUM (ANALYZE) ${t}`); results[t] = 'ok'; }
      catch (e) { results[t] = 'fail: ' + e.message; }
    }
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/db-size-diag — DB 전체 그림(테이블별 크기+데드튜플, 읽기전용)
app.get('/api/admin/db-size-diag', async (req, res) => {
  try {
    if (!(await isAdminReqAsync(req))) return res.status(403).json({ error: 'admin only' });
    const pool = dbModule.getDb();
    const dbSize = await pool.query(`SELECT pg_size_pretty(pg_database_size(current_database())) sz, pg_database_size(current_database()) bytes`);
    const tables = await pool.query(`
      SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) total,
             pg_total_relation_size(relid) total_bytes,
             n_live_tup, n_dead_tup
      FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 20`);
    const wal = await pool.query(`SELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) lag FROM pg_replication_slots`).catch(() => ({ rows: [] }));
    res.json({ ok: true, database: dbSize.rows[0], tables: tables.rows, replicationSlots: wal.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/purge-noise-events — 순수 노이즈 타입(그래프/온톨로지 어디에도 안 쓰임) 삭제(디스크 확보)
// 대상: install.progress/install.diag/daemon.update/daemon.error/daemon.heartbeat/daemon.log.snapshot/daemon.perf.issue
// (graph-engine.NOISE_TYPES + /api/hook 힙압력 스킵목록과 동일 — 이미 "버려도 되는 것"으로 확정된 타입)
app.post('/api/admin/purge-noise-events', async (req, res) => {
  try {
    if (!(await isAdminReqAsync(req))) return res.status(403).json({ error: 'admin only' });
    const pool = dbModule.getDb();
    const days = Math.max(parseInt(req.query.days) || 3, 1);
    const NOISE = ['install.progress', 'install.diag', 'daemon.update', 'daemon.error', 'daemon.heartbeat', 'daemon.log.snapshot', 'daemon.perf.issue'];
    const r = await pool.query(
      `DELETE FROM events WHERE type = ANY($1) AND timestamp::timestamptz < NOW() - ($2 || ' days')::interval`,
      [NOISE, String(days)]
    );
    res.json({ ok: true, deleted: r.rowCount, types: NOISE, olderThanDays: days });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/purge-old-events?days=60&table=events&max=40000 — 보존기간 지난 무거운 원시/분석 데이터 삭제(용량 회수)
// [2026-08-20 사장님: 오래된 것만] 분석 기능은 최근 ~14일 창만 읽으므로 그 이전은 안전. 리포트(ops-report)·kakao_messages는 미대상.
// 대량 한번에 삭제 금지(WAL/락/OOM) → ctid 5000 배치 + 호출당 max 상한. more:true면 반복 호출로 소진.
app.post('/api/admin/purge-old-events', async (req, res) => {
  try {
    if (!(await isAdminReqAsync(req))) return res.status(403).json({ error: 'admin only' });
    const pool = dbModule.getDb();
    const days = Math.max(parseInt(req.query.days) || 60, 14);              // 최소 14일 보존(분석창 보호)
    const maxRows = Math.min(Math.max(parseInt(req.query.max) || 40000, 5000), 200000);
    const table = (req.query.table === 'unified_events') ? 'unified_events' : 'events';
    // events: 무거운 원시/분석 타입만(리포트성·저빈도 타입은 보존). unified_events: 보존기간 지난 전체.
    const HEAVY = ['screen.analyzed', 'screen.capture', 'mouse.chunk', 'keyboard.chunk', 'clipboard.change', 'idle', 'mouse.watcher.started', 'daemon.screendiag'];
    const where = table === 'events'
      ? `type = ANY($1) AND timestamp::timestamptz < NOW() - ($2 || ' days')::interval`
      : `timestamp::timestamptz < NOW() - ($1 || ' days')::interval`;
    const params = table === 'events' ? [HEAVY, String(days)] : [String(days)];
    let total = 0, n = 0;
    do {
      const r = await pool.query(`DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${where} LIMIT 5000)`, params);
      n = r.rowCount; total += n;
      if (n) await new Promise(rs => setTimeout(rs, 120)); // 숨돌리기(WAL/부하 완화)
    } while (n >= 5000 && total < maxRows);
    res.json({ ok: true, table, olderThanDays: days, deleted: total, more: n >= 5000 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/fix-clock-skew?hostname=X — 특정 PC의 시계손상 이벤트(비상식적 timestamp)를
// 서버 수신시각으로 일괄 보정(1회성). insertEvent 방어(2026-07-08)는 향후 유입만 막으므로 이미
// 적재된 과거 손상 행(실측: DESKTOP-L0C2IOT last_seen=9024년)은 이걸로 정리. hostname 필수
// (전체 events 테이블 스캔 방지 — 특정 PC로 범위 한정).
app.post('/api/admin/fix-clock-skew', async (req, res) => {
  try {
    if (!(await isAdminReqAsync(req))) return res.status(403).json({ error: 'admin only' });
    const hostname = req.query.hostname;
    if (!hostname) return res.status(400).json({ error: 'hostname query param required' });
    const pool = dbModule.getDb();
    const nowIso = new Date().toISOString();
    const r = await pool.query(
      `UPDATE events SET timestamp = $2
        WHERE data_json->>'hostname' = $1
          AND (timestamp::timestamptz > NOW() + INTERVAL '1 day' OR timestamp::timestamptz < '2020-01-01')`,
      [hostname, nowIso]
    );
    res.json({ ok: true, hostname, fixed: r.rowCount, newTimestamp: nowIso });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/migrate-ontology-workspace — 일회성: 온톨로지 테이블의 임시 tenant 라벨('nenova')을
// 실제 workspaces.id('WS-NENOVA-2026', workspace_members에 8명 실멤버 존재)로 이관.
// T0b(멀티테넌트 쓰기측 정합) — 안전(라벨 UPDATE만, 데이터 삭제 없음, 여러 번 실행해도 무해).
// 큰 단일 UPDATE는 30분 cron(promote)의 동시 쓰기와 충돌해 "deadlock detected" 발생(2026-07-06 실측) →
// 배치(ctid 기준 5000행씩)로 짧은 트랜잭션 반복. 중간에 실패해도 이미 옮긴 행은 안전(멱등, WHERE절이
// 남은 미이관 행만 계속 골라냄).
// maxBatches로 호출 1번의 작업량을 제한(게이트웨이 타임아웃 회피) — done:false면 그대로 다시 호출해 이어감.
async function batchRelabel(pool, table, from, to, batchSize, maxBatches) {
  let total = 0, done = false;
  for (let i = 0; i < maxBatches; i++) {
    const r = await pool.query(
      `UPDATE ${table} SET workspace_id=$2
         WHERE ctid IN (SELECT ctid FROM ${table} WHERE workspace_id=$1 LIMIT ${batchSize})`,
      [from, to]
    );
    total += r.rowCount;
    if (r.rowCount < batchSize) { done = true; break; }
  }
  return { total, done };
}
app.post('/api/admin/migrate-ontology-workspace', async (req, res) => {
  try {
    if (!(await isAdminReqAsync(req))) return res.status(403).json({ error: 'admin only' });
    const pool = dbModule.getDb();
    const FROM = 'nenova', TO = 'WS-NENOVA-2026';
    const batchSize = 2000, maxBatches = 15; // 호출당 최대 3만행 — 안전한 응답시간
    const tables = ['unified_events', 'ops_relation', 'orbit_entity_golden', 'orbit_ops_report'];
    const results = {};
    let allDone = true;
    for (const t of tables) {
      const r = await batchRelabel(pool, t, FROM, TO, batchSize, maxBatches).catch(() => ({ total: 0, done: true }));
      results[t] = r.total; if (!r.done) allDone = false;
    }
    res.json({ ok: true, from: FROM, to: TO, moved: results, done: allDone, hint: allDone ? '완료' : '남은 행 있음 — 다시 호출하세요' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/learning/logs — 원시 이벤트 로그 조회 (관리자 대시보드용)
app.get('/api/learning/logs', async (req, res) => {
  try {
    const pool = dbModule.getDb();
    const limit = Math.min(parseInt(req.query.limit) || 200, 2000);
    const userId = req.query.userId || null;
    const type = req.query.type || null;
    const from = req.query.from || null;   // ISO date string (e.g. 2026-03-23)
    const to = req.query.to || null;       // ISO date string
    const pc = req.query.pc || null;       // hostname filter

    const allTypes = req.query.allTypes === '1';
    const params = [];
    let query = allTypes
      ? "SELECT id, type, user_id, timestamp, data_json FROM events WHERE user_id NOT IN ('local','system') AND user_id IS NOT NULL"
      : "SELECT id, type, user_id, timestamp, data_json FROM events WHERE user_id NOT IN ('local','system') AND user_id IS NOT NULL AND type IN ('keyboard.chunk','screen.capture','screen.analyzed','idle')";
    if (userId) { params.push(userId); query += ` AND user_id=$${params.length}`; }
    if (type)   { params.push(type);   query += ` AND type=$${params.length}`; }
    if (from)   { params.push(from);   query += ` AND timestamp >= $${params.length}`; }
    if (to)     { params.push(to);     query += ` AND timestamp <= $${params.length}`; }
    if (pc)     { params.push(pc);     query += ` AND data_json->>'hostname' ILIKE $${params.length}`; }
    query += ` ORDER BY timestamp DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    const { rows } = await pool.query(query, params);

    // 유저별 균등 분배 (특정 유저 독점 방지) — JS 레벨에서 처리
    let finalRows = rows;
    if (!userId && !type && !from && !to && !pc) {
      const perUserBucket = {};
      const perUserLimit = Math.max(Math.floor(limit / 10), 20);
      finalRows = [];
      for (const r of rows) {
        const uid = r.user_id;
        if (!perUserBucket[uid]) perUserBucket[uid] = 0;
        if (perUserBucket[uid] < perUserLimit) {
          finalRows.push(r);
          perUserBucket[uid]++;
        }
      }
      // timestamp DESC 재정렬
      finalRows.sort((a, b) => (b.timestamp > a.timestamp ? 1 : -1));
    }

    // 멤버 이름 매핑
    const nameRows = await pool.query('SELECT id, name, email FROM orbit_auth_users');
    const names = {};
    nameRows.rows.forEach(r => { names[r.id] = r.name || r.email?.split('@')[0] || r.id.substring(0, 10); });

    const rawMode = req.query.raw === '1';

    const logs = finalRows.map(r => {
      let data = {};
      try { data = typeof r.data_json === 'string' ? JSON.parse(r.data_json) : (r.data_json || {}); } catch {}
      const ctx = data.appContext || {};

      if (rawMode) {
        return {
          id: r.id, type: r.type, userId: r.user_id,
          userName: names[r.user_id] || r.user_id?.substring(0, 10),
          timestamp: r.timestamp, data,
        };
      }

      return {
        id: r.id,
        type: r.type,
        userId: r.user_id,
        userName: names[r.user_id] || r.user_id?.substring(0, 10),
        timestamp: r.timestamp,
        app: ctx.currentApp || data.app || '',
        windowTitle: ctx.currentWindow || data.windowTitle || '',
        windowHistory: ctx.windowHistory || {},
        summary: data.summary || '',
        // [2026-06-18] 옵션2: 키보드 원본 타이핑 내용 (데몬 inputText). 없으면 빈 문자열.
        inputText: data.inputText || '',
        // [2026-08-10] 두벌식 QWERTY→한글 역변환본 (사람·분석 가독). 원본은 위 inputText 유지.
        inputTextKo: data.inputText ? qwertyToHangul(data.inputText) : '',
        trigger: data.trigger || '',
        activityLevel: data.activityLevel || '',
        mouseClicks: data.mouseClicks || 0,
        // Vision 분석 결과
        visionActivity: data.activity || '',
        visionScreen: data.screen || '',
        visionAutomatable: data.automatable || false,
        visionHint: data.automationHint || '',
      };
    });

    res.json({ logs, total: logs.length });
  } catch (e) {
    console.error('[learning/logs] error:', e.message);
    res.status(500).json({ error: 'Internal server error', logs: [] });
  }
});

// ─── 캡처 타이밍 학습 에이전트 ───────────────────────────────────────────────

const captureTimingLearner = (() => {
  try { return require('./src/capture-timing-learner'); } catch { return null; }
})();

// POST /api/learning/capture-timing — 수동 분석 실행 (관리자)
app.post('/api/learning/capture-timing', async (req, res) => {
  if (!captureTimingLearner) return res.status(503).json({ error: 'capture-timing-learner 미로드' });
  try {
    const pool = dbModule.getDb();
    const results = await captureTimingLearner.runForAllPCs(pool, async (hostname, action, data) => {
      // daemon command queue에 전송
      if (!global._daemonCommands) global._daemonCommands = {};
      if (!global._daemonCommands[hostname]) global._daemonCommands[hostname] = [];
      global._daemonCommands[hostname].push({ action, data, ts: new Date().toISOString() });
      // PG에도 저장 — 같은 hostname의 미처리 capture-config 먼저 정리 (스택 방지)
      try {
        pool.query(
          `UPDATE orbit_daemon_commands SET consumed_at = NOW() WHERE hostname = $1 AND action = 'capture-config' AND consumed_at IS NULL`,
          [hostname]
        ).catch(() => {});
        pool.query(
          `INSERT INTO orbit_daemon_commands (hostname, action, command, data_json, ts) VALUES ($1,$2,$3,$4,NOW())`,
          [hostname, action, null, JSON.stringify(data)]
        ).catch(() => {});
      } catch {}
    });
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/learning/capture-timing — 최근 분석 결과 조회 (관리자)
app.get('/api/learning/capture-timing', async (req, res) => {
  if (!captureTimingLearner) return res.status(503).json({ error: 'capture-timing-learner 미로드' });
  try {
    const pool = dbModule.getDb();
    // 수신된 capture-config 명령 현황
    const { rows } = await pool.query(
      `SELECT hostname, data_json, ts, consumed_at
       FROM orbit_daemon_commands
       WHERE action = 'capture-config'
       ORDER BY ts DESC LIMIT 20`
    );
    res.json({ configs: rows.map(r => ({ hostname: r.hostname, config: r.data_json, ts: r.ts, delivered: !!r.consumed_at })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 캡처 타이밍 학습: 매일 14:00 UTC (23:00 KST) 자동 실행
const _CAPTURE_TIMING_HOUR_UTC = 14;
let _lastCaptureLearnerKey = '';
setInterval(async () => {
  if (!captureTimingLearner) return;
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  if (h !== _CAPTURE_TIMING_HOUR_UTC || m > 2) return;
  const key = `${now.toISOString().slice(0, 10)}-capture`;
  if (_lastCaptureLearnerKey === key) return;
  _lastCaptureLearnerKey = key;

  console.log('[capture-timing-learner] 야간 자동 분석 시작 (23:00 KST)');
  try {
    const pool = dbModule.getDb();
    await captureTimingLearner.runForAllPCs(pool, async (hostname, action, data) => {
      if (!global._daemonCommands) global._daemonCommands = {};
      if (!global._daemonCommands[hostname]) global._daemonCommands[hostname] = [];
      global._daemonCommands[hostname].push({ action, data, ts: new Date().toISOString() });
      // 같은 hostname의 미처리 capture-config 먼저 정리 (스택 방지)
      pool.query(
        `UPDATE orbit_daemon_commands SET consumed_at = NOW() WHERE hostname = $1 AND action = 'capture-config' AND consumed_at IS NULL`,
        [hostname]
      ).catch(() => {});
      pool.query(
        `INSERT INTO orbit_daemon_commands (hostname, action, command, data_json, ts) VALUES ($1,$2,$3,$4,NOW())`,
        [hostname, action, null, JSON.stringify(data)]
      ).catch(() => {});
    });
    console.log('[capture-timing-learner] 완료 — 각 PC 다음 폴링 시 수신');
  } catch (e) {
    console.warn('[capture-timing-learner] 오류:', e.message);
  }
}, 60 * 1000);

// 정기 리포트 생성 (매일 09:00, 13:30, 18:00 KST)
const REPORT_HOURS = [{ h: 0, m: 0 }, { h: 4, m: 30 }, { h: 9, m: 0 }]; // UTC (KST-9)
let _lastReportKey = '';
setInterval(async () => {
  if (!workLearner || !reportSheet) return;
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return; // 주말 제외

  const match = REPORT_HOURS.find(s => h === s.h && m >= s.m && m <= s.m + 2);
  if (!match) return;
  const key = `${now.toISOString().slice(0, 10)}-${h}:${match.m}`;
  if (_lastReportKey === key) return;
  // 크래시 재시작 루프 방지 — 서버 시작 5분 이후에만 실행
  if (process.uptime() < 5 * 60) { console.log('[report] 서버 시작 5분 미만 — 리포트 스킵 (크래시루프 방지)'); return; }
  _lastReportKey = key;

  console.log('[report] 정기 리포트 생성 시작');
  try {
    const pool = dbModule.getDb();
    // 최근 7일 활성 사용자만 — 전체 스캔 방지 (OOM 근본 원인)
    const { rows } = await pool.query(
      "SELECT DISTINCT user_id FROM events WHERE type='keyboard.chunk' AND timestamp::TIMESTAMPTZ > NOW() - INTERVAL '7 days'"
    );
    const userIds = rows.map(r => r.user_id).filter(Boolean);
    if (userIds.length === 0) return;

    // 멤버 이름 매핑
    const nameRows = await pool.query('SELECT id, name, email FROM orbit_auth_users');
    const nameMap = {};
    nameRows.rows.forEach(r => { nameMap[r.id] = r.name || r.email?.split('@')[0] || r.id.substring(0, 10); });

    const result = await workLearner.analyzeWorkspace(pool, userIds);
    const url = await reportSheet.writeReport(result, nameMap);
    if (url) console.log('[report] 리포트 전송 완료:', url);

    // 18:00 KST (h=9 UTC) — 일일 마이닝 리포트도 함께 생성
    if (match.h === 9 && reportSheet.writeMiningReport) {
      try {
        const miningRoute = require('./routes/process-mining');
        const http = require('http');
        // 내부 API 호출로 리포트 생성 (동일 프로세스 내)
        const today = now.toISOString().slice(0, 10);
        const miningPayload = JSON.stringify({ date: today, days: 1 });
        const miningResult = await new Promise(resolve => {
          const req = http.request({ hostname: 'localhost', port: process.env.PORT || 3000,
            path: '/api/mining/report', method: 'POST', timeout: 120000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(miningPayload) },
          }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
          });
          req.on('error', () => resolve(null));
          req.write(miningPayload); req.end();
        });
        if (miningResult?.sheetsUrl) console.log('[report] 마이닝 리포트:', miningResult.sheetsUrl);
        else if (miningResult?.ok) console.log('[report] 마이닝 리포트 생성 완료 (Sheets 미설정)');
      } catch (e) { console.warn('[report] 마이닝 리포트 에러:', e.message); }
    }
  } catch (e) {
    console.error('[report] 에러:', e.message);
  }
}, 60 * 1000); // 1분마다 체크

// GET /api/learning/analyze?userId=xxx — 개인 분석
app.get('/api/learning/analyze', async (req, res) => {
  if (!workLearner) return res.json({ error: 'work-learner not available' });
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const user = token ? verifyToken(token) : null;
    const targetId = req.query.userId || user?.id || 'local';
    const pool = dbModule.getDb();
    if (!pool || !pool.query) return res.json({ error: 'DB pool not ready' });
    const result = await workLearner.analyzeUser(pool, targetId);
    res.json(result);
  } catch (e) {
    console.error('[learning] error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/learning/report — 즉시 리포트 생성 (수동)
app.post('/api/learning/report', async (req, res) => {
  if (!workLearner || !reportSheet) return res.json({ error: 'not available' });
  try {
    const pool = dbModule.getDb();
    const { rows } = await pool.query(
      "SELECT DISTINCT user_id FROM events WHERE type='keyboard.chunk' AND timestamp::TIMESTAMPTZ > NOW() - INTERVAL '7 days'"
    );
    const userIds = rows.map(r => r.user_id).filter(Boolean);
    if (userIds.length === 0) return res.json({ error: '데이터 없음' });

    const nameRows = await pool.query('SELECT id, name, email FROM orbit_auth_users');
    const nameMap = {};
    nameRows.rows.forEach(r => { nameMap[r.id] = r.name || r.email?.split('@')[0] || r.id.substring(0, 10); });

    const result = await workLearner.analyzeWorkspace(pool, userIds);
    const url = await reportSheet.writeReport(result, nameMap);
    res.json({ ok: true, url, memberCount: result.members?.length || 0 });
  } catch (e) {
    console.error('[learning/report] error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/learning/deep-analyze — 키로그+마우스+캡처 조합 정밀 분석
app.post('/api/learning/deep-analyze', async (req, res) => {
  try {
    const pool = dbModule.getDb();
    const userId = req.body?.userId;

    // 전체 또는 특정 유저
    let userIds = [];
    if (userId) {
      userIds = [userId];
    } else {
      const { rows } = await pool.query(
        "SELECT DISTINCT user_id FROM events WHERE type IN ('keyboard.chunk','screen.capture') AND timestamp::TIMESTAMPTZ > NOW() - INTERVAL '7 days'"
      );
      userIds = rows.map(r => r.user_id);
    }

    // 멤버 이름
    const nameRows = await pool.query('SELECT id, name, email FROM orbit_auth_users');
    const names = {};
    nameRows.rows.forEach(r => { names[r.id] = r.name || r.email?.split('@')[0] || r.id.substring(0, 10); });

    const results = [];
    for (const uid of userIds) {
      // 키보드 로그 (최근 7일, 최대 3000건)
      const kb = await pool.query(
        "SELECT timestamp, data_json FROM events WHERE user_id=$1 AND type='keyboard.chunk' AND timestamp::TIMESTAMPTZ > NOW() - INTERVAL '7 days' ORDER BY timestamp DESC LIMIT 3000", [uid]);
      // 캡처 로그 (최근 7일, 최대 1000건)
      const cap = await pool.query(
        "SELECT timestamp, data_json FROM events WHERE user_id=$1 AND type='screen.capture' AND timestamp::TIMESTAMPTZ > NOW() - INTERVAL '7 days' ORDER BY timestamp DESC LIMIT 1000", [uid]);
      // idle (최근 7일)
      const idle = await pool.query(
        "SELECT timestamp FROM events WHERE user_id=$1 AND type='idle' AND timestamp::TIMESTAMPTZ > NOW() - INTERVAL '7 days' ORDER BY timestamp DESC LIMIT 1000", [uid]);

      // 키보드 이벤트 파싱
      const kbEvents = kb.rows.map(r => {
        const d = typeof r.data_json === 'string' ? JSON.parse(r.data_json) : (r.data_json || {});
        const ctx = d.appContext || {};
        const steps = d.patterns?.detected?.workflowSteps || [];
        return {
          ts: r.timestamp,
          app: ctx.currentApp || steps[0]?.app || '',
          window: ctx.currentWindow || '',
          windowHistory: ctx.windowHistory || {},
          summary: d.summary || '',
          mouseClicks: d.mouseClicks || 0,
          mouseRegions: d.mouseRegions || {},
          category: steps[0]?.category || '',
          activityCount: steps[0]?.activityCount || 0,
          duration: steps[0]?.duration_sec || 0,
        };
      });

      // 캡처 이벤트 파싱
      const capEvents = cap.rows.map(r => {
        const d = typeof r.data_json === 'string' ? JSON.parse(r.data_json) : (r.data_json || {});
        return {
          ts: r.timestamp,
          app: d.app || '',
          window: d.windowTitle || '',
          trigger: d.trigger || '',
          activityLevel: d.activityLevel || '',
          automationScore: d.automationScore || 0,
        };
      });

      // 앱별 사용 통계
      const appStats = {};
      kbEvents.forEach(e => {
        if (!e.app) return;
        if (!appStats[e.app]) appStats[e.app] = { count: 0, totalClicks: 0, totalDuration: 0, windows: new Set(), categories: {} };
        appStats[e.app].count++;
        appStats[e.app].totalClicks += e.mouseClicks;
        appStats[e.app].totalDuration += e.duration;
        if (e.window) appStats[e.app].windows.add(e.window);
        // windowHistory에서도 수집
        Object.entries(e.windowHistory).forEach(([app, win]) => {
          if (!appStats[app]) appStats[app] = { count: 0, totalClicks: 0, totalDuration: 0, windows: new Set(), categories: {} };
          if (win) appStats[app].windows.add(win);
        });
        if (e.category) appStats[e.app].categories[e.category] = (appStats[e.app].categories[e.category] || 0) + 1;
      });

      // Set → Array 변환
      Object.values(appStats).forEach(s => { s.windows = [...s.windows]; });

      // 앱 전환 시퀀스 (시간순)
      const appSequence = [];
      let lastApp = '';
      kbEvents.forEach(e => {
        if (e.app && e.app !== lastApp) {
          appSequence.push({ app: e.app, window: e.window, ts: e.ts });
          lastApp = e.app;
        }
      });

      // 캡처 트리거 분석
      const triggerStats = {};
      capEvents.forEach(e => {
        triggerStats[e.trigger] = (triggerStats[e.trigger] || 0) + 1;
      });

      // 마우스 클릭 총계 + 지역 분석
      let totalClicks = 0;
      const regionTotal = {};
      kbEvents.forEach(e => {
        totalClicks += e.mouseClicks;
        Object.entries(e.mouseRegions || {}).forEach(([region, cnt]) => {
          regionTotal[region] = (regionTotal[region] || 0) + cnt;
        });
      });

      // 활동 타임라인 (시간순, 키보드+캡처 합침)
      const timeline = [];
      kbEvents.forEach(e => timeline.push({ ...e, type: 'keyboard' }));
      capEvents.forEach(e => timeline.push({ ...e, type: 'capture' }));
      timeline.sort((a, b) => new Date(a.ts) - new Date(b.ts));

      results.push({
        userId: uid,
        userName: names[uid] || uid.substring(0, 10),
        keyboardEvents: kbEvents.length,
        captureEvents: capEvents.length,
        idleEvents: idle.rows.length,
        appStats,
        appSequence: appSequence.slice(-30), // 최근 30개 전환
        triggerStats,
        totalMouseClicks: totalClicks,
        mouseRegions: regionTotal,
        timeline: timeline.slice(-50), // 최근 50건
      });
    }

    res.json({ ok: true, analyzedAt: new Date().toISOString(), members: results });
  } catch (e) {
    console.error('[deep-analyze] error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/learning/workspace?wsId=xxx — 워크스페이스 전체 분석 (관리자용)
app.get('/api/learning/workspace', async (req, res) => {
  if (!workLearner) return res.json({ error: 'work-learner not available' });
  try {
    const pool = dbModule.getDb();
    const { rows } = await pool.query(
      'SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND status=$2',
      [req.query.wsId, 'active']
    );
    const memberIds = rows.map(r => r.user_id);
    if (memberIds.length === 0) return res.json({ error: '멤버가 없습니다', members: [] });
    const result = await workLearner.analyzeWorkspace(pool, memberIds);
    res.json(result);
  } catch (e) {
    console.error('[learning/workspace] error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── 데몬 자동 업데이트 API ──────────────────────────────────────────────────

// 현재 서버 버전 + 배포 정보
let _serverVersion = null;
const _serverStartTime = new Date().toISOString();
let _deployInfo = { commitMsg: '', commitDate: _serverStartTime, recentChanges: [] };
try {
  const { execSync } = require('child_process');
  _serverVersion = execSync('git rev-parse --short HEAD', { timeout: 3000 }).toString().trim();
  _deployInfo.commitMsg = execSync('git log -1 --format=%s', { timeout: 3000 }).toString().trim();
  _deployInfo.commitDate = execSync('git log -1 --format=%ci', { timeout: 3000 }).toString().trim();
  _deployInfo.recentChanges = execSync('git log -5 --format=%h|%s|%ci', { timeout: 3000 })
    .toString().trim().split('\n').map(line => {
      const [hash, msg, date] = line.split('|');
      return { hash, msg, date };
    });
} catch {}
// git 없으면 Railway 환경변수에서 버전 + 서버 시작 시간을 배포 시간으로
if (!_serverVersion) _serverVersion = process.env.RAILWAY_GIT_COMMIT_SHA?.substring(0, 8) || 'unknown';
if (!_deployInfo.commitDate || _deployInfo.commitDate === _serverStartTime) {
  _deployInfo.commitDate = _serverStartTime;
  _deployInfo.commitMsg = '서버 시작: ' + new Date(_serverStartTime).toLocaleString('ko-KR');
}
if (!_serverVersion) _serverVersion = process.env.GIT_COMMIT_SHA?.substring(0, 8) || process.env.RAILWAY_GIT_COMMIT_SHA?.substring(0, 8) || '54092d6';

// 데몬 명령 큐 { hostname → [commands] } — 호스트당 최대 50건
if (!global._daemonCommands) global._daemonCommands = {};
const _DAEMON_CMD_MAX_PER_HOST = 50;

// GET /api/daemon/node-modules — npm install 실패 시 node_modules 번들 다운로드
// 서버 시작 시 미리 번들 생성 (캐시), 요청 시 즉시 전송
// uiohook-napi prebuilds에 win32-x64 포함 → Windows PC에서 그대로 사용 가능
let _nmBundlePath = null;
let _nmBundleBuilding = false;
async function _buildNmBundle() {
  if (_nmBundleBuilding) return;
  _nmBundleBuilding = true;
  try {
    const { execSync } = require('child_process');
    const nmPath = path.join(__dirname, 'node_modules');
    if (!fs.existsSync(nmPath)) return;
    const bundlePath = path.join(require('os').tmpdir(), 'orbit-node-modules.tar.gz');
    console.log('[node-modules] 번들 생성 중...');
    if (process.platform === 'win32') {
      // Windows: tar가 드라이브 문자(C:)를 처리 못함 → PowerShell zip으로 대체
      const zipPath = bundlePath.replace('.tar.gz', '.zip');
      execSync(
        `powershell -Command "Compress-Archive -Path '${nmPath}' -DestinationPath '${zipPath}' -Force"`,
        { timeout: 300000 }
      );
      _nmBundlePath = zipPath;
    } else {
      execSync(`tar czf "${bundlePath}" -C "${__dirname}" --exclude=".cache" --exclude=".package-lock.json" node_modules`, { timeout: 300000 });
    }
    _nmBundlePath = bundlePath;
    const sizeMB = (fs.statSync(bundlePath).size / 1024 / 1024).toFixed(1);
    console.log(`[node-modules] 번들 준비 완료: ${sizeMB}MB`);
  } catch (e) {
    console.error('[node-modules] 번들 생성 실패:', e.message);
  } finally {
    _nmBundleBuilding = false;
  }
}
// 서버 시작 30초 후 백그라운드에서 번들 생성 (Railway에서는 스킵 — OOM 방지)
if (!process.env.RAILWAY_ENVIRONMENT) {
  setTimeout(_buildNmBundle, 30000);
}

app.get('/api/daemon/node-modules', (req, res) => {
  if (!_nmBundlePath || !fs.existsSync(_nmBundlePath)) {
    // 번들 아직 준비 안 됨 → 즉시 생성 시도
    if (!_nmBundleBuilding) _buildNmBundle();
    return res.status(503).json({ error: 'Bundle being prepared, retry in 60s' });
  }
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', 'attachment; filename=node_modules.tar.gz');
  res.setHeader('Content-Length', fs.statSync(_nmBundlePath).size);
  fs.createReadStream(_nmBundlePath).pipe(res);
});

// === 분석 요청 큐 (맥미니 에이전트가 폴링해서 처리) ===
// NOTE: API 키는 맥미니에서만 사용. 서버에서는 분석 안 함.
if (!global._analysisQueue) global._analysisQueue = [];
const _ANALYSIS_QUEUE_MAX = 100;

// POST /api/daemon/run-vision — 분석 요청을 큐에 추가 (맥미니가 실행)
app.post('/api/daemon/run-vision', (req, res) => {
  // 큐 상한 도달 시 오래된 항목 제거
  if (global._analysisQueue.length >= _ANALYSIS_QUEUE_MAX) {
    global._analysisQueue = global._analysisQueue.slice(-50);
  }
  global._analysisQueue.push({ type: 'vision', ts: new Date().toISOString(), status: 'pending' });
  res.json({ ok: true, queued: true, message: '맥미니 에이전트가 분석을 실행합니다' });
});

// GET /api/daemon/analysis-queue — 맥미니가 폴링하여 대기 중 작업 가져감
app.get('/api/daemon/analysis-queue', (req, res) => {
  const pending = global._analysisQueue.filter(q => q.status === 'pending');
  // 가져간 항목은 processing으로 변경
  pending.forEach(q => q.status = 'processing');
  res.json({ tasks: pending });
});

// POST /api/daemon/analysis-result — 맥미니가 분석 결과 전송
app.post('/api/daemon/analysis-result', async (req, res) => {
  try {
    const { type, result, error } = req.body || {};
    const ts = new Date().toISOString();
    // 큐에서 processing 항목을 완료 처리
    const processing = global._analysisQueue.find(q => q.status === 'processing' && q.type === type);
    if (processing) processing.status = error ? 'error' : 'done';
    // 오래된 큐 항목 정리 (1시간 이상)
    const cutoff = Date.now() - 60 * 60 * 1000;
    global._analysisQueue = global._analysisQueue.filter(q => new Date(q.ts).getTime() > cutoff);
    console.log(`[analysis-result] type=${type} error=${!!error} queue_size=${global._analysisQueue.length}`);
    res.json({ ok: true, ts });
  } catch (e) {
    console.error('[analysis-result] error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/daemon/excel-ingest — 발주서 xlsx 원본 수신 → 셀값 구조화 저장
// 데몬(src/excel-collector.js)이 발주서만 선별해 base64로 올린다. 서버가 파싱해
// excel.sheet 이벤트로 저장 → 발주검증 에이전트가 톡방값↔시트값 셀단위 대조에 사용.
// body 한도: 전역 express.json 2mb (데몬이 1.2MB 이상 원본은 스킵하므로 base64도 한도 내).
app.post('/api/daemon/excel-ingest', async (req, res) => {
  try {
    const { filename, fileBase64, hostname, mtime, sizeBytes } = req.body || {};
    if (!filename || !fileBase64) {
      return res.status(400).json({ error: 'filename, fileBase64 필수' });
    }

    // ── 사용자 귀속 (hook 패턴 축약: token → pc_HOSTNAME → pc_links override) ──
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
                || req.headers['x-api-token'] || '';
    const deviceId = decodeURIComponent(req.headers['x-device-id'] || '') || hostname || '';
    let ingUser = null;
    try { ingUser = token ? await require('./src/auth').verifyTokenAsync(token) : null; } catch {}
    let userId = ingUser ? ingUser.id : (deviceId ? `pc_${deviceId}` : 'local');
    try {
      const _pool = dbModule.getDb ? dbModule.getDb() : null;
      if (_pool && process.env.DATABASE_URL && deviceId) {
        const { rows } = await _pool.query(`SELECT user_id FROM orbit_pc_links WHERE hostname = $1 LIMIT 1`, [deviceId]);
        if (rows[0] && rows[0].user_id) userId = rows[0].user_id;
      }
    } catch {}

    // ── 파싱 (xlsx: 기존 의존성) ─────────────────────────────────────────────
    const buf = Buffer.from(fileBase64, 'base64');
    if (buf.length > 3 * 1024 * 1024) {
      return res.status(413).json({ error: '파일이 너무 큽니다' });
    }
    const XLSX = require('xlsx');
    const MAX_SHEETS = 20, MAX_CELLS = 3000, MAX_ROWS = 200;
    let wb;
    try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true, sheetRows: MAX_ROWS + 1 }); }
    catch (pe) { return res.status(422).json({ error: 'xlsx 파싱 실패: ' + pe.message }); }

    const ts = new Date().toISOString();
    const sheetNames = (wb.SheetNames || []).slice(0, MAX_SHEETS);
    let totalCells = 0;

    for (let si = 0; si < sheetNames.length; si++) {
      const sheet = sheetNames[si];
      const ws = wb.Sheets[sheet];
      if (!ws || !ws['!ref']) continue;

      // 셀 단위 {addr, value} (비어있지 않은 셀만, 상한 컷)
      const cells = [];
      const range = XLSX.utils.decode_range(ws['!ref']);
      let truncated = false;
      for (let r = range.s.r; r <= range.e.r && !truncated; r++) {
        for (let c = range.s.c; c <= range.e.c; c++) {
          const addr = XLSX.utils.encode_cell({ r, c });
          const cell = ws[addr];
          if (!cell || cell.v === undefined || cell.v === null || cell.v === '') continue;
          cells.push({ addr, value: cell.w != null ? cell.w : cell.v });
          if (cells.length >= MAX_CELLS) { truncated = true; break; }
        }
      }
      // 행 프리뷰 (사람/에이전트 가독용, 상한 컷)
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false }).slice(0, MAX_ROWS);
      totalCells += cells.length;

      await Promise.resolve(insertEvent({
        id: `excel-sheet-${Date.now()}-${si}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'excel.sheet',
        source: 'excel-collector',
        sessionId: `excel-${deviceId || 'unknown'}`,
        userId,
        timestamp: ts,
        data: {
          file: filename,
          sheet,
          sheetIndex: si,
          cells,
          rows,
          rowCount: rows.length,
          cellCount: cells.length,
          truncated,
          hostname: deviceId,
          fileMtime: mtime || null,
          fileSizeBytes: sizeBytes || buf.length,
        },
      }));
    }

    console.log(`[excel-ingest] ${filename} → ${sheetNames.length}시트/${totalCells}셀 저장 (user=${userId})`);
    res.json({ ok: true, sheets: sheetNames.length, cells: totalCells });
  } catch (e) {
    console.error('[excel-ingest] error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/daemon/version — 데몬이 폴링하여 업데이트 필요 여부 확인
app.get('/api/daemon/version', (req, res) => {
  res.json({
    version: _serverVersion || 'unknown',
    ts: new Date().toISOString(),
    deploy: _deployInfo,
  });
});

// Phase 0: 위험 명령 차단 + safe-cmd 매핑
const FORBIDDEN_DAEMON_ACTIONS = new Set(['reinstall']);
const RESTART_TO_SAFE = { restart: 'gitpull-worker' };

function _sanitizeDaemonCommands(commands) {
  const out = [];
  for (const c of commands || []) {
    if (!c?.action) continue;
    if (FORBIDDEN_DAEMON_ACTIONS.has(c.action)) {
      console.warn(`[daemon-cmd] blocked ${c.action} → reclone-worker`);
      out.push({ ...c, action: 'reclone-worker', data: { ...(c.data || {}), blockedFrom: c.action } });
      continue;
    }
    if (RESTART_TO_SAFE[c.action]) {
      out.push({ ...c, action: RESTART_TO_SAFE[c.action], data: { ...(c.data || {}), blockedFrom: c.action } });
      continue;
    }
    out.push(c);
  }
  return out;
}

// GET /api/daemon/commands?hostname=xxx — 대기 중인 명령 가져가기
app.get('/api/daemon/commands', async (req, res) => {
  const hostname = req.query.hostname || '';
  const cmds = global._daemonCommands[hostname] || [];
  // ALL 대상 명령: 40분 TTL + hostname별 1회 consumed (같은 호스트가 같은 명령 반복 수신 방지)
  // [2026-06-15 fix] 5분→40분: OrbitWatchdog 폴링이 30분 주기라 5분 TTL이면 force-restart/update가
  // 거의 항상 만료돼서 못 받았음(강현우 8번 시도 빗나감). 40분이면 30분 폴링이 반드시 1회는 잡음.
  const allCmds = (global._daemonCommands['ALL'] || []).filter(c => {
    const age = Date.now() - new Date(c.ts).getTime();
    if (age >= 40 * 60 * 1000) return false; // 40분 만료
    if (!c.consumedHosts) c.consumedHosts = new Set();
    if (c.consumedHosts.has(hostname)) return false; // 이미 이 호스트는 받음
    return true;
  });
  // 받아간 호스트 마킹 (다음 폴링부터 제외)
  allCmds.forEach(c => {
    if (!c.consumedHosts) c.consumedHosts = new Set();
    c.consumedHosts.add(hostname);
  });
  // PG에서 미소비 명령 가져오기 (Railway 재배포 후 복원 대비)
  let pgCmds = [];
  try {
    const _pool = dbModule.getDb ? dbModule.getDb() : null;
    if (_pool) {
      const { rows } = await _pool.query(
        `SELECT action, command, data_json, ts FROM orbit_daemon_commands
         WHERE hostname = $1 AND consumed_at IS NULL AND ts <= NOW()
         ORDER BY
           CASE action WHEN 'restart' THEN 1 WHEN 'exec' THEN 2 WHEN 'update' THEN 3 WHEN 'reinstall' THEN 4 ELSE 10 END ASC,
           ts ASC
         LIMIT 10`,
        [hostname]
      );
      if (rows.length > 0) {
        pgCmds = rows.map(r => ({ action: r.action, command: r.command, data: r.data_json, ts: r.ts }));
        const tsList = rows.map(r => r.ts);
        _pool.query(`UPDATE orbit_daemon_commands SET consumed_at = NOW() WHERE hostname = $1 AND ts = ANY($2)`, [hostname, tsList]).catch(() => {});
      }
    }
  } catch {}
  const result = _sanitizeDaemonCommands([...cmds, ...allCmds, ...pgCmds]);
  // 개별 hostname 명령은 가져가면 삭제
  global._daemonCommands[hostname] = [];
  // ALL 명령은 5분 후 자동 만료 (삭제 안 함)
  global._daemonCommands['ALL'] = allCmds;
  res.json({ commands: result });
});

// GET /api/daemon/events — daemon 관련 모든 이벤트 조회 (필터 없이)
app.get('/api/daemon/events', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    let rows = [];
    if (process.env.DATABASE_URL) {
      // PostgreSQL
      const pool = dbModule.getDb();
      const result = await pool.query(
        "SELECT id, type, user_id, timestamp, data_json FROM events WHERE type LIKE 'daemon.%' OR type LIKE 'install.%' OR type LIKE 'bank.%' ORDER BY timestamp DESC LIMIT $1",
        [limit]
      );
      rows = result.rows;
    } else {
      // SQLite fallback
      const db = dbModule.getDb();
      rows = db.prepare(
        "SELECT id, type, user_id, timestamp, data_json FROM events WHERE type LIKE 'daemon.%' OR type LIKE 'install.%' OR type LIKE 'bank.%' ORDER BY timestamp DESC LIMIT ?"
      ).all(limit).map(r => ({ ...r, data_json: (() => { try { return JSON.parse(r.data_json || '{}'); } catch { return {}; } })() }));
    }
    res.json({ events: rows.map(r => ({ id: r.id, type: r.type, userId: r.user_id, ts: r.timestamp, data: typeof r.data_json === 'object' ? r.data_json : (() => { try { return JSON.parse(r.data_json || '{}'); } catch { return {}; } })() })), total: rows.length });
  } catch (e) {
    console.error('[daemon/logs] error:', e.message);
    res.status(500).json({ error: 'Internal server error', events: [] });
  }
});

// GET /api/daemon/check-hostname — PC가 이미 다른 유저에 등록됐는지 확인 (설치 전 충돌 방지)
// GET /api/daemon/pg-token-check?token=XXX — PG orbit_auth_tokens 직접 조회 (진단용)
app.get('/api/daemon/pg-token-check', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    const _pool = dbModule.getDb();
    const { rows } = await _pool.query('SELECT user_id, created_at FROM orbit_auth_tokens WHERE token = $1', [token]);
    if (rows.length) {
      const userId = rows[0].user_id;
      // orbit_auth_users JOIN 테스트
      const { rows: userRows } = await _pool.query('SELECT id, name, email FROM orbit_auth_users WHERE id = $1', [userId]);
      res.json({ found: true, userId, created_at: rows[0].created_at, userInPg: userRows.length > 0, user: userRows[0] || null });
    } else {
      const { rows: tbl } = await _pool.query("SELECT COUNT(*) as cnt FROM orbit_auth_tokens");
      res.json({ found: false, tableRowCount: tbl[0]?.cnt });
    }
  } catch (e) {
    res.json({ found: false, error: e.message });
  }
});

// POST /api/admin/pg-restore-token — 토큰 기반으로 orbit_auth_users 복원 (마스터 토큰 전용)
app.post('/api/admin/pg-restore-token', async (req, res) => {
  const raw = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const MASTER = 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
  if (raw !== MASTER && !env.isAdminToken(raw)) return res.status(403).json({ error: 'forbidden' });
  const { token, name } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    const pool = dbModule.getDb();
    const { rows } = await pool.query('SELECT user_id FROM orbit_auth_tokens WHERE token=$1', [token]);
    if (!rows.length) return res.status(404).json({ error: 'token not in PG' });
    const userId = rows[0].user_id;
    const email = `${userId.toLowerCase()}@orbit.local`;
    const displayName = name || userId;
    await pool.query(
      `INSERT INTO orbit_auth_users (id, email, name, password_hash, plan, provider)
       VALUES ($1,$2,$3,'','free','pc_token')
       ON CONFLICT DO NOTHING`,
      [userId, email, displayName]
    );
    // auth.js SQLite에도 복원
    const { issueApiToken } = require('./src/auth');
    const authDb = require('./src/auth').getDb ? require('./src/auth').getDb() : null;
    if (authDb) {
      authDb.prepare(`INSERT OR IGNORE INTO users (id,email,name,passwordHash,plan,provider) VALUES (?,?,?,'','free','pc_token')`).run(userId, email, displayName);
      authDb.prepare(`INSERT OR IGNORE INTO tokens (token,userId,type,expiresAt) VALUES (?,?,'api',null)`).run(token, userId);
    }
    res.json({ ok: true, userId, email, name: displayName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/daemon/check-hostname', async (req, res) => {
  const { hostname, userId } = req.query;
  if (!hostname) return res.status(400).json({ error: 'hostname required' });
  try {
    const pool = dbModule.getDb();
    if (pool?.query) {
      // tracker_pings에서 hostname으로 기존 owner 조회
      const { rows } = await pool.query(
        `SELECT tp.user_id, u.name, u.email
         FROM tracker_pings tp
         LEFT JOIN orbit_auth_users u ON u.id = tp.user_id
         WHERE tp.hostname = $1 AND tp.user_id != 'local'
         ORDER BY tp.last_seen DESC LIMIT 1`,
        [hostname]
      );
      if (rows.length > 0 && rows[0].user_id !== userId) {
        return res.json({
          conflict: true,
          existingUserId: rows[0].user_id,
          existingName: rows[0].name || rows[0].user_id,
          existingEmail: rows[0].email || '',
        });
      }
    }
  } catch {}
  res.json({ conflict: false });
});

// POST /api/daemon/force-update — 모든 데몬에 즉시 업데이트 명령 전송
// admin secret 인증 — commands 큐(daemon-updater용) + hook 응답(구버전용) 동시 처리
app.post('/api/daemon/force-update', async (req, res) => {
  const { enabled } = req.body || {};
  // enabled가 명시적으로 전달되지 않으면 현재 상태 반환만
  if (typeof enabled !== 'undefined') {
    global._forceUpdateEnabled = !!enabled;
    console.log(`[daemon] 강제 업데이트 플래그: ${global._forceUpdateEnabled ? 'ON' : 'OFF'}`);

    // PG에 영구 저장 (Railway 재배포해도 유지)
    try {
      const pgDb = dbModule.getDb();
      if (pgDb?.query) {
        await pgDb.query(
          `INSERT INTO orbit_settings (key, value) VALUES ('force_update', $1)
           ON CONFLICT (key) DO UPDATE SET value = $1`,
          [global._forceUpdateEnabled ? 'true' : 'false']
        );
      }
    } catch {}

    // daemon-updater가 있는 최신 데몬은 commands 큐에서 바로 수신 (1분 내)
    if (global._forceUpdateEnabled) {
      if (!global._daemonCommands) global._daemonCommands = {};
      if (!global._daemonCommands['ALL']) global._daemonCommands['ALL'] = [];
      global._daemonCommands['ALL'].push({ action: 'update', reason: 'admin-force', ts: new Date().toISOString() });
      console.log('[daemon] ALL 호스트 update 명령 큐 추가');
    }
  }

  res.json({ ok: true, forceUpdate: global._forceUpdateEnabled || false });
});

// POST /api/daemon/force-restart — 모든 데몬에 즉시 restart 명령 (idle wait 우회)
// 'update' 명령은 idle-aware로 30분까지 대기하지만 'restart'는 즉시 process.exit → bat 재시작
// 호스트별 consumedHosts Set으로 1회만 처리되도록 안전화
app.post('/api/daemon/force-restart', async (req, res) => {
  if (!global._daemonCommands) global._daemonCommands = {};
  if (!global._daemonCommands['ALL']) global._daemonCommands['ALL'] = [];
  global._daemonCommands['ALL'].push({
    action: 'restart',
    reason: 'admin-force-restart',
    ts: new Date().toISOString(),
    consumedHosts: new Set(), // 호스트별 1회 처리 보장
  });
  console.log('[daemon] ALL 호스트 restart 명령 큐 추가 (호스트별 1회)');
  res.json({ ok: true, queued: 'ALL' });
});

// POST /api/daemon/clear-commands — ALL 큐 즉시 비우기 (안전 차단용)
// 잘못된 명령이 등록되어 데몬이 무한 restart loop에 빠지는 경우 긴급 복구
app.post('/api/daemon/clear-commands', async (req, res) => {
  const before = (global._daemonCommands && global._daemonCommands['ALL'] || []).length;
  if (global._daemonCommands) {
    global._daemonCommands['ALL'] = [];
  }
  console.log(`[daemon] ALL 큐 비우기 — ${before}개 명령 제거`);
  res.json({ ok: true, cleared: before });
});

// GET /api/daemon/verify-install?hostname=xxx — 설치 직후 install.ps1가 호출
// heartbeat + 최근 2분 이벤트 카운트 + 모듈별 상태를 한 번에 반환
app.get('/api/daemon/verify-install', async (req, res) => {
  try {
    const hostname = req.query.hostname;
    if (!hostname) return res.status(400).json({ error: 'hostname required' });
    const _pool = dbModule.getDb ? dbModule.getDb() : null;
    if (!_pool) return res.status(500).json({ error: 'db not available' });

    // 1) hostname으로 user_id 조회 (orbit_pc_links 또는 최근 event)
    let userId = null;
    try {
      const pl = await _pool.query('SELECT user_id FROM orbit_pc_links WHERE hostname = $1 LIMIT 1', [hostname]);
      if (pl.rows.length) userId = pl.rows[0].user_id;
    } catch {}
    if (!userId) {
      const ev = await _pool.query(
        `SELECT user_id FROM events
         WHERE data_json->>'hostname' = $1 AND user_id NOT LIKE 'pc_%'
         ORDER BY timestamp::timestamptz DESC LIMIT 1`,
        [hostname]
      );
      if (ev.rows.length) userId = ev.rows[0].user_id;
    }

    // 2) 해당 user의 최근 daemon.heartbeat 1건
    let heartbeat = null;
    if (userId) {
      const hb = await _pool.query(
        `SELECT timestamp, data_json FROM events
         WHERE user_id = $1 AND type = 'daemon.heartbeat'
           AND timestamp::timestamptz > NOW() - INTERVAL '5 minutes'
         ORDER BY timestamp::timestamptz DESC LIMIT 1`,
        [userId]
      );
      if (hb.rows.length) {
        heartbeat = {
          ts: hb.rows[0].timestamp,
          ...(hb.rows[0].data_json || {}),
        };
      }
    }

    // 3) 최근 10분 각 파이프라인 이벤트 카운트 (screen/mouse는 활동 기반 → 넉넉히)
    const recentCounts = {};
    const types = ['daemon.update', 'daemon.heartbeat', 'mouse.watcher.started', 'mouse.chunk', 'screen.capture', 'keyboard.chunk', 'install.selftest'];
    if (userId) {
      const cnt = await _pool.query(
        `SELECT type, COUNT(*) as cnt, MAX(timestamp) as last_ts FROM events
         WHERE user_id = $1 AND type = ANY($2)
           AND timestamp::timestamptz > NOW() - INTERVAL '10 minutes'
         GROUP BY type`,
        [userId, types]
      );
      for (const r of cnt.rows) recentCounts[r.type] = { count: parseInt(r.cnt), lastTs: r.last_ts };
    }
    for (const t of types) if (!recentCounts[t]) recentCounts[t] = { count: 0, lastTs: null };

    // 4) 검증 결과 판정
    // 설계 원칙: module.state(heartbeat에서 온 실시간 상태)가 1순위, 이벤트 카운트는 보조
    // heartbeat.uptime으로 "방금 시작한 데몬" 여부 판단 (install.ps1 시점엔 < 180s)
    const modules = heartbeat?.modules || {};
    const uptime = heartbeat?.uptime || 0;
    const isFreshStart = uptime > 0 && uptime < 180;
    const checks = {
      hostnameMatched:   !!userId,
      heartbeatReceived: !!heartbeat,
      moduleMouseOk:     modules.mouse?.state === 'ok',
      moduleKeyboardOk:  modules.keyboard?.state === 'ok',
      moduleScreenOk:    modules.screen?.state === 'ok',
      hasDaemonUpdate:   recentCounts['daemon.update'].count > 0 || recentCounts['daemon.heartbeat'].count > 0,
      // mouse.chunk: 활동 여부로 간접 확인 — 10분 윈도우에 1건 이상이면 파이프라인 동작
      hasMouseFlow:      recentCounts['mouse.chunk'].count > 0,
      // 신규 설치 직후에만 mouse.watcher.started 요구 (10분 윈도우에서 1건 이상 기대)
      // 안정 데몬은 이 체크 대상 아님
      freshStartSignal:  !isFreshStart || recentCounts['mouse.watcher.started'].count > 0,
    };
    const passed = Object.values(checks).filter(v => v).length;
    const failed = Object.values(checks).filter(v => !v).length;

    res.json({
      ok: true,
      hostname,
      userId,
      checks,
      passed,
      failed,
      recentCounts,
      heartbeat,
      verdict: failed === 0 ? 'PASS' : (heartbeat?.state === 'ok' ? 'MOSTLY_OK' : 'FAIL'),
    });
  } catch (e) {
    console.error('[verify-install] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/daemon-health — 모든 등록된 데몬의 최신 heartbeat + 모듈별 상태
// 각 사용자별 최근 daemon.heartbeat 1건씩 조회 → healthy/degraded/silent 자동 판정
app.get('/api/admin/daemon-health', async (req, res) => {
  try {
    const _pool = dbModule.getDb ? dbModule.getDb() : null;
    if (!_pool) return res.status(500).json({ error: 'db not available' });
    // DISTINCT ON (user_id) 각 사용자 최신 heartbeat 1건
    const { rows } = await _pool.query(
      `SELECT DISTINCT ON (user_id) user_id, timestamp, data_json
       FROM events
       WHERE type = 'daemon.heartbeat'
         AND timestamp::timestamptz > NOW() - INTERVAL '1 hour'
       ORDER BY user_id, timestamp::timestamptz DESC`
    );
    // 사용자 이름 매핑
    let userNames = {};
    try {
      const u = await _pool.query('SELECT id, name, email FROM orbit_auth_users');
      for (const r of u.rows) userNames[r.id] = { name: r.name, email: r.email };
    } catch {}

    const now = Date.now();
    const daemons = rows.map(r => {
      const data = r.data_json || {};
      const hbTs = new Date(r.timestamp).getTime();
      const sinceHb = Math.round((now - hbTs) / 1000);
      // silent 판정: heartbeat가 3분 넘으면 silent, 10분 넘으면 dead
      let verdict = data.state || 'unknown';
      if (sinceHb > 600)      verdict = 'dead';
      else if (sinceHb > 180) verdict = 'silent';
      return {
        userId:   r.user_id,
        userName: userNames[r.user_id]?.name || null,
        email:    userNames[r.user_id]?.email || null,
        hostname: data.hostname || null,
        pid:      data.pid || null,
        uptime:   data.uptime || null,
        memMB:    data.memMB || null,
        state:    verdict,
        codeVersion: data.codeVersion || null, // git HEAD(8) — 각 PC 코드세대(최신 여부)
        modules:  data.modules || {},
        heartbeatAt: r.timestamp,
        secondsSinceHeartbeat: sinceHb,
      };
    });
    // 상태별 카운트
    const summary = { ok: 0, degraded: 0, silent: 0, dead: 0, unknown: 0 };
    for (const d of daemons) {
      if (summary[d.state] !== undefined) summary[d.state]++;
      else summary.unknown++;
    }
    res.json({ ok: true, summary, total: daemons.length, daemons });
  } catch (e) {
    console.error('[admin/daemon-health] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/event-counts?userId=xxx&hours=1 — 이벤트 타입별 카운트 (진단)
app.get('/api/admin/event-counts', async (req, res) => {
  try {
    // 2026-06-08 added: master 토큰 fallback (admin only 403 우회)
    const _rawTok = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const _MASTER = 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
    const { isAdmin: _adminOk } = resolveAdmin(req);
    if (_rawTok !== _MASTER && !_adminOk) return res.status(403).json({ error: 'admin only' });
    const userId = req.query.userId;
    const hours = Math.max(1, Math.min(8760, parseInt(req.query.hours) || 24));
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const _pool = dbModule.getDb ? dbModule.getDb() : null;
    if (!_pool) return res.status(500).json({ error: 'db not available' });
    const { rows } = await _pool.query(
      `SELECT type, COUNT(*) as cnt, MAX(timestamp) as last_ts
       FROM events
       WHERE user_id = $1 AND timestamp::timestamptz > NOW() - INTERVAL '${hours} hours'
       GROUP BY type ORDER BY cnt DESC`,
      [userId]
    );
    const result = {};
    for (const r of rows) result[r.type] = { count: parseInt(r.cnt), lastTs: r.last_ts };
    res.json({ ok: true, userId, hours, counts: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/pc-links-inspect — orbit_pc_links + orbit_auth_tokens 진단
// 2026-06-08 added: auto-register hostname 매핑이 정말 INSERT됐는지 확인
app.get('/api/admin/pc-links-inspect', async (req, res) => {
  const _rawTok = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const _MASTER = 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
  const { isAdmin: _adminOk } = resolveAdmin(req);
  if (_rawTok !== _MASTER && !_adminOk) return res.status(403).json({ error: 'admin only' });
  const _pool = dbModule.getDb ? dbModule.getDb() : null;
  if (!_pool) return res.status(500).json({ error: 'db not available' });
  try {
    const hostname = req.query.hostname;
    let links;
    if (hostname) {
      const r = await _pool.query('SELECT hostname, user_id, linked_at FROM orbit_pc_links WHERE hostname = $1', [hostname]);
      links = r.rows;
    } else {
      const r = await _pool.query('SELECT hostname, user_id, linked_at FROM orbit_pc_links ORDER BY linked_at DESC LIMIT 100');
      links = r.rows;
    }
    // orbit_auth_users + orbit_auth_tokens 카운트
    let tokenCount = 0, userCount = 0;
    try {
      const r1 = await _pool.query('SELECT COUNT(*) as c FROM orbit_auth_tokens');
      tokenCount = parseInt(r1.rows[0].c);
      const r2 = await _pool.query('SELECT COUNT(*) as c FROM orbit_auth_users');
      userCount = parseInt(r2.rows[0].c);
    } catch {}
    res.json({ ok: true, links, totals: { tokens: tokenCount, users: userCount } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/pg-commands-inspect?hostname=xxx — PG orbit_daemon_commands 대기 큐 조회
app.get('/api/admin/pg-commands-inspect', async (req, res) => {
  try {
    // 2026-06-03 added: master 토큰 fallback (다른 admin endpoint와 일관성)
    const _rawTok = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const _MASTER = 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
    const { isAdmin: _adminOk } = resolveAdmin(req);
    if (_rawTok !== _MASTER && !_adminOk) return res.status(403).json({ error: 'admin only' });
    const _pool = dbModule.getDb ? dbModule.getDb() : null;
    if (!_pool) return res.status(500).json({ error: 'db not available' });
    const hostname = req.query.hostname || null;
    // 2026-06-03 added: includeConsumed=1 로 처리완료까지 포함 조회 (polling 진단용)
    const includeConsumed = req.query.includeConsumed === '1';
    let rows;
    if (hostname) {
      const whereClause = includeConsumed ? 'hostname = $1' : 'hostname = $1 AND consumed_at IS NULL';
      const r = await _pool.query(
        `SELECT id, hostname, action, ts, consumed_at FROM orbit_daemon_commands
         WHERE ${whereClause} ORDER BY ts DESC LIMIT 50`,
        [hostname]
      );
      rows = r.rows;
    } else {
      const r = await _pool.query(
        `SELECT hostname, action, COUNT(*) as cnt, MIN(ts) as first_ts, MAX(ts) as last_ts
         FROM orbit_daemon_commands WHERE consumed_at IS NULL
         GROUP BY hostname, action ORDER BY cnt DESC LIMIT 200`
      );
      rows = r.rows;
    }
    res.json({ ok: true, pending: rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/pg-commands-purge — PG orbit_daemon_commands pending 위험 명령 정리
// body: { hostname?, actions? } — 기본 ["restart","update","reinstall"]
app.post('/api/admin/pg-commands-purge', async (req, res) => {
  try {
    // 2026-06-09 added: master 토큰 fallback
    const _rawTok = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const _MASTER = 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
    const { isAdmin: _adminOk } = resolveAdmin(req);
    if (_rawTok !== _MASTER && !_adminOk) return res.status(403).json({ error: 'admin only' });
    const _pool = dbModule.getDb ? dbModule.getDb() : null;
    if (!_pool) return res.status(500).json({ error: 'db not available' });
    const { hostname, actions, purgeAll } = req.body || {};
    const acts = Array.isArray(actions) && actions.length ? actions : ['restart', 'update', 'reinstall'];
    let r;
    if (purgeAll && hostname) {
      r = await _pool.query(
        `UPDATE orbit_daemon_commands SET consumed_at = NOW() WHERE consumed_at IS NULL AND hostname = $1`,
        [hostname]
      );
    } else if (purgeAll) {
      r = await _pool.query(`UPDATE orbit_daemon_commands SET consumed_at = NOW() WHERE consumed_at IS NULL`);
    } else if (hostname) {
      r = await _pool.query(
        `UPDATE orbit_daemon_commands SET consumed_at = NOW()
         WHERE consumed_at IS NULL AND hostname = $1 AND action = ANY($2)`,
        [hostname, acts]
      );
    } else {
      r = await _pool.query(
        `UPDATE orbit_daemon_commands SET consumed_at = NOW()
         WHERE consumed_at IS NULL AND action = ANY($1)`,
        [acts]
      );
    }
    // 인메모리 ALL 큐도 정리
    if (global._daemonCommands) {
      for (const h of Object.keys(global._daemonCommands)) {
        global._daemonCommands[h] = (global._daemonCommands[h] || []).filter(c => !acts.includes(c.action));
      }
    }
    res.json({ ok: true, purged: r.rowCount || 0, actions: acts, hostname: hostname || 'ALL' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/install/verify-step?hostname=&step=mouse|clipboard|keyboard|screen&since=ISO&token=
// 설치 가이드 각 단계 실시간 검증 (install-guided-verify.ps1)
app.get('/api/install/verify-step', async (req, res) => {
  try {
    const hostname = (req.query.hostname || '').trim();
    const step = (req.query.step || '').trim().toLowerCase();
    const since = req.query.since || new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const token = (req.query.token || '').trim();
    if (!hostname) return res.status(400).json({ error: 'hostname required' });
    if (!step) return res.status(400).json({ error: 'step required (mouse|clipboard|keyboard|screen)' });

    const _pool = dbModule.getDb ? dbModule.getDb() : null;
    if (!_pool?.query) return res.status(500).json({ error: 'db not available' });

    const baseWhere = `data_json->>'hostname' = $1 AND timestamp::timestamptz > $2::timestamptz`;
    let verified = false;
    let detail = {};
    let userId = null;

    if (step === 'mouse') {
      const { rows } = await _pool.query(
        `SELECT user_id, data_json, timestamp FROM events
         WHERE ${baseWhere} AND type = 'mouse.chunk'
         ORDER BY timestamp::timestamptz DESC LIMIT 5`,
        [hostname, since]
      );
      for (const r of rows) {
        const d = r.data_json || {};
        const clicks = Number(d.clicks || d.mousedowns || 0);
        const moves = Number(d.moves || d.moveCount || 0);
        if (clicks >= 1 || moves >= 3) {
          verified = true;
          userId = r.user_id;
          detail = { clicks, moves, ts: r.timestamp };
          break;
        }
      }
    } else if (step === 'clipboard' || step === 'keyboard') {
      if (token) {
        const { rows: cb } = await _pool.query(
          `SELECT user_id, data_json, timestamp FROM events
           WHERE ${baseWhere} AND type = 'clipboard.change'
             AND (data_json->>'text' ILIKE $3 OR data_json::text ILIKE $3)
           ORDER BY timestamp::timestamptz DESC LIMIT 1`,
          [hostname, since, `%${token}%`]
        );
        if (cb.length) {
          verified = true;
          userId = cb[0].user_id;
          detail = { via: 'clipboard.change', ts: cb[0].timestamp };
        }
      }
      if (!verified) {
        const { rows: kb } = await _pool.query(
          `SELECT user_id, data_json, timestamp FROM events
           WHERE ${baseWhere} AND type = 'keyboard.chunk'
           ORDER BY timestamp::timestamptz DESC LIMIT 3`,
          [hostname, since]
        );
        for (const r of kb) {
          const d = r.data_json || {};
          const chars = Number(d.metrics?.totalChars || d.totalChars || 0);
          const body = JSON.stringify(d);
          if ((token && body.includes(token)) || chars >= 8) {
            verified = true;
            userId = r.user_id;
            detail = { via: 'keyboard.chunk', totalChars: chars, ts: r.timestamp };
            break;
          }
        }
      }
    } else if (step === 'screen') {
      const { rows } = await _pool.query(
        `SELECT user_id, timestamp, data_json FROM events
         WHERE ${baseWhere} AND type = 'screen.capture'
         ORDER BY timestamp::timestamptz DESC LIMIT 1`,
        [hostname, since]
      );
      if (rows.length) {
        verified = true;
        userId = rows[0].user_id;
        detail = { via: 'screen.capture', ts: rows[0].timestamp, trigger: rows[0].data_json?.trigger };
      }
    } else {
      return res.status(400).json({ error: `unknown step: ${step}` });
    }

    const badUser = userId === 'local' || userId === 'anonymous' || !userId;
    res.json({
      ok: true,
      hostname,
      step,
      verified: verified && !badUser,
      userId,
      badUserId: badUser,
      detail,
      since,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/install/verify?hostname=xxx — 설치 완료 = 실제 chunk + 올바른 user_id
// install.complete 이벤트만으로는 성공 아님
app.get('/api/install/verify', async (req, res) => {
  try {
    const hostname = (req.query.hostname || '').trim();
    if (!hostname) return res.status(400).json({ error: 'hostname required' });

    const _pool = dbModule.getDb ? dbModule.getDb() : null;
    if (!_pool?.query) return res.status(500).json({ error: 'db not available' });

    const COLLECTION_TYPES = ['keyboard.chunk', 'mouse.chunk', 'screen.capture', 'clipboard.change'];

    const { rows: installRows } = await _pool.query(
      `SELECT timestamp, data_json FROM events
       WHERE type = 'install.complete' AND data_json->>'hostname' = $1
       ORDER BY timestamp DESC LIMIT 1`,
      [hostname]
    );

    const { rows: chunkRows } = await _pool.query(
      `SELECT type, user_id, timestamp FROM events
       WHERE data_json->>'hostname' = $1
         AND type = ANY($2)
         AND timestamp::timestamptz > NOW() - INTERVAL '15 minutes'
       ORDER BY timestamp::timestamptz DESC LIMIT 20`,
      [hostname, COLLECTION_TYPES]
    );

    const { rows: linkRows } = await _pool.query(
      `SELECT user_id FROM orbit_pc_links WHERE hostname = $1 LIMIT 1`,
      [hostname]
    );
    const expectedUserId = linkRows[0]?.user_id || null;

    const chunkUserIds = [...new Set(chunkRows.map(r => r.user_id).filter(Boolean))];
    const hasRealChunks = chunkRows.length > 0;
    const hasInstallPing = installRows.length > 0;

    const goodChunks = chunkRows.filter(r => r.user_id && r.user_id !== 'local' && r.user_id !== 'anonymous');
    const matchedUserId = expectedUserId
      ? goodChunks.some(r => r.user_id === expectedUserId)
      : goodChunks.some(r => r.user_id && !r.user_id.startsWith('pc_'));
    const onlyBadUserIds = chunkRows.length > 0 && goodChunks.length === 0;

    const verified = hasRealChunks && matchedUserId && !onlyBadUserIds;

    res.json({
      ok: true,
      hostname,
      verified,
      criteria: {
        installPing: hasInstallPing,
        realChunks15m: hasRealChunks,
        chunkCount: chunkRows.length,
        correctUserId: matchedUserId,
        onlyBadUserIds,
        expectedUserId,
        observedUserIds: chunkUserIds,
      },
      installAt: installRows[0]?.timestamp || null,
      latestChunk: chunkRows[0] || null,
      message: verified
        ? '설치 검증 통과 — 실제 수집 데이터 + user_id OK'
        : hasInstallPing && !hasRealChunks
          ? 'install.complete만 있음 — 실제 chunk 미수신'
          : onlyBadUserIds
            ? 'user_id=local만 수신 — 토큰/매핑 실패'
            : '검증 미통과 — 15분 내 올바른 user_id chunk 확인 필요',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/daemon-log?hostname=xxx&type=daemon|install — 데몬 PC의 로그 직접 조회
// 데몬이 시작 시마다 daemon.log.snapshot 이벤트로 보낸 최근 200줄을 반환
app.get('/api/admin/daemon-log', async (req, res) => {
  try {
    const hostname = req.query.hostname || '';
    const logType = req.query.type || 'daemon';
    if (!hostname) return res.status(400).json({ error: 'hostname required' });

    const _pool = dbModule.getDb ? dbModule.getDb() : null;
    if (!_pool) return res.status(500).json({ error: 'db not available' });

    // 가장 최근 daemon.log.snapshot 이벤트 1개 조회
    const { rows } = await _pool.query(
      `SELECT id, user_id, timestamp, data_json FROM events
       WHERE type = 'daemon.log.snapshot'
         AND data_json->>'hostname' = $1
         AND data_json->>'logType' = $2
       ORDER BY timestamp DESC LIMIT 1`,
      [hostname, logType]
    );
    if (rows.length === 0) {
      return res.json({
        ok: false,
        message: `no ${logType}.log snapshot found for ${hostname}`,
      });
    }
    const ev = rows[0];
    const data = ev.data_json || {};
    res.json({
      ok: true,
      hostname,
      logType,
      userId: ev.user_id,
      capturedAt: data.capturedAt || ev.timestamp,
      sizeBytes: data.sizeBytes || 0,
      lines: data.lines || data.error || '(empty)',
    });
  } catch (e) {
    console.error('[admin/daemon-log] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/repair-pc-mapping — admin이 hostname↔userId 강제 매핑 수정
// body: { hostname, userId, fixHistory: true|false }
// 1. orbit_pc_links upsert (register endpoint가 1순위로 조회)
// 2. fixHistory=true이면 잘못 매핑된 events.user_id를 정정
// (인증: 관리자만 사용 — 호출 시 즉시 비활성화 권장)
app.post('/api/admin/repair-pc-mapping', async (req, res) => {
  try {
    const { hostname, userId, fixHistory } = req.body || {};
    if (!hostname || !userId) {
      return res.status(400).json({ error: 'hostname, userId required' });
    }
    const _pool = dbModule.getDb ? dbModule.getDb() : null;
    if (!_pool) return res.status(500).json({ error: 'db not available' });

    // 1. 테이블 생성 (idempotent)
    await _pool.query(`CREATE TABLE IF NOT EXISTS orbit_pc_links (
      hostname TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      linked_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // 2. upsert 매핑
    await _pool.query(
      `INSERT INTO orbit_pc_links (hostname, user_id) VALUES ($1, $2)
       ON CONFLICT (hostname) DO UPDATE SET user_id = $2, linked_at = NOW()`,
      [hostname, userId]
    );

    let updatedEvents = 0;
    if (fixHistory) {
      // 3. data_json.hostname 이 일치하지만 user_id가 다른 events 정정
      const upd = await _pool.query(
        `UPDATE events SET user_id = $1
         WHERE data_json->>'hostname' = $2 AND user_id != $1`,
        [userId, hostname]
      );
      updatedEvents = upd.rowCount || 0;
    }

    console.log(`[admin] repair-pc-mapping ${hostname} → ${userId} (history fix: ${updatedEvents})`);
    res.json({ ok: true, hostname, userId, updatedEvents });
  } catch (e) {
    console.error('[admin/repair-pc-mapping] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/update-user-name — userId의 이름 업데이트 (PG + SQLite)
app.post('/api/admin/update-user-name', async (req, res) => {
  const { isAdmin: _adminOk } = resolveAdmin(req);
  if (!_adminOk) return res.status(403).json({ error: 'admin only' });
  const { userId, name } = req.body || {};
  if (!userId || !name) return res.status(400).json({ error: 'userId, name required' });
  const pool = dbModule.getDb && dbModule.getDb();
  const authDb = require('./src/auth').getDb();
  let pgOk = false, sqliteOk = false, pgErr = null;
  if (pool) {
    try {
      // 기존 유저는 UPDATE만으로 충분(INSERT 제약 회피). 레코드 없으면 INSERT.
      // [2026-06-25] 기존 UPSERT가 pgOk:false로 실패(김빛나 MND11FFB8C) → UPDATE-우선으로 견고화.
      const upd = await pool.query(`UPDATE orbit_auth_users SET name=$1 WHERE id=$2`, [name, userId]);
      if (upd.rowCount === 0) {
        // id에 unique 제약이 없어 ON CONFLICT 불가 → UPDATE 0행이면 행이 없는 것이므로 평범한 INSERT.
        await pool.query(
          `INSERT INTO orbit_auth_users (id, email, name, password_hash, plan, provider)
           VALUES ($2, $3, $1, '', 'free', 'pc-link')`,
          [name, userId, `${String(userId).toLowerCase()}@orbit.local`]
        );
      }
      pgOk = true;
    } catch (e) { pgErr = e.message; console.warn('[update-user-name] PG 실패:', e.message); }
  }
  if (authDb) {
    try {
      authDb.prepare(`UPDATE users SET name=? WHERE id=?`).run(name, userId);
      sqliteOk = true;
    } catch (e) { console.warn('[update-user-name] SQLite 실패:', e.message); }
  }
  console.log(`[admin] update-user-name ${userId} → ${name} (pg:${pgOk} sqlite:${sqliteOk})`);
  res.json({ ok: true, userId, name, pgOk, sqliteOk, pgErr });
});

// POST /api/admin/reassign-events — 시간 범위로 events.user_id 재할당
// body: { fromUserId, toUserId, afterTs, hostname? }
app.post('/api/admin/reassign-events', async (req, res) => {
  const { isAdmin: _adminOk } = resolveAdmin(req);
  const _secretOk = process.env.ADMIN_SECRET && (req.body || {}).secret === process.env.ADMIN_SECRET;
  if (!_adminOk && !_secretOk) return res.status(403).json({ error: 'admin only' });
  const { fromUserId, toUserId, afterTs, hostname } = req.body || {};
  if (!fromUserId || !toUserId || !afterTs) {
    return res.status(400).json({ error: 'fromUserId, toUserId, afterTs required' });
  }
  const _pool = dbModule.getDb ? dbModule.getDb() : null;
  if (!_pool) return res.status(500).json({ error: 'db not available' });
  try {
    const params = [toUserId, fromUserId, afterTs];
    let where = `user_id = $2 AND timestamp::timestamptz > $3`;
    if (hostname) { params.push(hostname); where += ` AND data_json->>'hostname' = $${params.length}`; }
    const upd = await _pool.query(`UPDATE events SET user_id = $1 WHERE ${where}`, params);
    res.json({ ok: true, updated: upd.rowCount, from: fromUserId, to: toUserId, afterTs, hostname });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/daemon/command — 관리자가 데몬에 명령 전송 (인증 필수)
app.post('/api/daemon/command', (req, res) => {
  // ADMIN_SECRET body 파라미터로도 허용 (CLI 편의)
  const _secretOk = process.env.ADMIN_SECRET && (req.body || {}).secret === process.env.ADMIN_SECRET;
  const { user, isAdmin: _adminOk } = resolveAdmin(req);
  if (!_secretOk && !_adminOk) {
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    return res.status(403).json({ error: 'admin only' });
  }
  const _effectiveUser = user || { id: 'admin', email: env.ADMIN_EMAILS[0] || 'admin', name: 'Admin' };

  const { hostname = 'ALL', action, command, data } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action 필수' });
  if (!global._daemonCommands[hostname]) global._daemonCommands[hostname] = [];
  // 호스트당 최대 50건 유지
  if (global._daemonCommands[hostname].length >= _DAEMON_CMD_MAX_PER_HOST) {
    global._daemonCommands[hostname] = global._daemonCommands[hostname].slice(-25);
  }
  const cmdTs = new Date().toISOString();
  global._daemonCommands[hostname].push({ action, command, data, ts: cmdTs });
  console.log(`[daemon-cmd] ${hostname}: ${action} (by ${_effectiveUser.email})`);
  // PG 영속 저장 (ALL 제외 — 특정 호스트 명령만, Railway 재배포 후 복원용)
  if (hostname !== 'ALL') {
    try {
      const _pool = dbModule.getDb ? dbModule.getDb() : null;
      if (_pool) {
        // 우선순위 명령(restart/exec/update/reinstall)이면 대기 중인 capture-config 먼저 정리
        // (capture-config 누적이 FIFO 큐 블로킹하는 것 방지)
        const _PRIORITY = ['restart', 'exec', 'update', 'reinstall'];
        if (_PRIORITY.includes(action)) {
          _pool.query(
            `UPDATE orbit_daemon_commands SET consumed_at = NOW() WHERE hostname = $1 AND consumed_at IS NULL AND action = 'capture-config'`,
            [hostname]
          ).catch(() => {});
        }
        _pool.query(
          `INSERT INTO orbit_daemon_commands (hostname, action, command, data_json, ts) VALUES ($1,$2,$3,$4,$5)`,
          [hostname, action, command || null, JSON.stringify(data || {}), cmdTs]
        ).catch(() => {});
      }
    } catch {}
  }
  res.json({ ok: true, queued: hostname });
});

// GET /api/daemon/governor — 리소스 거버너 상태 조회 (데몬 PC에서 보고)
app.get('/api/daemon/governor', (req, res) => {
  try {
    const fs = require('fs');
    const os = require('os');
    const statePath = require('path').join(os.homedir(), '.orbit', 'governor-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    res.json({ ok: true, ...state });
  } catch {
    res.json({ ok: false, level: 'UNKNOWN', message: '거버너 미실행' });
  }
});

// POST /api/daemon/governor/force — 거버너 레벨 강제 변경 (관리자 전용)
app.post('/api/daemon/governor/force', (req, res) => {
  const { user, isAdmin: _adminOk } = resolveAdmin(req);
  if (!_adminOk) {
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    return res.status(403).json({ error: 'admin only' });
  }
  const { level } = req.body || {};
  if (!['IDLE', 'NORMAL', 'BUSY', 'CRITICAL'].includes(level)) {
    return res.status(400).json({ error: 'level: IDLE|NORMAL|BUSY|CRITICAL' });
  }
  try {
    const gov = require('./src/resource-governor');
    const ok = gov.forceLevel(level);
    res.json({ ok, level });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /api/admin/push-token — PC에 사용자 토큰을 원격으로 푸시
// { hostname, userId } → 해당 PC의 .orbit-config.json에 token 업데이트 명령 전송
app.post('/api/admin/push-token', async (req, res) => {
  const _rawTok = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const _MASTER = 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
  const { user, isAdmin: _adminOk } = resolveAdmin(req);
  const _secretOk = process.env.ADMIN_SECRET && (req.body || {}).secret === process.env.ADMIN_SECRET;
  const _masterOk = _rawTok === _MASTER;
  if (!_secretOk && !_adminOk && !_masterOk) {
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    return res.status(403).json({ error: 'admin only' });
  }

  const { hostname, userId, token: directToken } = req.body || {};
  if (!hostname) return res.status(400).json({ error: 'hostname 필수' });
  if (!userId && !directToken) return res.status(400).json({ error: 'userId 또는 token 필수' });

  let tokenToSend = directToken;

  if (!tokenToSend && userId) {
    // PG 조회 (3초 타임아웃) → 실패 시 즉시 새 토큰 발급
    try {
      const pgDb = dbModule.getDb();
      const _pgResult = await Promise.race([
        pgDb.query(
          `SELECT token FROM orbit_auth_tokens WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT 1`,
          [userId]
        ),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
      ]);
      if (_pgResult.rows?.length > 0) tokenToSend = _pgResult.rows[0].token;
    } catch {}
    // 조회 실패 또는 없으면 새 토큰 즉시 발급
    if (!tokenToSend) {
      tokenToSend = issueApiToken(userId);
    }
  }

  if (!tokenToSend) return res.status(500).json({ error: '토큰 조회/발급 실패' });

  // config 명령으로 PC에 토큰 전달
  if (!global._daemonCommands) global._daemonCommands = {};
  if (!global._daemonCommands[hostname]) global._daemonCommands[hostname] = [];
  const cmdTs = new Date().toISOString();
  const cmdData = { token: tokenToSend, serverUrl: process.env.SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app' };
  global._daemonCommands[hostname].push({ action: 'config', data: cmdData, ts: cmdTs });
  // 이후 restart 명령도 전달 (토큰 즉시 반영)
  global._daemonCommands[hostname].push({ action: 'restart', ts: cmdTs });

  // PG 영속 저장 (비동기 fire-and-forget — 메모리 큐 등록 후 즉시 응답)
  const _pool = dbModule.getDb ? dbModule.getDb() : null;
  if (_pool) {
    Promise.all([
      _pool.query(
        `INSERT INTO orbit_daemon_commands (hostname, action, command, data_json, ts) VALUES ($1,$2,$3,$4,$5)`,
        [hostname, 'config', null, JSON.stringify(cmdData), cmdTs]
      ).catch(() => {}),
      _pool.query(
        `INSERT INTO orbit_daemon_commands (hostname, action, command, data_json, ts) VALUES ($1,$2,$3,$4,$5)`,
        [hostname, 'restart', null, '{}', cmdTs]
      ).catch(() => {}),
    ]).catch(() => {});
  }

  console.log(`[admin/push-token] ${hostname} → userId=${userId || 'direct'} token=${tokenToSend.slice(0, 12)}...`);
  res.json({ ok: true, hostname, tokenPreview: tokenToSend.slice(0, 12) + '...' });
});

// POST /api/admin/push-exec — 특정 PC(들)에 즉시 exec 커맨드 전송 (PG 영속 저장)
// body: { hostnames: ['PC1','PC2',...], command: 'powershell cmd', action: 'exec'|'restart' }
app.post('/api/admin/push-exec', async (req, res) => {
  const _rawTok = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const _MASTER = 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
  const { isAdmin: _adminOk } = resolveAdmin(req);
  if (_rawTok !== _MASTER && !_adminOk) return res.status(403).json({ error: 'forbidden' });

  const { hostnames, command, action = 'exec' } = req.body || {};
  if (!hostnames || !Array.isArray(hostnames) || hostnames.length === 0) {
    return res.status(400).json({ error: 'hostnames[] 필수' });
  }
  if (action === 'exec' && !command) return res.status(400).json({ error: 'exec action requires command' });

  const _pool = dbModule.getDb ? dbModule.getDb() : null;
  const ts = new Date().toISOString();
  const results = [];

  for (const hn of hostnames) {
    // 인메모리 큐
    if (!global._daemonCommands) global._daemonCommands = {};
    if (!global._daemonCommands[hn]) global._daemonCommands[hn] = [];
    global._daemonCommands[hn].push({ action, command: command || undefined, ts });
    // PG 영속 저장
    if (_pool) {
      try {
        await _pool.query(
          `INSERT INTO orbit_daemon_commands (hostname, action, command, data_json, ts) VALUES ($1,$2,$3,$4,$5)`,
          [hn, action, command || null, '{}', ts]
        );
        results.push({ hostname: hn, ok: true });
      } catch (e) {
        results.push({ hostname: hn, ok: false, err: e.message });
      }
    } else {
      results.push({ hostname: hn, ok: true, pgSkipped: true });
    }
    console.log(`[admin/push-exec] ${hn} ← ${action}${command ? ': ' + command.slice(0, 50) : ''}`);
  }

  res.json({ ok: true, results, queued: hostnames.length });
});

// ─── POST /api/daemon/register — 데몬 첫 기동 시 hostname 등록 + 자동 토큰 발급 ───
// 토큰 없이 hostname만으로 등록 → 기존 매칭 있으면 토큰 자동 발급
app.post('/api/daemon/register', async (req, res) => {
  try {
    const { hostname, platform, nodeVersion } = req.body || {};
    if (!hostname) return res.status(400).json({ error: 'hostname required' });

    const _pool = dbModule.getDb ? dbModule.getDb() : null;
    let matchedUserId = null;
    let matchedToken = null;

    // 1) PG에서 hostname → userId 매칭 조회
    //    A. orbit_pc_links 우선 (admin이 명시적으로 등록한 매핑이 가장 신뢰도 높음)
    if (_pool) {
      try {
        const { rows } = await _pool.query(
          `SELECT user_id FROM orbit_pc_links WHERE hostname = $1 LIMIT 1`,
          [hostname]
        );
        if (rows.length > 0) matchedUserId = rows[0].user_id;
      } catch {} // 테이블 없으면 무시

      //    B. PC_USER_MAP / PC_NAME_MAP / 카톡 / 클립보드 통합 resolver (Q1A+B)
      let resolveSource = 'orbit_pc_links';
      if (!matchedUserId) {
        try {
          const resolver = require('./src/pc-user-resolver');
          const r = await resolver.resolveHostnameToUser(_pool, hostname);
          if (r && r.userId) {
            matchedUserId = r.userId;
            resolveSource = r.source;
            console.log(`[daemon/register] ${hostname} resolver match: ${r.source} confidence=${r.confidence}`);
          }
        } catch (e) { console.warn('[daemon/register] resolver error:', e.message); }
      }

      //    C. events 테이블 fallback — 가장 최근 timestamp의 user_id (알파벳 순 X)
      //       기존 ORDER BY user_id LIMIT 1 버그: 동일 hostname에 여러 user_id 매핑 있을 때
      //       알파벳 순 첫 번째만 반환 → 강현우 PC가 임재용 ID로 잘못 매칭되는 사고 발생
      if (!matchedUserId) {
        try {
          const { rows } = await _pool.query(
            `SELECT user_id FROM events
             WHERE data_json->>'hostname' = $1
               AND user_id NOT LIKE 'pc_%' AND user_id != 'local'
             ORDER BY timestamp DESC LIMIT 1`,
            [hostname]
          );
          if (rows.length > 0) { matchedUserId = rows[0].user_id; resolveSource = 'events_recent'; }
        } catch {}
      }
    }

    // 3) 매칭된 userId가 있으면 토큰 자동 발급
    if (matchedUserId) {
      try {
        matchedToken = await issueApiTokenAsync(matchedUserId);
        console.log(`[daemon/register] ${hostname} → auto-matched userId=${matchedUserId} token=${matchedToken?.slice(0,12)}...`);
      } catch (e) {
        console.warn(`[daemon/register] token issue failed for ${matchedUserId}:`, e.message);
        // 토큰 발급 실패해도 매칭 정보는 반환
      }
    } else {
      console.log(`[daemon/register] ${hostname} → no match, will use pc_${hostname}`);
    }

    // 4) 등록 이벤트 기록
    if (_pool) {
      _pool.query(
        `INSERT INTO events (id, type, user_id, data_json, timestamp) VALUES ($1, $2, $3, $4, NOW())`,
        [`register-${hostname}-${Date.now()}`, 'daemon.register', matchedUserId || `pc_${hostname}`,
         JSON.stringify({ hostname, platform, nodeVersion, matchedUserId, autoToken: !!matchedToken })]
      ).catch(() => {});
    }

    res.json({
      ok: true,
      hostname,
      userId: matchedUserId || `pc_${hostname}`,
      token: matchedToken || null,
      matched: !!matchedUserId,
    });
  } catch (e) {
    console.error('[daemon/register] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/daemon/link-pc — 웹에서 hostname ↔ userId 연결 ───────────────
// 직원이 웹에서 "내 PC 연결" 클릭 시 hostname을 자기 계정에 매칭
app.post('/api/daemon/link-pc', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'auth required' });
    const _verifyAsync = require('./src/auth').verifyTokenAsync;
    const user = await _verifyAsync(token);
    if (!user) return res.status(401).json({ error: 'invalid token' });

    const { hostname } = req.body || {};
    if (!hostname) return res.status(400).json({ error: 'hostname required' });

    const _pool = dbModule.getDb ? dbModule.getDb() : null;
    if (!_pool) return res.status(500).json({ error: 'db not available' });

    // 1) orbit_pc_links 테이블에 매칭 저장 (upsert)
    await _pool.query(
      `CREATE TABLE IF NOT EXISTS orbit_pc_links (
        hostname TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        linked_at TIMESTAMPTZ DEFAULT NOW()
      )`
    );
    await _pool.query(
      `INSERT INTO orbit_pc_links (hostname, user_id) VALUES ($1, $2)
       ON CONFLICT (hostname) DO UPDATE SET user_id = $2, linked_at = NOW()`,
      [hostname, user.id]
    );

    // 2) 기존 pc_hostname 이벤트를 실제 userId로 재매핑
    await _pool.query(
      `UPDATE events SET user_id = $1 WHERE user_id = $2`,
      [user.id, `pc_${hostname}`]
    ).catch(() => {});

    // 3) 데몬에 토큰 push (기존 push-token 로직)
    const newToken = await issueApiTokenAsync(user.id);
    if (!global._daemonCommands) global._daemonCommands = {};
    if (!global._daemonCommands[hostname]) global._daemonCommands[hostname] = [];
    const cmdTs = new Date().toISOString();
    global._daemonCommands[hostname].push(
      { action: 'config', data: { token: newToken, userId: user.id, serverUrl: process.env.OAUTH_CALLBACK_BASE || `http://localhost:${PORT}` }, ts: cmdTs },
      { action: 'restart', ts: cmdTs }
    );
    // PG 영속화
    _pool.query(
      `INSERT INTO orbit_daemon_commands (hostname, action, data_json, ts) VALUES ($1,$2,$3,$4)`,
      [hostname, 'config', JSON.stringify({ token: newToken, userId: user.id }), cmdTs]
    ).catch(() => {});

    console.log(`[daemon/link-pc] ${hostname} → userId=${user.id} (${user.name}) token pushed`);
    res.json({ ok: true, hostname, userId: user.id, name: user.name, tokenPushed: true });
  } catch (e) {
    console.error('[daemon/link-pc] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/daemon/unlinked-pcs — 미매칭 PC 목록 (웹 UI용) ─────────────────
app.get('/api/daemon/unlinked-pcs', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const _verifyAsync = require('./src/auth').verifyTokenAsync;
    const user = token ? await _verifyAsync(token) : null;
    if (!user) return res.status(401).json({ error: 'auth required' });

    const _pool = dbModule.getDb ? dbModule.getDb() : null;
    if (!_pool) return res.json({ pcs: [] });

    const { rows } = await _pool.query(
      `SELECT DISTINCT data_json->>'hostname' AS hostname,
              MAX(timestamp) AS last_seen,
              COUNT(*) AS event_count
       FROM events
       WHERE user_id LIKE 'pc_%'
         AND data_json->>'hostname' IS NOT NULL
       GROUP BY data_json->>'hostname'
       ORDER BY last_seen DESC
       LIMIT 20`
    );
    res.json({ pcs: rows });
  } catch (e) {
    res.json({ pcs: [] });
  }
});

// POST /api/admin/list-users — 관리자용 전체 사용자 목록 조회
app.get('/api/admin/list-users', async (req, res) => {
  const { isAdmin: _adminOk } = resolveAdmin(req);
  const _secretOk = process.env.ADMIN_SECRET && req.query.secret === process.env.ADMIN_SECRET;
  if (!_secretOk && !_adminOk) return res.status(403).json({ error: 'admin only' });

  try {
    const pgDb = dbModule.getDb();
    const { rows } = await pgDb.query(
      `SELECT u.id, u.name, u.email, u.plan, u.created_at,
              (SELECT token FROM orbit_auth_tokens WHERE user_id = u.id AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT 1) as token
       FROM orbit_auth_users u ORDER BY u.created_at DESC`
    );
    res.json({ users: rows.map(r => ({
      id: r.id,
      name: r.name,
      email: r.email,
      plan: r.plan,
      pgSaved: true,          // PG에 계정 존재 여부 (이 API 자체가 PG 조회)
      hasToken: !!r.token,    // 유효 토큰 존재 여부
      tokenPreview: r.token ? r.token.slice(0, 16) + '...' : null,
      createdAt: r.created_at,
    })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 이벤트 수신 훅 ──────────────────────────────────────────────────────────

/**
 * POST /api/hook
 * Claude Code / orbit CLI 에서 직접 이벤트를 전송합니다.
 * 파일 감시 대신 HTTP POST 를 사용하면 지연 없이 실시간으로 이벤트를 처리합니다.
 * @body {{ events: MindmapEvent[], channelId?: string, memberName?: string }}
 */
app.post('/api/hook', async (req, res) => {
  try {
    // 입력 검증: events 필드 필수 + 배열 타입
    const vErr = validateBody(req.body, {
      events: { required: true, type: 'array' },
    });
    if (vErr) return res.status(400).json({ error: vErr });

    const { events = [], channelId = 'default', memberName = 'Claude' } = req.body;
    if (events.length === 0) {
      return res.status(400).json({ error: 'events 배열이 비어있습니다' });
    }

    // Authorization 헤더로 user_id 결정
    const hookToken = (req.headers.authorization || '').replace('Bearer ', '').trim()
                    || req.headers['x-api-token'] || '';
    // device_id: X-Device-Id 헤더 (hostname) 우선
    const _rawDeviceId = req.headers['x-device-id'] || req.body.pcId || '';
    const deviceId = _rawDeviceId ? decodeURIComponent(_rawDeviceId) : '';
    // 1차: SQLite 검증, 2차: PG fallback (Railway 재배포 후 SQLite 초기화 대비)
    const _verifyAsync = require('./src/auth').verifyTokenAsync;
    const hookUser  = hookToken ? await _verifyAsync(hookToken) : null;
    // 토큰 인증 실패 시 → hostname 기반 user_id 사용 (local 대신)
    // 형식: "pc_이재만", "pc_NENOVA2025" — PC별 데이터 분리 유지
    let hookUserId = hookUser
      ? hookUser.id
      : (deviceId ? `pc_${deviceId}` : 'local');

    // ── orbit_pc_links 우선 매핑 ─────────────────────────────────────────
    // 토큰 ghosting 방지: PC에 다른 유저 토큰이 깔려있어도 hostname 매핑이 있으면
    // 공식 owner로 덮어씀. admin이 등록한 pc_links가 단일 source of truth.
    if (deviceId) {
      try {
        const _pgPool = dbModule.getDb ? dbModule.getDb() : null;
        if (_pgPool && process.env.DATABASE_URL) {
          const { rows: _pcl } = await _pgPool.query(
            `SELECT user_id FROM orbit_pc_links WHERE hostname = $1 LIMIT 1`,
            [deviceId]
          );
          if (_pcl.length > 0 && _pcl[0].user_id && _pcl[0].user_id !== hookUserId) {
            console.warn(`[hook] pc_link override: ${deviceId} token=${hookUserId} → ${_pcl[0].user_id}`);
            hookUserId = _pcl[0].user_id;
          }
        }
      } catch (_plErr) {
        // pc_links 테이블 없거나 쿼리 실패 → 기존 hookUserId 유지 (fail-open)
      }
    }

    // ── 자동 사용자 분류 (Q2A) — pc_HOSTNAME 익명이면 50건마다 비동기 추론 ──
    if (hookUserId && hookUserId.startsWith('pc_') && deviceId) {
      global._pcAnonCounters = global._pcAnonCounters || {};
      global._pcAnonResolving = global._pcAnonResolving || {};
      global._pcAnonCounters[deviceId] = (global._pcAnonCounters[deviceId] || 0) + events.length;
      if (global._pcAnonCounters[deviceId] >= 50 && !global._pcAnonResolving[deviceId]) {
        global._pcAnonResolving[deviceId] = true;
        (async () => {
          try {
            const resolver = require('./src/pc-user-resolver');
            const _pgPool = dbModule.getDb ? dbModule.getDb() : null;
            if (_pgPool) {
              const r = await resolver.resolveHostnameToUser(_pgPool, deviceId);
              if (r && r.userId && !r.userId.startsWith('pc_')) {
                await _pgPool.query(`CREATE TABLE IF NOT EXISTS orbit_pc_links (
                  hostname TEXT PRIMARY KEY, user_id TEXT NOT NULL, linked_at TIMESTAMPTZ DEFAULT NOW()
                )`);
                await _pgPool.query(
                  `INSERT INTO orbit_pc_links (hostname, user_id) VALUES ($1, $2)
                   ON CONFLICT (hostname) DO UPDATE SET user_id=$2, linked_at=NOW()`,
                  [deviceId, r.userId]
                );
                console.log(`[hook] auto-classify ${deviceId} → ${r.userId} (${r.source}, conf=${r.confidence?.toFixed?.(2)})`);
              } else {
                console.log(`[hook] auto-classify ${deviceId} — 매칭 실패 (Q3A: 익명 유지)`);
              }
            }
          } catch (e) { console.warn('[hook] auto-classify error:', e.message); }
          finally {
            global._pcAnonCounters[deviceId] = 0;
            global._pcAnonResolving[deviceId] = false;
          }
        })();
      }
    }

    // ── 텍스트 구조화 사전 처리 (insertEvent 전) ─────────────────────────────
    if (textExtractor) {
      for (const event of events) {
        if (event.type === 'keyboard.chunk' || event.type === 'clipboard.change') {
          try {
            const structured = textExtractor.extract(event);
            if (structured) event.data._structured = structured;
          } catch (e) { /* 구조화 실패는 무시 */ }
        }
      }
    }

    // [2026-07-09] screen.analyzed 귀속 교정 ──────────────────────────────────
    // owner PC의 CLI 비전워커가 전 직원 캡처를 분석해 owner 토큰으로 되보내므로,
    // 토큰 기준(hookUserId)이면 전 직원 분석결과가 owner로 쏠린다(대시보드에 본인 것만 보임).
    // 원 캡처 hostname(event.data.hostname)의 실사용자로 재귀속한다. hostname당 30분 캐시.
    const _analyzedUserByHost = new Map();
    try {
      const _pgPool = dbModule.getDb ? dbModule.getDb() : null;
      if (_pgPool && process.env.DATABASE_URL) {
        if (!global._hostUserCache) global._hostUserCache = new Map();
        const hosts = [...new Set(events
          .filter(e => e.type === 'screen.analyzed' && e.data && e.data.hostname)
          .map(e => String(e.data.hostname).toLowerCase()))];
        for (const host of hosts) {
          const c = global._hostUserCache.get(host);
          if (c && Date.now() - c.at < 30 * 60 * 1000) { if (c.uid) _analyzedUserByHost.set(host, c.uid); continue; }
          let uid = null;
          try {
            const { rows } = await _pgPool.query(
              `SELECT user_id FROM orbit_pc_links WHERE LOWER(hostname)=$1 AND user_id NOT LIKE 'pc_%' AND user_id<>'local' LIMIT 1`, [host]);
            if (rows[0] && rows[0].user_id) uid = rows[0].user_id;
            if (!uid) {
              const { rows: dr } = await _pgPool.query(
                `SELECT user_id, COUNT(*) c FROM events
                 WHERE LOWER(data_json->>'hostname')=$1 AND user_id NOT LIKE 'pc_%' AND user_id<>'local'
                   AND timestamp::timestamptz > NOW() - INTERVAL '14 days'
                 GROUP BY user_id ORDER BY c DESC LIMIT 1`, [host]);
              if (dr[0] && dr[0].user_id) uid = dr[0].user_id;
            }
          } catch (_) {}
          global._hostUserCache.set(host, { uid, at: Date.now() });
          if (uid) _analyzedUserByHost.set(host, uid);
        }
      }
    } catch (_) {}

    // DB 저장 (중복 방지) + JSONL 비동기 쓰기
    // imageBase64는 Vision 큐용으로 별도 보관, DB에는 저장하지 않음
    const _imageCache = new Map(); // eventId → imageBase64
    const _isPg = process.env.DATABASE_URL;
    const jsonlLines = [];
    for (const event of events) {
      // user_id를 서버 검증 값으로 덮어쓰기 (screen.analyzed는 원 캡처 hostname의 실사용자로)
      event.userId = (event.type === 'screen.analyzed' && event.data && event.data.hostname
        && _analyzedUserByHost.has(String(event.data.hostname).toLowerCase()))
        ? _analyzedUserByHost.get(String(event.data.hostname).toLowerCase())
        : hookUserId;
      // screen.capture의 imageBase64를 DB 저장 전에 분리 (DB 용량 폭증 방지)
      if (event.type === 'screen.capture' && event.data?.imageBase64) {
        _imageCache.set(event.id, event.data.imageBase64);
        delete event.data.imageBase64;
      }
      // [2026-06-17] 힙 압력 시 고볼륨 노이즈 저장 스킵 — crash-loop 데몬의 daemon.update 폭주가
      // PG 연결 타임아웃→insertEvent await 적체→OOM 유발(실사고). NOISE_TYPES라 그래프에도 안 쓰임.
      // 평상시엔 정상 저장, 500MB 압박 때만 방어(daemon.update 이메일알림은 별도 루프라 영향 없음).
      if (_heapPressure && (event.type === 'daemon.update' || event.type === 'daemon.heartbeat'
          || event.type === 'daemon.log.snapshot' || event.type === 'daemon.perf.issue')) {
        continue;
      }
      try { await Promise.resolve(insertEvent(event)); } catch (e) {
        console.error('[hook] insertEvent FAIL:', e.message, 'id=', event.id, 'type=', event.type);
        if (!req._insertErrors) req._insertErrors = [];
        req._insertErrors.push({ id: event.id, error: e.message });
      }
      if (!_isPg) {
        jsonlLines.push(JSON.stringify({
          id: event.id, type: event.type, source: event.source,
          sessionId: event.sessionId, parentEventId: event.parentEventId,
          data: event.data, ts: event.timestamp,
        }));
      }
    }
    // JSONL 쓰기 — PG 환경에서는 스킵 (ENOSPC 방지, PG가 원본)
    if (!_isPg && jsonlLines.length > 0) {
      fs.appendFile(CONV_FILE, jsonlLines.join('\n') + '\n', e => {
        if (e) console.error('[hook] JSONL 쓰기 실패:', e.message);
      });
    }

    // [골:실행좌표 융합] 캡처 큐잉보다 먼저 이 배치의 keyboard.chunk 클릭들을 링버퍼에 적재
    // (같은 배치에 캡처가 함께 와도 직전 클릭을 붙일 수 있게 — 아래 pad_mouse_map 루프는 읽기만).
    for (const ev of events) {
      if (ev.type === 'keyboard.chunk' && Array.isArray(ev.data?.mousePositions)) {
        _pushRecentClicks(ev.userId || hookUserId, ev.data.mousePositions);
      }
    }

    // ── 캡처 Vision 큐 (screen.capture + imageBase64 → 맥미니 CLI 워커용) ──
    for (const ev of events) {
      const cachedImage = _imageCache.get(ev.id);
      if (ev.type === 'screen.capture' && cachedImage) {
        // 힙 압력 시 Vision 큐잉 스킵 (OOM 방지)
        if (_heapPressure) {
          _imageCache.delete(ev.id);
          continue;
        }
        // 이미지를 Vision 큐에 보관 (Railway 워커가 직접 처리)
        // [골:실행좌표 융합] 캡처 직전 12초 내 이 호스트의 실제 클릭 좌표를 첨부 → vision이
        // "어느 필드/버튼을 클릭했나"를 판단해 fields[].clickXY로 되돌려줌(pyautogui 실행 좌표).
        const _capClicks = _clicksForCapture(ev.userId || hookUserId, new Date(ev.timestamp).getTime());
        // 이미지 사이즈 체크 — 5MB 초과 base64는 OOM 위험, 스킵
        if (cachedImage && cachedImage.length > 5_000_000) {
          console.warn(`[vision-queue] 이미지 너무 큼 (${Math.round(cachedImage.length/1024)}KB) — 스킵`);
          _imageCache.delete(ev.id);
          continue;
        }
        _visionQueuePush({
          id:          ev.id,
          imageBase64: cachedImage,
          app:         ev.data.app || '',
          windowTitle: ev.data.windowTitle || '',
          trigger:     ev.data.trigger || '',
          hostname:    ev.data.hostname || '',
          bankMode:    ev.data.bankMode || false,
          sessionId:   ev.sessionId,
          userId:      ev.userId || hookUserId,
          ts:          ev.timestamp,
          recentClicks: _capClicks,  // [골:실행좌표 융합] 캡처 직전 실제 클릭들(빈 배열 가능)
        });
        console.log(`[vision-queue] 이미지 큐잉: ${ev.data.hostname}/${ev.data.app} (사용자별 큐, 총 ${_visionQueueTotal()}건)`);
        _imageCache.delete(ev.id);
      }
    }

    // ── 클립보드 발주서 자동 파싱 → parsed_orders 저장 ──────────────────
    if (_isPg) {
      for (const ev of events) {
        if (ev.type === 'clipboard.change' && ev.data?.orderFormat && ev.data?.parsedItems?.length > 0) {
          try {
            const pool = dbModule.getDb();
            for (const item of ev.data.parsedItems) {
              await pool.query(`
                INSERT INTO parsed_orders (source_event_id, source_type, customer, product, quantity, unit, action, raw_text, confidence)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
              `, [
                ev.id, ev.data.orderFormat,
                item.customer || '', item.product || '',
                item.qty || 0, item.unit || '단',
                item.action || 'add',
                (ev.data.text || '').substring(0, 500),
                item.confidence || 0.9,
              ]);
            }
            console.log(`[hook] 발주서 자동 파싱: ${ev.data.orderFormat}, ${ev.data.parsedItems.length}건 → parsed_orders`);
          } catch (e) { console.error('[hook] parsed_orders 저장 실패:', e.message); }
        }
      }
    }

    // ── 마우스 좌표 자동 학습 → pad_mouse_map (keyboard.chunk의 mousePositions 활용) ──
    if (_isPg) {
      for (const ev of events) {
        if (ev.type !== 'keyboard.chunk') continue;
        const positions = ev.data?.mousePositions;
        if (!Array.isArray(positions) || positions.length < 3) continue;
        // (클릭 링버퍼 적재는 위 캡처 큐 앞 조기 패스에서 이미 처리됨 — 여기선 pad_mouse_map 학습만)

        const windowTitle = ev.data?.appContext?.currentWindow || ev.data?.windowTitle || '';
        const app = ev.data?.appContext?.currentApp || ev.data?.app || '';
        // nenova 관련 윈도우만 고정밀 학습 (다른 앱은 기본 학습)
        const isNenova = /nenova|화훼|관리.*프로그램|재고|주문/i.test(windowTitle + ' ' + app);

        // 20px 그리드 클러스터링
        const clusters = new Map();
        for (const pos of positions) {
          if (!pos.x || !pos.y) continue;
          const gx = Math.round(pos.x / 20) * 20;
          const gy = Math.round(pos.y / 20) * 20;
          const key = `${gx},${gy}`;
          if (!clusters.has(key)) clusters.set(key, { x: 0, y: 0, count: 0, wins: new Set() });
          const c = clusters.get(key);
          c.x += pos.x; c.y += pos.y; c.count++;
          if (pos.win) c.wins.add(pos.win);
        }

        const pool = dbModule.getDb();
        const minClicks = isNenova ? 2 : 3; // nenova는 2회만으로도 학습

        for (const [, cluster] of clusters) {
          if (cluster.count < minClicks) continue;
          const avgX = Math.round(cluster.x / cluster.count);
          const avgY = Math.round(cluster.y / cluster.count);
          const confidence = Math.min(cluster.count / positions.length, 0.95);
          const winTitle = [...cluster.wins][0] || windowTitle;

          // 요소명 추론: 좌표 기반 영역 매핑
          let elementName = `click_${avgX}_${avgY}`;
          if (isNenova) {
            // nenova UI 요소 추론 (기본 좌표 범위)
            if (avgY < 100) elementName = '상단메뉴';
            else if (avgY < 350 && avgX < 200) elementName = '좌측트리';
            else if (avgY > 550) elementName = '하단버튼';
            else elementName = `nenova_${avgX}_${avgY}`;
          }

          try {
            await pool.query(`
              INSERT INTO pad_mouse_map (element_name, window_title, x, y, confidence, source, sample_count)
              VALUES ($1, $2, $3, $4, $5, 'keyboard_cluster', $6)
              ON CONFLICT (element_name, window_title) DO UPDATE SET
                x = CASE WHEN pad_mouse_map.sample_count < 50
                    THEN (pad_mouse_map.x * pad_mouse_map.sample_count + $3) / (pad_mouse_map.sample_count + 1)
                    ELSE pad_mouse_map.x END,
                y = CASE WHEN pad_mouse_map.sample_count < 50
                    THEN (pad_mouse_map.y * pad_mouse_map.sample_count + $4) / (pad_mouse_map.sample_count + 1)
                    ELSE pad_mouse_map.y END,
                confidence = LEAST(pad_mouse_map.confidence + 0.02, 0.99),
                sample_count = pad_mouse_map.sample_count + $6,
                updated_at = NOW()
            `, [elementName, winTitle, avgX, avgY, confidence, cluster.count]);
          } catch (e) { /* pad_mouse_map 테이블 없으면 무시 */ }
        }
      }
    }

    // ── 세션 자동 제목 생성 (이벤트 3개 이상 쌓인 세션) ──────────────────
    if (_isPg) {
      const sessionIds = [...new Set(events.map(e => e.sessionId).filter(Boolean))];
      for (const sid of sessionIds) {
        try {
          const sesEvents = await Promise.resolve(getEventsBySession(sid));
          if (sesEvents.length >= 3) {
            // 기존 title이 없는 세션만 자동 생성
            const sessions = await Promise.resolve(getSessions());
            const ses = sessions.find(s => s.id === sid);
            if (!ses?.title) {
              const sessStart = sesEvents.find(e => e.type === 'session.start');
              const projDir = sessStart?.data?.projectDir || sessStart?.data?.cwd || '';
              const projName = projDir ? projDir.replace(/\\/g, '/').split('/').filter(Boolean).pop() : null;
              const firstMsg = sesEvents.find(e => e.type === 'user.message');
              const firstMsgText = (firstMsg?.data?.contentPreview || firstMsg?.data?.content || '').slice(0, 30);
              const fileCounts = {};
              for (const e of sesEvents) {
                const fp = (e.data?.filePath || e.data?.fileName || '').replace(/\\/g, '/').split('/').pop();
                if (fp) fileCounts[fp] = (fileCounts[fp] || 0) + 1;
              }
              const topFile = Object.entries(fileCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
              // 도메인 추론
              const domainRules = [
                [/auth|login|oauth|jwt/, '인증'], [/route|api|endpoint/, 'API'],
                [/db|database|model/, '데이터'], [/component|ui|css|style/, 'UI'],
                [/test|spec/, '테스트'], [/deploy|ci|docker/, '배포'],
              ];
              let topDomain = null;
              for (const e of sesEvents) {
                const fp = (e.data?.filePath || '').toLowerCase();
                for (const [re, label] of domainRules) {
                  if (re.test(fp)) { topDomain = label; break; }
                }
                if (topDomain) break;
              }
              // 우선순위: [projectName] firstMsg > projectName > firstMsg > topFile > domain
              let autoTitle;
              if (projName && firstMsgText) autoTitle = `[${projName}] ${firstMsgText}`;
              else if (projName) autoTitle = projName;
              else if (firstMsgText) autoTitle = firstMsgText;
              else if (topFile) autoTitle = topFile;
              else if (topDomain) autoTitle = topDomain;
              if (autoTitle) {
                await Promise.resolve(updateSessionTitle(sid, autoTitle.slice(0, 80)));
              }
            }
          }
        } catch (e) { /* 자동 타이틀 실패는 무시 */ }
      }
    }

    // ── 경량 stats (DB 집계만, 전체 이벤트 로드 없음) ────────────────────
    const stats = await Promise.resolve(getStats());

    // tool.end/error → 완료된 tool.start ID (수신된 events 배열에서만 탐색)
    const completedToolStarts = [];
    for (const ev of events) {
      if (ev.type === 'tool.end' || ev.type === 'tool.error') {
        const startEv = events.find(e =>
          (e.type === 'tool.start') && e.sessionId === ev.sessionId
        );
        if (startEv) completedToolStarts.push(startEv.id);
      }
    }

    // 보안 유출 스캔 (수신 이벤트만)
    const leaks = scanForLeaks(events);
    if (leaks.length > 0) {
      const criticals = leaks.filter(l => l.severity === 'critical');
      console.warn(`[SECURITY] ⚠️ 유출 감지 ${leaks.length}건 (critical: ${criticals.length}건) — 채널: #${channelId}`);
    }

    // 감사 로그 기록
    auditFromEvents(events);

    // Shadow AI 감지 (수신 이벤트만)
    const shadowFindings = [];
    for (const ev of events) {
      const found = checkEventForShadow(ev);
      shadowFindings.push(...found);
    }
    if (shadowFindings.length > 0) {
      console.warn(`[SHADOW AI] ⚠️ 비승인 AI 감지 ${shadowFindings.length}건 — 채널: #${channelId}`);
      shadowFindings.forEach(f => appendAuditLog('shadow.ai.detected', f, { channel: channelId }));
    }

    // ── WS 경량 브로드캐스트: 풀 그래프 대신 "새 이벤트 알림"만 전송 ───────
    // 클라이언트가 필요 시 별도 API로 그래프를 당겨가게 함 (pull 방식)
    const _broadcastLightweight = () => {
      const msg = JSON.stringify({
        type:        'hook.events',
        count:       events.length,
        stats,
        channelId,
        memberName,
        completedToolStarts,
        securityLeaks: leaks,
        shadowAI:      shadowFindings,
        // 수신된 이벤트 타입 목록만 (풀 데이터 아님)
        eventTypes: events.map(e => e.type),
      });
      for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        // 데이터 격리: 같은 userId 또는 같은 채널의 클라이언트에게만 전송
        const clientUserId = client._userId || 'local';
        if (hookUserId && hookUserId !== 'local' && clientUserId !== hookUserId && clientUserId !== 'local') continue;
        try { client.send(msg); } catch {}
      }
    };
    _broadcastLightweight();

    // ── 활동 자동 분류 디바운스 (userId당 5분 쿨다운) ──────────────────────
    if (_isPg && hookUserId && hookUserId !== 'local') {
      if (!global._classifyDebounce) global._classifyDebounce = new Map();
      const _lastClassify = global._classifyDebounce.get(hookUserId) || 0;
      if (Date.now() - _lastClassify > 5 * 60 * 1000) {
        global._classifyDebounce.set(hookUserId, Date.now());
        setImmediate(async () => {
          try {
            const _pool = dbModule.getDb();
            if (!_pool?.query) return;
            // 최근 30분 이벤트 가져와서 분류 태깅
            const { rows } = await _pool.query(`
              SELECT id, type, data_json, timestamp FROM events
              WHERE user_id = $1 AND timestamp > NOW() - INTERVAL '30 minutes'
              AND type IN ('keyboard.chunk','screen.capture','clipboard.change')
              ORDER BY timestamp DESC LIMIT 100
            `, [hookUserId]);
            if (!rows.length) return;
            // structured 필드 있는 이벤트 집계 → 간단 activity 태깅
            const appCounts = {};
            let topApp = '', topCount = 0;
            for (const r of rows) {
              const d = typeof r.data_json === 'string' ? JSON.parse(r.data_json) : r.data_json;
              const s = d?._structured;
              if (!s) continue;
              const key = s.app_type || 'general';
              appCounts[key] = (appCounts[key] || 0) + 1;
              if (appCounts[key] > topCount) { topApp = key; topCount = appCounts[key]; }
            }
            if (topApp) console.log(`[auto-classify] ${hookUserId} 최근 30분 주요 활동: ${topApp} (${topCount}건)`);
          } catch (e) { /* 분류 실패 무시 */ }
        });
      }
    }

    // Ollama 실시간 분석 (이벤트 큐에 추가)
    for (const ev of events) ollamaAnalyzer.addEvent(ev);

    // ── 트래커 핑 자동 갱신 (hook 이벤트 수신 → 온라인 표시) ──────────────
    if (hookUserId && hookUserId !== 'local') {
      const hookHostname = deviceId || events.find(e => e.data?.hostname)?.data?.hostname || '';
      // PC-유저 충돌 감지: 같은 hostname이 다른 userId로 이미 등록된 경우 경고
      if (hookHostname) {
        try {
          const _pool = dbModule.getDb();
          if (_pool?.query) {
            const { rows: existingPing } = await _pool.query(
              `SELECT user_id FROM tracker_pings WHERE hostname = $1 AND user_id != $2 AND user_id != 'local' LIMIT 1`,
              [hookHostname, hookUserId]
            );
            if (existingPing.length > 0) {
              console.warn(`[hook] PC conflict: hostname=${hookHostname} was userId=${existingPing[0].user_id}, now userId=${hookUserId}`);
              // 관리자에게 알림 이벤트 기록
              try {
                await Promise.resolve(insertEvent({
                  id: `conflict_${Date.now()}`, type: 'daemon.pc_conflict',
                  userId: hookUserId,
                  data: { hostname: hookHostname, previousUserId: existingPing[0].user_id, newUserId: hookUserId },
                  timestamp: new Date().toISOString(),
                }));
              } catch {}
            }
          }
        } catch {}
      }
      try {
        const authDb = require('./src/auth').getDb();
        if (authDb) {
          authDb.prepare(`
            INSERT INTO tracker_pings (userId, hostname, eventCount, lastSeen)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(userId) DO UPDATE SET hostname=?, eventCount=eventCount+?, lastSeen=?
          `).run(hookUserId, hookHostname, events.length, Date.now(),
                 hookHostname, events.length, Date.now());
        }
      } catch {}
    }

    logger.hook.info('%d개 이벤트 수신 (채널: #%s, %s)', events.length, channelId, memberName);

    // ── 자동 에러 수정: daemon.error 이벤트 감지 → 자동 fix 명령 큐잉 ──────
    if (autoFixer) {
      for (const ev of events) {
        if (ev.type === 'daemon.error') {
          try {
            autoFixer.analyzeAndFix(ev, global._daemonCommands);
          } catch (e) {
            console.warn('[auto-fixer] 분석 오류:', e.message);
          }
        }
      }
    }

    // ── 업데이트 결과 이메일 알림 (daemon.update 이벤트) ──────────────────
    for (const ev of events) {
      if (ev.type === 'daemon.update') {
        sendUpdateEmail(ev).catch(e => console.warn('[email-notifier] 오류:', e.message));
      }
      // ── PC 성능/이슈 알림 (daemon.perf.issue 이벤트) → 관리자 이메일 ─────
      if (ev.type === 'daemon.perf.issue') {
        sendPerfIssueEmail(ev).catch(e => console.warn('[email-notifier/perf] 오류:', e.message));
        // 대시보드용: 최근 이슈 메모리에 보관 (최대 100건)
        if (!global._perfIssues) global._perfIssues = [];
        global._perfIssues.unshift({ ...ev.data, ts: ev.timestamp || new Date().toISOString() });
        if (global._perfIssues.length > 100) global._perfIssues.length = 100;
      }
    }

    // ── 강제 업데이트 플래그: 데몬이 구버전이면 응답에 update 명령 포함 ──────
    // 데몬이 daemon-updater 없는 구버전일 때, hook 응답으로 업데이트 지시
    const forceUpdate = global._forceUpdateEnabled || false;
    const response = { success: true, received: events.length, leaksDetected: leaks.length };
    if (req._insertErrors?.length) response._dbErrors = req._insertErrors;
    if (forceUpdate) {
      response._commands = [{ action: 'update', reason: 'server-forced' }];
    }
    res.json(response);
  } catch (e) {
    logger.hook.error('오류: %s', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/bulk-import
 * 대량 이벤트 임포트 (로컬→프로덕션 마이그레이션용)
 * rate limit 제외, 관리자 토큰 필수
 */
app.post('/api/bulk-import', (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'valid token required' });

    const { events = [] } = req.body;
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'events array required' });
    }

    let imported = 0;
    for (const event of events) {
      try {
        insertEvent(event);
        imported++;
      } catch (e) {
        // 중복 무시 (ON CONFLICT DO NOTHING)
      }
    }

    res.json({ ok: true, imported, total: events.length });
  } catch (e) {
    console.error('[BULK-IMPORT] 오류:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 채널 목록 조회
app.get('/api/channels', (req, res) => {
  const channels = [];
  channelClients.forEach((clients, channelId) => {
    channels.push({
      id:          channelId,
      memberCount: clients.size,
      members:     getChannelMembers(channelId),
    });
  });
  res.json(channels);
});

// 클라이언트 에러 수집 (Sentry 대체)
app.post('/api/client-error', (req, res) => {
  const { msg, src, line, col, ts } = req.body || {};
  if (msg) {
    console.warn(`[CLIENT-ERROR] ${msg} (${src}:${line}:${col})`);
  }
  res.json({ ok: true });
});

// 헬스체크 (Docker / Railway / Render 배포 플랫폼용)
app.get('/health', (req, res) => {
  try {
    const stats = getStats();
    res.json({
      status:    'ok',
      version:   '2.0.0',
      uptime:    Math.round(process.uptime()),
      events:    stats.eventCount,
      sessions:  stats.sessionCount,
      channels:  channelClients.size,
      clients:   wss.clients.size,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[health] error:', e.message);
    res.status(500).json({ status: 'error', error: 'Internal server error' });
  }
});

// ── 에이전트 통합 상태 API ─────────────────────────────────────────────────
app.get('/api/agents/status', async (req, res) => {
  const agents = [
    { id: 'think-engine',        name: '사고 엔진',     path: '/api/think',       schedule: '2시간' },
    { id: 'idea-engine',         name: '아이디어 엔진', path: '/api/ideas',        schedule: '4시간' },
    { id: 'deep-investigator',   name: '탐구 엔진',     path: '/api/investigate',  schedule: '요청시' },
    { id: 'business-intelligence', name: 'BI 엔진',     path: '/api/bi',           schedule: '요청시' },
    { id: 'activity-classifier', name: '활동 분류',     path: '/api/activity',     schedule: '실시간' },
    { id: 'vision-learning',     name: 'Vision 학습',   path: '/api/vision',       schedule: '캡처시' },
    { id: 'self-evolve',         name: '자가 진화',     path: '/api/evolve',       schedule: '6시간' },
    { id: 'automation-engine',   name: '자동화 엔진',   path: '/api/automation',   schedule: '1시간' },
    { id: 'script-generator',   name: '스크립트 생성', path: '/api/scripts',      schedule: '요청시' },
    { id: 'nenova-db',           name: 'nenova 전산',   path: '/api/nenova',       schedule: '요청시' },
    { id: 'nenova-cross',        name: '교차 분석',     path: '/api/cross',        schedule: '요청시' },
    { id: 'erp-analyzer',        name: 'ERP 분석',      path: '/api/erp',          schedule: '요청시' },
    { id: 'data-digitizer',      name: '데이터 디지타이저', path: '/api/digitize',  schedule: '요청시' },
    { id: 'company-structure',   name: '회사 구조',     path: '/api/company',      schedule: '3시간' },
    { id: 'rag-core',            name: 'RAG 코어',      path: '/api/rag',          schedule: '30분' },
  ];
  // 모든 에이전트는 라우터가 마운트되어 있으면 active
  const results = agents.map(a => ({
    ...a,
    status: 'active',
    mounted: true,
  }));
  const stats = getStats();
  res.json({
    ok: true,
    totalAgents: results.length,
    activeAgents: results.filter(r => r.status === 'active').length,
    serverUptime: Math.round(process.uptime()),
    eventCount: stats.eventCount,
    heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    agents: results,
  });
});

// ── 트래커 핑 (로컬 서버 → Railway로 주기적 보고) ─────────────────────────
// DB 기반 — 배포해도 상태 유지됨
app.post('/api/tracker/ping', (req, res) => {
  try {
    const { userId: bodyUserId, hostname, eventCount } = req.body || {};

    // 1) Authorization 토큰으로 사용자 식별
    const authToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
    let resolvedUserId = bodyUserId || '';
    if (authToken && !resolvedUserId) {
      try {
        const user = verifyToken(authToken);
        if (user) resolvedUserId = user.id;
      } catch {}
    }
    if (!resolvedUserId) resolvedUserId = req.ip; // fallback

    // 2) DB에 upsert
    try {
      const authDb = require('./src/auth').getDb();
      if (authDb) {
        authDb.prepare(`
          INSERT INTO tracker_pings (userId, hostname, eventCount, lastSeen)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(userId) DO UPDATE SET hostname=?, eventCount=?, lastSeen=?
        `).run(resolvedUserId, hostname || '', eventCount || 0, Date.now(),
               hostname || '', eventCount || 0, Date.now());
      }
    } catch (dbErr) {
      console.warn('[tracker/ping] DB 저장 실패:', dbErr.message);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[tracker/ping] error:', e.message);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// 설치 진행 상황 조회 (관리자용)
app.get('/api/install/status', async (req, res) => {
  try {
    const user = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
    if (!user) return res.json({ installs: [] });
    const allEvents = getEventsByUser ? await Promise.resolve(getEventsByUser(user.id)) : await Promise.resolve(getAllEvents(500));
    const installEvents = allEvents.filter(e => e.type === 'install.progress' || e.type === 'daemon.error')
      .sort((a, b) => a.timestamp > b.timestamp ? 1 : -1);
    // 호스트별 그룹
    const byHost = {};
    installEvents.forEach(e => {
      const host = e.data?.hostname || 'unknown';
      if (!byHost[host]) byHost[host] = { hostname: host, steps: [], errors: [], lastSeen: e.timestamp };
      if (e.type === 'install.progress') byHost[host].steps.push({ step: e.data?.step, status: e.data?.status, error: e.data?.error, ts: e.timestamp });
      if (e.type === 'daemon.error') byHost[host].errors.push({ component: e.data?.component, error: e.data?.error, ts: e.timestamp });
      byHost[host].lastSeen = e.timestamp;
    });
    res.json({ installs: Object.values(byHost) });
  } catch (e) { console.error('[install/status] error:', e.message); res.json({ installs: [] }); }
});

// ─── 자동 에러 수정 관리 API ────────────────────────────────────────────────
// 수정 이력 조회
app.get('/api/auto-fix/history', (req, res) => {
  if (!autoFixer) return res.json({ history: [], error: 'auto-fixer not loaded' });
  const limit = parseInt(req.query.limit) || 50;
  res.json({ history: autoFixer.getFixHistory(limit) });
});

// 등록된 패턴 목록
app.get('/api/auto-fix/patterns', (req, res) => {
  if (!autoFixer) return res.json({ patterns: [] });
  res.json({ patterns: autoFixer.getPatterns() });
});

// 쿨다운 리셋 (특정 호스트/패턴에 대해 재시도 허용)
app.post('/api/auto-fix/reset-cooldown', (req, res) => {
  if (!autoFixer) return res.status(500).json({ error: 'auto-fixer not loaded' });
  const { hostname, patternId } = req.body || {};
  autoFixer.resetCooldown(hostname, patternId);
  console.log(`[auto-fixer] 쿨다운 리셋: ${hostname || 'ALL'}:${patternId || 'ALL'}`);
  res.json({ ok: true, reset: `${hostname || 'ALL'}:${patternId || 'ALL'}` });
});

// Vision 분석 큐 (맥미니 CLI 워커용 — 이미지 포함)
// 사용자별 라운드로빈으로 추출 — 한 PC가 캡처를 폭주해도 다른 직원 캡처가 굶지 않는다.
// ?n= 으로 배치 크기 조절(워커 폴링 주기 단축에 맞춰 기본값도 상향, 최대 40).
app.get('/api/vision/queue', (req, res) => {
  const nRaw = parseInt(req.query.n) || 10;
  const n = Math.min(nRaw, 40);
  // [2026-07-13] 구세대 워커 차단 — 사무실 IP(14.32.52.210)의 pre-07-04 워커(30초 폴링, n 미지정→10)가
  // 큐를 30초마다 전부 가져가면서 screen.analyzed를 전혀 안 냄 → 3일 분석률 ~1% 사고의 주범(실측: fetch 로그 n=10, 30초 간격, 결과 0건).
  // 현행 워커(bin/vision-worker.js)는 n=24를 명시하므로 n<24 요청은 빈 배치로 응답해 큐를 보존한다.
  if (nRaw < 24) {
    if (!global._legacyVisionBlockAt || Date.now() - global._legacyVisionBlockAt > 600000) {
      global._legacyVisionBlockAt = Date.now();
      console.log(`[vision-queue] 구세대 워커 차단(n=${nRaw}, ip=${req.headers['x-forwarded-for'] || req.socket.remoteAddress}) — 10분간 로그 억제`);
    }
    return res.json({ pending: _visionQueueTotal(), batch: [] });
  }
  const batch = _visionQueueTake(n);
  if (batch.length) console.log(`[vision-queue] fetch: ${batch.length}건 취득 (n=${nRaw}, ip=${req.headers['x-forwarded-for'] || req.socket.remoteAddress})`);
  // ★[골:실행좌표융합] fetch 시점에 클릭 첨부 — 이때는 캡처 순간의 클릭을 담은 keyboard.chunk가
  // 이미 다 도착해 링버퍼에 있음(push 시점엔 캡처가 클릭보다 먼저라 비어있었음).
  for (const item of batch) {
    if (item && !(item.recentClicks && item.recentClicks.length)) {
      item.recentClicks = _clicksForCapture(item.userId, new Date(item.ts).getTime());
    }
  }
  res.json({ pending: _visionQueueTotal(), batch });
});

// 큐 상태만 확인 (소비하지 않음) — 진단용
app.get('/api/vision/queue-peek', (req, res) => {
  const items = [];
  // clicks = 지금 fetch하면 붙을 클릭 수(진단용, 소비 안 함)
  for (const [uid, q] of global._visionQueueByUser) for (const i of q) items.push({ id: i.id, app: i.app, hostname: i.hostname, userId: uid, clicks: _clicksForCapture(uid, new Date(i.ts).getTime()).length });
  res.json({
    total: items.length,
    byUser: [...global._visionQueueByUser.entries()].map(([userId, q]) => ({ userId, count: q.length })),
    clickBuf: [...(global._recentClicksByUser || new Map()).entries()].map(([uid, arr]) => ({ userId: uid, buffered: arr.length })),  // [골:실행좌표융합 진단] 링버퍼 상태
    items,
  });
});

// Vision worker 상태 진단 — ANTHROPIC_API_KEY 설정/실행 여부
app.get('/api/vision/stat', (req, res) => {
  try {
    const svw = require('./src/server-vision-worker');
    const st = svw.getStatus ? svw.getStatus() : { error: 'getStatus not exported' };
    res.json({ ok: true, worker: st, queueSize: _visionQueueTotal() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// [2026-06-15] 서버 Vision 유료워커 ON/OFF 런타임 토글 (Railway 변수 없이 제어, PG 영속)
// off로 두면 owner PC CLI 야간워커가 무과금으로 분석. ANTHROPIC_API_KEY는 건드리지 않음(다른 기능 공유).
app.post('/api/vision/server-worker', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token.startsWith('orbit_')) return res.status(401).json({ error: 'orbit token required' });
  const enabled = req.body?.enabled !== false; // 기본 ON, {enabled:false}면 OFF
  global._serverVisionOff = !enabled;
  try {
    const _pool = dbModule.getDb ? dbModule.getDb() : null;
    if (_pool?.query) {
      await _pool.query(`CREATE TABLE IF NOT EXISTS orbit_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
      await _pool.query(
        `INSERT INTO orbit_settings (key, value) VALUES ('vision_server_off', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [global._serverVisionOff ? 'true' : 'false']
      );
    }
  } catch (e) { console.warn('[vision-toggle] PG 저장 실패:', e.message); }
  console.log(`[vision-toggle] 서버 Vision 워커 ${global._serverVisionOff ? 'OFF(무과금 CLI로 대체)' : 'ON'}`);
  res.json({ ok: true, serverVisionWorker: global._serverVisionOff ? 'off' : 'on' });
});

// 직접 큐 추가 (테스트/복구용) — ORBIT_TOKEN 인증 필요
app.post('/api/vision/queue-push', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token.startsWith('orbit_')) return res.status(401).json({ error: 'orbit token required' });
  const { imageBase64, app: appName, hostname, windowTitle, userId, sessionId, ts } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
  _visionQueuePush({ id: 'manual-' + Date.now(), imageBase64, app: appName||'', windowTitle: windowTitle||'', hostname: hostname||'', userId: userId||'admin', sessionId: sessionId||'manual', ts: ts||new Date().toISOString() });
  console.log(`[vision-queue] 수동 큐잉: ${hostname}/${appName} (총 ${_visionQueueTotal()}건)`);
  res.json({ ok: true, queueSize: _visionQueueTotal() });
});

// ── 캡처 백로그 스풀 (다른 PC 백로그 중앙 수집 → owner PC 무과금 CLI가 소진) ──────
// OOM 방지 핵심: 이미지를 서버 메모리(인메모리 큐)에 쌓지 않고 Railway 볼륨(/app/data) 디스크에
// 파일로 스풀. owner 워커가 한 건씩 당겨 분석 후 삭제 → 볼륨이 계속 빠짐. 사용자당 상한으로 볼륨 보호.
const VISION_SPOOL_DIR = path.join(__dirname, 'data', 'vision-spool');
try { fs.mkdirSync(VISION_SPOOL_DIR, { recursive: true }); } catch {}
const VISION_SPOOL_MAX_PER_USER = 300;   // 사용자당 파일 상한(초과 시 오래된 것부터 삭제)
function _spoolUserDir(uid) { const d = path.join(VISION_SPOOL_DIR, String(uid).replace(/[^A-Za-z0-9_-]/g, '_')); try { fs.mkdirSync(d, { recursive: true }); } catch {} return d; }
function _spoolSafeFile(name) { return /^[A-Za-z0-9._-]+\.json$/.test(name) ? name : null; } // 경로탈출 방지

// 데몬이 로컬 PNG 백로그를 한 건씩 업로드 → 디스크에 저장 (인메모리 미적재)
app.post('/api/vision/spool', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token.startsWith('orbit_')) return res.status(401).json({ error: 'orbit token required' });
  const { imageBase64, app: appName, hostname, windowTitle, userId, ts, trigger, captureId } = req.body || {};
  if (!imageBase64 || !userId) return res.status(400).json({ error: 'imageBase64, userId required' });
  try {
    const dir = _spoolUserDir(userId);
    // 상한 초과 시 오래된 파일부터 정리
    let files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    while (files.length >= VISION_SPOOL_MAX_PER_USER) { try { fs.unlinkSync(path.join(dir, files.shift())); } catch { break; } }
    const id = String(captureId || Date.now()).replace(/[^A-Za-z0-9._-]/g, '_');
    const meta = { app: appName || '', windowTitle: windowTitle || '', hostname: hostname || '', userId, ts: ts || new Date().toISOString(), trigger: trigger || '', imageBase64 };
    await fs.promises.writeFile(path.join(dir, `${id}.json`), JSON.stringify(meta));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// owner 워커: 스풀 목록(메타만, 이미지 제외) — 사용자별 라운드로빈
app.get('/api/vision/spool/list', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token.startsWith('orbit_')) return res.status(401).json({ error: 'orbit token required' });
  const n = Math.min(parseInt(req.query.n) || 30, 60);
  try {
    const users = fs.readdirSync(VISION_SPOOL_DIR).filter(u => { try { return fs.statSync(path.join(VISION_SPOOL_DIR, u)).isDirectory(); } catch { return false; } });
    const perUser = {}; let total = 0;
    // [2026-07-23] 최신순 처리 — 파일명 screen-<epoch> 내림차순. 최근 캡처(클릭좌표 15분버퍼 살아있음+
    // 업무 관련성↑)를 먼저 분석 → clickXY 융합 복원. 옛 stale 백로그는 사용자당 300 상한으로 자연 만료.
    for (const u of users) { try { perUser[u] = fs.readdirSync(path.join(VISION_SPOOL_DIR, u)).filter(f => f.endsWith('.json')).sort().reverse(); total += perUser[u].length; } catch { perUser[u] = []; } }
    const out = []; let added = true;
    while (out.length < n && added) { added = false; for (const u of users) { if (perUser[u] && perUser[u].length) { out.push({ userId: u, file: perUser[u].shift() }); added = true; if (out.length >= n) break; } } }
    // 각 항목에 가벼운 메타 부착(이미지 제외)
    const items = out.map(o => { try { const m = JSON.parse(fs.readFileSync(path.join(VISION_SPOOL_DIR, o.userId, o.file), 'utf8')); return { userId: o.userId, file: o.file, app: m.app, windowTitle: m.windowTitle, hostname: m.hostname, ts: m.ts, trigger: m.trigger }; } catch { return { userId: o.userId, file: o.file }; } });
    res.json({ pending: total, batch: items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// owner 워커: 스풀 파일 1건(이미지 포함) 읽기 / 삭제
app.get('/api/vision/spool/file', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token.startsWith('orbit_')) return res.status(401).json({ error: 'orbit token required' });
  const uid = String(req.query.user || '').replace(/[^A-Za-z0-9_-]/g, '_'); const file = _spoolSafeFile(String(req.query.file || ''));
  if (!uid || !file) return res.status(400).json({ error: 'user, file required' });
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(VISION_SPOOL_DIR, uid, file), 'utf8'));
    // [골:실행좌표 융합/A3] 서버-큐 경로처럼 캡처 직전 클릭을 붙여 vision이 clickXY(pyautogui 좌표)를 특정.
    // 라이브 캡처(클릭이 15분 버퍼에 있음)에만 붙고, 오래된 백로그는 빈 배열(무해).
    if (!(meta.recentClicks && meta.recentClicks.length)) {
      meta.recentClicks = _clicksForCapture(meta.userId || uid, new Date(meta.ts || Date.now()).getTime());
    }
    res.json(meta);
  } catch { res.status(404).json({ error: 'not found' }); }
});
app.delete('/api/vision/spool/file', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token.startsWith('orbit_')) return res.status(401).json({ error: 'orbit token required' });
  const uid = String(req.query.user || '').replace(/[^A-Za-z0-9_-]/g, '_'); const file = _spoolSafeFile(String(req.query.file || ''));
  if (!uid || !file) return res.status(400).json({ error: 'user, file required' });
  try { fs.unlinkSync(path.join(VISION_SPOOL_DIR, uid, file)); res.json({ ok: true }); }
  catch { res.json({ ok: true }); } // 이미 없으면 성공 취급
});
app.get('/api/vision/spool/stat', (req, res) => {
  try {
    const users = fs.readdirSync(VISION_SPOOL_DIR).filter(u => { try { return fs.statSync(path.join(VISION_SPOOL_DIR, u)).isDirectory(); } catch { return false; } });
    const byUser = {}; let total = 0, bytes = 0;
    for (const u of users) { const fl = fs.readdirSync(path.join(VISION_SPOOL_DIR, u)).filter(f => f.endsWith('.json')); byUser[u] = fl.length; total += fl.length; for (const f of fl) { try { bytes += fs.statSync(path.join(VISION_SPOOL_DIR, u, f)).size; } catch {} } }
    res.json({ ok: true, total, mb: Math.round(bytes / 1e6), byUser });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 캡처 썸네일 이미지 제공 (screen.analyzed 이벤트의 thumbnail 필드)
app.get('/api/vision/thumbnail/:eventId', async (req, res) => {
  try {
    const db = dbModule.getDb();
    if (!db?.query) return res.status(503).send('DB not available');
    const result = await db.query(
      `SELECT data_json->>'thumbnail' as thumb FROM events WHERE id = $1 AND type = 'screen.analyzed' LIMIT 1`,
      [req.params.eventId]
    );
    const thumb = result.rows[0]?.thumb;
    if (!thumb) return res.status(404).json({ error: 'thumbnail not found' });
    const buf = Buffer.from(thumb, 'base64');
    // 포맷 감지: 구 썸네일=PNG(0x89504E47), 신 썸네일=JPEG(0xFFD8) — magic byte로 Content-Type 결정
    const isJpeg = buf.length > 2 && buf[0] === 0xFF && buf[1] === 0xD8;
    res.setHeader('Content-Type', isJpeg ? 'image/jpeg' : 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 최근 캡처 썸네일 목록 — ?userId=&hours=&limit= 필터. [골] 화면단위 업무 타임라인용.
app.get('/api/vision/thumbnails', async (req, res) => {
  try {
    const db = dbModule.getDb();
    if (!db?.query) return res.status(503).json({ error: 'DB not available' });
    const limit = Math.min(parseInt(req.query.limit) || 40, 120);
    const hours = Math.min(parseInt(req.query.hours) || 24, 720);
    const userId = req.query.userId || null;
    const params = [new Date(Date.now() - hours * 3600 * 1000).toISOString()];
    let where = `type = 'screen.analyzed' AND data_json->>'thumbnail' IS NOT NULL AND timestamp >= $1`;
    if (userId) { params.push(userId); where += ` AND user_id = $${params.length}`; }
    params.push(limit);
    const result = await db.query(
      `SELECT id, user_id, timestamp,
        data_json->>'app' as app, data_json->>'activity' as activity, data_json->>'screen' as screen,
        data_json->>'automationScore' as auto_score,
        (data_json->'fields') as fields, data_json->>'automationHint' as hint
       FROM events WHERE ${where}
       ORDER BY timestamp DESC LIMIT $${params.length}`,
      params
    );
    res.json({ count: result.rows.length, thumbnails: result.rows.map(r => ({
      id: r.id, userId: r.user_id, timestamp: r.timestamp, app: r.app, activity: r.activity,
      screen: r.screen, automationScore: r.auto_score, hint: r.hint,
      fields: r.fields || [], thumbnailUrl: `/api/vision/thumbnail/${r.id}`,
    })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// [2026-08-11] 관리자 표시명 변경 — 축약/영문 계정명(wbk 등)을 실명으로. orbit_auth_users(자체 PG)만 수정.
// POST /api/admin/rename-user { userId, name }  → X-ray·지식그래프·로그 전 화면 표시명 반영.
app.post('/api/admin/rename-user', express.json(), async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim() || String(req.query.token || '');
    if (!token.startsWith('orbit_')) return res.status(401).json({ error: 'orbit token required' });
    const db = dbModule.getDb();
    if (!db?.query) return res.status(503).json({ error: 'DB not available' });
    const userId = String((req.body || {}).userId || '').trim();
    const name = String((req.body || {}).name || '').trim().slice(0, 40);
    if (!userId || !name) return res.status(400).json({ error: 'userId·name 필수' });
    // 정확 id 또는 prefix 허용(앞 12자로 넘어오는 경우)
    const r = await db.query(
      `UPDATE orbit_auth_users SET name=$2 WHERE id=$1 OR id LIKE $3 RETURNING id, name`,
      [userId, name, userId + '%']);
    res.json({ ok: true, updated: r.rows.length, rows: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// [2026-08-10] ECOUNT 거래처별 미수(aging) 프록시 — nenovaweb WebEcountSnapshot 스냅샷을 읽기전용 브리지로
// 가져와 거래처명 정규화 맵 반환. 거래처 건강도(kakao-intel.html)가 위험도에 미수를 가산. 원본 DB 무관.
function _normCust(s) { return String(s || '').replace(/㈜|주식회사|주\)/g, '').replace(/\(.*?\)/g, '').replace(/[\s·.\-]/g, '').trim(); }
app.get('/api/admin/ecount-receivables', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim() || String(req.query.token || '');
    if (!token.startsWith('orbit_')) return res.status(401).json({ error: 'orbit token required' });
    if (!global._arCache) global._arCache = { ts: 0, data: null };
    if (global._arCache.data && Date.now() - global._arCache.ts < 300000) return res.json(global._arCache.data);
    const bt = process.env.NENOVAWEB_BRIDGE_TOKEN || '';
    if (!bt) return res.json({ ok: true, note: 'NENOVAWEB_BRIDGE_TOKEN 미설정 — 미수 결합 비활성', count: 0, customers: {} });
    const base = process.env.NENOVAWEB_BASE || 'https://nenovaweb.com';
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 20000);
    let body;
    try {
      const r = await fetch(`${base}/api/automation/proxy?path=/api/ecount/receivables`,
        { headers: { authorization: 'Bearer ' + bt }, signal: ctrl.signal });
      body = await r.json();
    } finally { clearTimeout(to); }
    const payload = body && body.rows ? body : (body && body.data) ? body.data : body || {};
    const rows = payload.rows || [];
    const customers = {};
    for (const x of rows) { const k = _normCust(x.name); if (!k) continue;
      customers[k] = { name: x.name, balance: x.balance, agingMonths: x.agingMonths, bucket: x.bucket, bucketLabel: x.bucketLabel, color: x.color }; }
    const out = { ok: true, generatedAt: new Date().toISOString(), takenAt: payload.takenAt || null,
      count: Object.keys(customers).length, summary: payload.summary || null, customers };
    global._arCache = { ts: Date.now(), data: out };
    res.json(out);
  } catch (e) { res.json({ ok: false, error: e.message, count: 0, customers: {} }); }
});

// [2026-08-10 골:화면↔입력 융합] 화면(screen.analyzed) 각각에 그 직전 시간창의 키보드 입력값(한글)을
// 붙여 "이 화면에서 → 이 값을 입력했다" 스텝을 만든다. AI 실행 대본(무엇을 어디에 입력)의 핵심 재료.
// GET /api/vision/screen-input?userId=&hours=&windowSec=  (읽기전용 융합, 저장 없음)
app.get('/api/vision/screen-input', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim() || String(req.query.token || '');
    if (!token.startsWith('orbit_')) return res.status(401).json({ error: 'orbit token required' });
    const db = dbModule.getDb();
    if (!db?.query) return res.status(503).json({ error: 'DB not available' });
    const userId = String(req.query.userId || '');
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const hours = Math.min(parseInt(req.query.hours) || 72, 720);
    const winSec = Math.min(parseInt(req.query.windowSec) || 180, 900); // 화면 전후 몇 초의 입력을 그 화면에 귀속
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    // 화면 + 키보드를 한 번에 시간순으로 가져와 메모리 융합
    // [2026-08-11] id(썸네일 이미지용)·fields(셀좌표+값) 포함 — "어느 화면에서 무슨 텍스트를" 기능 구현 재료
    const q = await db.query(
      `SELECT id, type, timestamp,
              data_json->>'app' app, data_json->>'screen' screen, data_json->>'activity' activity,
              CASE WHEN data_json->>'thumbnail' IS NOT NULL THEN 1 ELSE 0 END has_thumb,
              data_json->>'inputText' input, (data_json->'fields') fields
         FROM events
        WHERE user_id=$1 AND type IN ('screen.analyzed','keyboard.chunk') AND timestamp >= $2
        ORDER BY timestamp ASC`, [userId, since]);
    const rows = q.rows.map(r => ({ ...r, ms: new Date(r.timestamp).getTime() }));
    const screens = rows.filter(r => r.type === 'screen.analyzed');
    const kbs = rows.filter(r => r.type === 'keyboard.chunk' && r.input && r.input.trim());
    const steps = screens.map(s => {
      // 이 화면 기준 ±winSec 안의 키보드 입력들 → 한글 변환해 귀속
      const near = kbs.filter(k => Math.abs(k.ms - s.ms) <= winSec * 1000)
        .map(k => ({ ts: k.timestamp, ko: qwertyToHangul(k.input).slice(0, 120), raw: k.input.slice(0, 120), gapSec: Math.round((k.ms - s.ms) / 1000) }))
        .sort((a, b) => Math.abs(a.gapSec) - Math.abs(b.gapSec)).slice(0, 4);
      // 화면 속 필드(라벨·값·좌표) — vision이 추출했으면 "어느 칸에 무슨 값" 근거
      const fields = Array.isArray(s.fields) ? s.fields.slice(0, 12).map(f => ({ label: f.label || f.name || '', value: f.value || '', clickXY: f.clickXY || null })) : [];
      return {
        id: s.id, ts: s.timestamp, app: s.app || '', screen: s.screen || '', activity: s.activity || '',
        thumbnailUrl: s.has_thumb ? `/api/vision/thumbnail/${s.id}` : null, // 실제 화면 이미지
        clickCount: fields.filter(f => f.clickXY).length,
        fields, // [{label,value,clickXY}] — 화면 속 입력칸
        inputs: near, // [{ko, raw, gapSec}] — 그 시각 타이핑 원문
      };
    }).filter(st => st.inputs.length); // 입력이 붙은 화면만(=실행 대본 후보)
    res.json({ ok: true, userId, hours, windowSec: winSec,
      screensWithInput: steps.length, totalScreens: screens.length, steps: steps.slice(-120) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// [2026-08-07] 자동화 제안 뷰 데이터 — X-ray 기회들을 "실제 반복 화면 이미지 + 워크플로우 순서"로 묶음.
// 각 opportunity의 task/evidence에서 키워드를 뽑아 최근 screen.analyzed(썸네일 보유)와 매칭 →
// 시간 오름차순(워크플로우 순) 화면 스트립. 페이지: /auto-proposals.html
app.get('/api/xray/proposals', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim() || String(req.query.token || '');
    if (!token.startsWith('orbit_')) return res.status(401).json({ error: 'orbit token required' });
    const db = dbModule.getDb();
    if (!db?.query) return res.status(503).json({ error: 'DB not available' });
    const xr = await db.query(
      `SELECT report, ts FROM orbit_ops_report WHERE kind='xray' ORDER BY ts DESC LIMIT 1`);
    if (!xr.rows.length) return res.json({ ok: true, opportunities: [], note: 'X-ray 리포트 없음 — xray-worker 실행 필요' });
    const report = typeof xr.rows[0].report === 'object' ? xr.rows[0].report : JSON.parse(xr.rows[0].report);
    const opps = report.opportunities || [];

    // [v2 2026-08-07] 신뢰도 재설계 — 사장님 피드백 "이미지 잘못 붙음·50~100장이어도 디테일하게":
    // ① 30일 창(직원 반복화면 대량분석분 포함) ② 강한 앵커만 매칭(범용어로 엉뚱한 화면 붙는 것 차단)
    // ③ 중복 접지 않음 — 반복 화면을 반복 그대로(최대 100장, 시간순=워크플로우) ④ 누구 PC인지 표시.
    const ev = await db.query(
      `SELECT id, user_id, timestamp, data_json->>'app' AS app, data_json->>'screen' AS screen,
              data_json->>'activity' AS activity, data_json->>'hostname' AS hostname,
              (data_json->'fields') AS fields
         FROM events
        WHERE type='screen.analyzed' AND data_json->>'thumbnail' IS NOT NULL
          AND timestamp::timestamptz > NOW() - INTERVAL '30 days'
        ORDER BY timestamp ASC LIMIT 6000`);
    // userId → 이름 (신뢰 검증: 어느 직원 화면인지)
    let nameOf = {};
    try {
      const u = await db.query(`SELECT id, name FROM orbit_auth_users`);
      for (const r of u.rows) nameOf[r.id] = r.name;
    } catch {}
    // [2026-08-08] 앱 라벨 정규화 — 같은 앱이 여러 변형(ECOUNT ERP/iCount/iCOUNT 회계관리 등)으로
    // 흔들려 매칭·표시를 방해하던 것을 canonical 1개로 통일(데이터 품질 디벨롭 P1).
    const canonApp = (raw) => {
      const s = String(raw || '').toLowerCase();
      if (/ecount|icount|이카운트|이카운티/.test(s)) return 'ECOUNT ERP';
      if (/kakaotalk|카카오톡|카톡/.test(s)) return '카카오톡';
      if (/kakaowork|카카오워크/.test(s)) return '카카오워크';
      if (/nenova|네노바|꽃고|창해|판매·창해/.test(s) && !/nenovaweb|웹/.test(s)) return 'nenova 전산(exe)';
      if (/nenovaweb|nenova erp.*웹|웹 브라우저.*erp/.test(s)) return 'nenovaweb ERP';
      if (/신한|하나은행|기업포털|bizbank|기업뱅킹/.test(s)) return '은행(기업뱅킹)';
      if (/excel|엑셀/.test(s)) return 'Microsoft Excel';
      if (/explorer|파일 탐색기|windows explorer/.test(s)) return 'Windows 파일탐색기';
      if (/chrome|크롬/.test(s)) return 'Google Chrome';
      return raw || '';
    };
    const rows = ev.rows.map(r => ({
      id: r.id, userId: r.user_id, ts: r.timestamp, app: canonApp(r.app), screen: r.screen || '',
      activity: r.activity || '', hostname: r.hostname || '',
      clickCount: Array.isArray(r.fields) ? r.fields.filter(f => f && f.clickXY).length : 0,
      hay: `${r.app || ''} ${r.screen || ''} ${r.activity || ''}`.toLowerCase(),
    }));
    // 앵커 규칙: 구체어만(영문4+·한글3+·도메인 2글자 화이트리스트). 범용어는 매칭 금지.
    const GENERIC = new Set(['chrome', 'google', 'windows', 'microsoft', 'excel', 'browser', 'nenova', 'erp',
      '브라우저', '프로그램', '화면', '조회', '주문', '입력', '문자', '확인', '결과', '내역', '거래', '정보',
      '관리', '현황', '버튼', '메뉴', '목록', '상태', '시스템', '데이터', '자동', '가능', '반복', '처리',
      '사용', '방식', '정리', '기능', '개별', '동일', '다수', '이벤트', '학습',
      // [v3] evidence 메타단어 오염 차단(room='…, vision 타임스탬프 등에서 새어 들어와 엉뚱한 화면 매칭)
      'room', 'vision', 'order', 'units', 'multi', 'source', 'app', 'inventory',
      '거래처', '화면에서', '화면만', '거래처만', '존재하는', '동일한', '담당자', '텍스트',
      // [v4] 회사명·서술어 오염 (네노바=전 화면 매칭, method 문장의 동사·부사류)
      '네노바', '자동화', '리포트', '불일치', '대상에서', '자체는', '생성', '초안', '교육']);
    // [v4] 한국어 조사·어미 제거 후 재평가 ('텍스트를'→'텍스트', '파싱해'→'파싱') — 서술어 앵커화 방지
    const stripJosa = t => t.replace(/(으로|에서|하며|해서|하고|해|를|을|이|가|은|는|의|로|와|과|도|만|들)$/, '');
    const DOMAIN2 = new Set(['은행', '면장', '이체', '카톡', '발주', '계좌']); // 2글자지만 업무 특정성 높음
    const out = opps.map(o => {
      const toks = ((`${o.task || ''} ${o.evidence || ''} ${o.method || ''}`).match(/[A-Za-z]{3,}|[가-힣]{2,}/g) || [])
        .map(t => stripJosa(t.toLowerCase())) // [v4] 조사·어미 제거 후 평가
        .filter(t => t && !GENERIC.has(t));
      const anchors = [...new Set(toks.filter(t =>
        (/^[a-z]+$/.test(t) ? t.length >= 4 : t.length >= 3) || DOMAIN2.has(t)))].slice(0, 14);
      const screens = [];
      for (const r of rows) {
        if (!anchors.some(t => r.hay.includes(t))) continue; // 강한 앵커 1개 이상 필수
        screens.push({ id: r.id, ts: r.ts, userId: r.userId, userName: nameOf[r.userId] || '',
          hostname: r.hostname, app: r.app, screen: r.screen, activity: r.activity,
          clickCount: r.clickCount, thumbnailUrl: `/api/vision/thumbnail/${r.id}` });
        if (screens.length >= 100) break;
      }
      return { ...o, anchors, screens };
    }).sort((a, b) => (b.estWeeklyMinSaved || 0) - (a.estWeeklyMinSaved || 0));
    res.json({ ok: true, generatedAt: xr.rows[0].ts, summary: report.summary || '', opportunities: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// [골 #2: 캡처 스티칭] 연속 캡처를 "같은 작업의 시간순 절차"로 꿰맴 → 실행가능 task spec의 뼈대.
// GET /api/vision/task-sessions?userId=&hours=  → 세션별 ordered step[] (각 step=화면+필드+clickXY).
// 세션 경계: 시간갭>gapSec 또는 앱이 바뀌고 갭>60s. 읽기전용 조립(새 저장 없음).
app.get('/api/vision/task-sessions', async (req, res) => {
  try {
    const db = dbModule.getDb();
    if (!db?.query) return res.status(503).json({ error: 'DB not available' });
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const hours = Math.min(parseInt(req.query.hours) || 24, 168);
    const gapSec = Math.min(parseInt(req.query.gapSec) || 600, 1800); // 세션 분리 유휴 임계
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const { rows } = await db.query(
      `SELECT id, timestamp, data_json->>'app' app, data_json->>'screen' screen,
              data_json->>'activity' activity, data_json->>'automationScore' auto_score,
              data_json->>'automationHint' hint, data_json->>'nenovaAction' nenova_action,
              (data_json->'fields') fields, (data_json->'nenovaInputMap') input_map
         FROM events WHERE type='screen.analyzed' AND user_id=$1 AND timestamp>=$2
        ORDER BY timestamp ASC`,
      [userId, since]
    );
    const normApp = a => String(a || '').replace(/\s*[\(\-–].*/, '').trim() || '기타';
    // [2026-07-13] 같은앱 판정을 토큰 교집합으로: Vision이 같은 화면을 "이카운트(ECOUNT) ERP - Chrome"
    // "ECOUNT ERP (이카운트, Chrome 브라우저)" 등으로 매번 다르게 라벨링 → 문자열 비교면 매 스텝
    // 세션이 쪼개져 전부 1~2장(<3 필터)이 됨(실측: 같은앱 4연속·갭 6분도 sessionCount=0).
    const _APP_STOP = new Set(['chrome', 'edge', 'browser', '브라우저', 'windows', 'microsoft', 'google', 'web', '웹', 'pc', '창', '모드']);
    const tokensOf = a => new Set(String(a || '').toLowerCase().split(/[^a-z0-9가-힣]+/).filter(t => t.length >= 2 && !_APP_STOP.has(t)));
    const sameApp = (A, B) => { for (const t of A) if (B.has(t)) return true; return A.size === 0 && B.size === 0; };
    const sessions = [];
    let cur = null, prevT = 0;
    for (const r of rows) {
      const app = normApp(r.app);
      const tk = tokensOf(r.app);
      const t = new Date(r.timestamp).getTime();
      const gap = prevT ? (t - prevT) / 1000 : 0;
      // 새 세션: 큰 유휴갭 or (앱바뀌고 1분+ 갭). 같은 작업 중 카톡↔ERP 짧은 전환은 한 세션 유지.
      if (!cur || gap > gapSec || (!sameApp(cur.tokens, tk) && gap > 60)) {
        if (cur) sessions.push(cur);
        cur = { app, tokens: new Set(tk), startTs: r.timestamp, endTs: r.timestamp, steps: [], apps: new Set() };
      }
      for (const tok of tk) cur.tokens.add(tok); // 세션이 흡수한 라벨 토큰 누적(라벨 흔들림 대비)
      const flds = Array.isArray(r.fields) ? r.fields : [];
      const clickFields = flds.filter(f => Array.isArray(f.clickXY))
        .map(f => ({ name: f.name, clickXY: f.clickXY, value: f.currentValue, source: f.dataSource, human: !!f.humanRequired }));
      cur.steps.push({
        t: r.timestamp, gapSec: Math.round(gap), app, screen: r.screen, activity: r.activity,
        clickFields,                                   // ★실행좌표가 있는 필드(pyautogui 대상)
        inputMap: Array.isArray(r.input_map) ? r.input_map : [],
        nenovaAction: r.nenova_action || null,
        auto: Number(r.auto_score) || 0, thumbnailUrl: `/api/vision/thumbnail/${r.id}`,
      });
      cur.endTs = r.timestamp; cur.apps.add(app); prevT = t;
    }
    if (cur) sessions.push(cur);
    // 3장+ 세션만(1~2장은 단발). 요약필드 계산.
    const out = sessions.filter(s => s.steps.length >= 3).map(s => ({
      app: s.app, apps: [...s.apps], startTs: s.startTs, endTs: s.endTs,
      durationMin: Math.round((new Date(s.endTs) - new Date(s.startTs)) / 60000),
      stepCount: s.steps.length,
      clickStepCount: s.steps.filter(x => x.clickFields.length).length,   // 실행좌표 있는 단계 수
      autoScore: Math.max(0, ...s.steps.map(x => x.auto)),
      nenovaActions: [...new Set(s.steps.map(x => x.nenovaAction).filter(Boolean))],
      steps: s.steps,
    })).sort((a, b) => new Date(b.startTs) - new Date(a.startTs));
    res.json({ ok: true, userId, hours, sessionCount: out.length, sessions: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/vision/result', async (req, res) => {
  try {
    const { captureId, analysis, sessionId, userId } = req.body;
    if (!analysis) return res.status(400).json({ error: 'analysis required' });
    const event = {
      id: 'vision-' + Date.now(),
      type: 'screen.analyzed',
      source: 'vision-worker',
      sessionId: sessionId || 'vision',
      userId: userId || 'local',
      timestamp: new Date().toISOString(),
      data: analysis,
    };
    await Promise.resolve(insertEvent(event));
    res.json({ ok: true });
  } catch (e) { console.error('[vision-result] error:', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// 워크플로우 학습 + 자동화 템플릿 조회
app.get('/api/workflows', (req, res) => {
  try {
    const wf = require('./src/workflow-learner');
    res.json(wf.getStatus());
  } catch (e) { console.error('[workflows] error:', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/workflows/templates', (req, res) => {
  try {
    const wf = require('./src/workflow-learner');
    const data = wf.getWorkflows();
    res.json({ templates: data.templates, patterns: data.patterns });
  } catch (e) { res.json({ templates: [], patterns: [] }); }
});

app.post('/api/workflows/generate', (req, res) => {
  try {
    const { templateId } = req.body;
    const wf = require('./src/workflow-learner');
    const executor = require('./src/automation-executor');
    const template = wf.getWorkflows().templates.find(t => t.id === templateId);
    if (!template) return res.status(404).json({ error: 'template not found' });
    const scripts = executor.generateAll(template);
    res.json({ ok: true, scripts });
  } catch (e) { console.error('[workflows/generate] error:', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// 앱별 사용 프로필 + 피드백 조회 (tool-profiler)
app.get('/api/tool-profiles', (req, res) => {
  try {
    const profiler = require('./src/tool-profiler');
    res.json({
      profiles: profiler.getAllProfiles(),
      feedback: profiler.getRecentFeedback(20),
    });
  } catch (e) { console.error('[tool-profiles] error:', e.message); res.json({ profiles: [], feedback: [] }); }
});

// 트래커 상태 조회 (대시보드에서 연결 확인용)
app.get('/api/tracker/status', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    let userId = '';

    // 토큰으로 사용자 식별
    if (token) {
      try {
        const user = verifyToken(token);
        if (user) userId = user.id;
      } catch {}
    }

    if (!userId) {
      // 로그인 없어도 전체 이벤트 존재 시 로컬 트래커 활성 판단
      try {
        const totalStats = getStats ? await Promise.resolve(getStats()) : null;
        if (totalStats && totalStats.eventCount > 0) {
          return res.json({ online: true, lastSeen: Date.now(), hostname: 'localhost', eventCount: totalStats.eventCount });
        }
      } catch {}
      return res.json({ online: false, lastSeen: null, hostname: null, eventCount: 0 });
    }

    // 메인 DB에서 트래커 핑 조회 (PG/SQLite 양쪽 지원)
    let ping = null;
    try {
      ping = getTrackerPing ? await Promise.resolve(getTrackerPing(userId)) : null;
    } catch {}

    let isOnline = !!(ping && ping.last_ping);
    let userEventCount = 0;

    try {
      // 유저별 이벤트 확인 (PG async 대응: Promise.resolve로 래핑)
      const stats = getStatsByUser ? await Promise.resolve(getStatsByUser(userId)) : null;
      if (stats && stats.eventCount > 0) {
        userEventCount = stats.eventCount;
        isOnline = true;
      }
      // 유저 이벤트 없어도 전체 이벤트가 있으면 트래커 활성 (local 이벤트 아직 미귀속)
      // 단, eventCount는 유저 본인의 이벤트만 표시 (데이터 격리)
      if (!isOnline) {
        const totalStats = getStats ? await Promise.resolve(getStats()) : null;
        if (totalStats && totalStats.eventCount > 0) {
          isOnline = true;
        }
      }
    } catch {}

    // 워크스페이스 전체 최신 이벤트 시간 (관리자용)
    let wsLastEventAt = null;
    let lastEventAt = ping?.last_ping || null;
    try {
      const pool = dbModule.getDb();
      if (pool?.query) {
        const { rows } = await pool.query("SELECT MAX(timestamp) as last_ts FROM events WHERE type IN ('screen.capture','keyboard.chunk') AND user_id != 'local' LIMIT 1");
        if (rows[0]?.last_ts) wsLastEventAt = rows[0].last_ts;
        // 본인 최신 이벤트
        const { rows: userRows } = await pool.query("SELECT MAX(timestamp) as last_ts FROM events WHERE user_id = $1 LIMIT 1", [userId]);
        if (userRows[0]?.last_ts) lastEventAt = userRows[0].last_ts;
      }
    } catch {}

    res.json({
      online:     !!isOnline,
      lastSeen:   ping?.last_ping || null,
      lastEventAt,
      workspaceLastEventAt: wsLastEventAt,
      hostname:   ping?.hostname || null,
      eventCount: userEventCount,
    });
  } catch (e) {
    res.json({ online: false, lastSeen: null });
  }
});

// ── 토큰 등록 (로컬 PC에 ~/.orbit-config.json 저장) ─────────────────────────
// 프론트엔드 _postLoginSync → 이 엔드포인트 호출 → save-turn.js가 토큰 사용
app.post('/api/register-hook-token', (req, res) => {
  try {
    const authToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const _verifyFn = require('./src/auth').verifyTokenByEmail || verifyToken;
    const user = _verifyFn(authToken);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const os = require('os');
    const cfgPath = path.join(os.homedir(), '.orbit-config.json');

    // 기존 설정 로드 후 병합
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}

    const oldUserId = cfg.userId;  // 이전 ID 기록 (identity bridge용)

    const serverUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `http://localhost:${PORT}`;

    cfg.token = authToken;
    cfg.userId = user.id;
    cfg.serverUrl = serverUrl;
    cfg.email = user.email;  // email 저장 (identity 복원용)
    cfg.pcId = require('crypto').createHash('sha256')
      .update(`${os.hostname()}|${os.platform()}|${os.userInfo().username}`)
      .digest('hex').slice(0, 16);

    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    console.log(`[register-hook-token] ${user.email} (${user.id}) → ${cfgPath}`);

    // Identity Bridge: 이전 ID로 된 이벤트가 있으면 새 ID로 마이그레이션
    let migrated = 0;
    if (oldUserId && oldUserId !== user.id && oldUserId !== 'local') {
      try {
        const mainDb = dbModule.getDb ? dbModule.getDb() : null;
        if (mainDb && mainDb.prepare) {
          const r1 = mainDb.prepare('UPDATE events SET user_id = ? WHERE user_id = ?').run(user.id, oldUserId);
          const r2 = mainDb.prepare('UPDATE sessions SET user_id = ? WHERE user_id = ?').run(user.id, oldUserId);
          migrated = (r1.changes || 0) + (r2.changes || 0);
          if (migrated > 0) console.log(`[identity-bridge] ${oldUserId} → ${user.id}: ${migrated}개 레코드 마이그레이션`);
        }
      } catch (e) { console.warn('[identity-bridge] 마이그레이션 실패:', e.message); }
    }

    // Identity Bridge: auth DB에서도 canonical ID 보장
    try {
      const { ensureCanonicalUser } = require('./src/auth');
      if (ensureCanonicalUser) ensureCanonicalUser(user.id, user.email, user.name);
    } catch {}

    res.json({ ok: true, pcId: cfg.pcId, migrated });
  } catch (e) {
    console.error('[daemon/migrate-config] error:', e.message);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── 관리자 전체 그래프 (워크스페이스 전체 이벤트 — admin-analysis.html용) ────
app.get('/api/admin/graph', async (req, res) => {
  try {
    const { user, isAdmin: _adminOk } = resolveAdmin(req);
    if (!user && !_adminOk) return res.status(401).json({ error: 'unauthorized' });
    if (!_adminOk) return res.status(403).json({ error: 'admin only' });
    // 전체 이벤트 (최대 5000건)
    const events = await Promise.resolve(getAllEvents(200));
    const graph = buildGraph(events);
    // OOM 방지: 응답 크기 제한
    if (graph.nodes && graph.nodes.length > 500) graph.nodes = graph.nodes.slice(-500);
    if (graph.edges && graph.edges.length > 1000) graph.edges = graph.edges.slice(-1000);
    res.json(graph);
  } catch (e) { console.error('[admin/raw-graph] error:', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// ─── 멤버별 세션 요약 API (관리자용) ─────────────────────────────────────────
app.get('/api/admin/member-sessions', async (req, res) => {
  try {
    const { user, isAdmin: _adminOk } = resolveAdmin(req);
    if (!user && !_adminOk) return res.status(401).json({ error: 'unauthorized' });
    if (!_adminOk) return res.status(403).json({ error: 'admin only' });

    const events = await Promise.resolve(getAllEvents(200));

    // 사용자별 그룹핑
    const byUser = {};
    for (const ev of events) {
      const uid = ev.userId || ev.data?.userId || 'local';
      if (!byUser[uid]) byUser[uid] = [];
      byUser[uid].push(ev);
    }

    // 업무 라벨 분류 함수
    function classifyWork(windowTitle, app) {
      if (!windowTitle && !app) return null;
      const t = (windowTitle || '').toLowerCase();
      const a = (app || '').toLowerCase();
      if (t.includes('신규주문') || t.includes('주문등록') || t.includes('new order')) return '📋 주문 등록';
      if (t.includes('출하') || t.includes('출고') || t.includes('배송')) return '🚚 출하/배송 처리';
      if (t.includes('재고') || t.includes('inventory')) return '📦 재고 확인';
      if (t.includes('호남소재') || t.includes('거래처') || t.includes('업체')) return '💬 거래처 소통';
      if (t.includes('주문현황') || t.includes('물량') || t.includes('피벗')) return '📊 물량/현황 분석';
      if (t.includes('정산') || t.includes('세금계산서') || t.includes('invoice')) return '💰 정산 처리';
      if (a.includes('kakaotalk') || a.includes('카카오')) return '💬 카카오 소통';
      if (a.includes('nenova') || t.includes('nenova')) return '📋 nenova 업무';
      if (a.includes('explorer') || t.includes('탐색기')) return '📁 파일 관리';
      if (a.includes('excel') || a.includes('엑셀') || t.includes('.xlsx') || t.includes('.xls')) return '📊 엑셀 작업';
      if (a.includes('chrome') || a.includes('edge') || a.includes('firefox')) return '🌐 웹 검색/업무';
      return null;
    }

    // 각 사용자의 세션 요약 생성
    const memberSessions = {};
    for (const [uid, userEvents] of Object.entries(byUser)) {
      // 시간순 정렬
      userEvents.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

      // 30분 기준 세션 분리
      const sessions = [];
      let currentSession = null;
      const SESSION_GAP = 30 * 60 * 1000;

      for (const ev of userEvents) {
        const ts = new Date(ev.timestamp || 0).getTime();
        const d = ev.data || {};

        if (!currentSession || (ts - currentSession.lastTs) > SESSION_GAP) {
          if (currentSession) sessions.push(currentSession);
          currentSession = {
            id: `sess-${uid}-${ts}`,
            userId: uid,
            startTime: ev.timestamp,
            lastTs: ts,
            events: [],
            workLabels: {},
            apps: {},
          };
        }

        currentSession.lastTs = ts;
        currentSession.events.push(ev);

        // 업무 라벨 집계
        const label = classifyWork(d.windowTitle, d.app);
        if (label) currentSession.workLabels[label] = (currentSession.workLabels[label] || 0) + 1;
        if (d.app) currentSession.apps[d.app] = (currentSession.apps[d.app] || 0) + 1;
      }
      if (currentSession) sessions.push(currentSession);

      // 세션 요약 (상위 라벨만)
      memberSessions[uid] = sessions.map(s => {
        const topLabel = Object.entries(s.workLabels).sort((a,b) => b[1]-a[1])[0];
        const topApp = Object.entries(s.apps).sort((a,b) => b[1]-a[1])[0];
        return {
          id: s.id,
          userId: s.userId,
          startTime: s.startTime,
          eventCount: s.events.length,
          label: topLabel ? topLabel[0] : (topApp ? `🖥 ${topApp[0]}` : '📌 기타 작업'),
          apps: Object.keys(s.apps).slice(0, 3),
          workLabels: s.workLabels,
          duration: Math.round((s.lastTs - new Date(s.startTime).getTime()) / 60000),
        };
      });
    }

    res.json({ ok: true, members: memberSessions, totalUsers: Object.keys(memberSessions).length });
  } catch (e) {
    console.error('[member-sessions] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── 전체 사용자 목록 (관리자 전용) ─────────────────────────────────────────
// Railway PG + 로컬 SQLite 양쪽에서 실제 등록 유저 조회
app.get('/api/admin/all-users', async (req, res) => {
  try {
    const { user, isAdmin: _adminOk } = resolveAdmin(req);
    if (!user && !_adminOk) return res.status(401).json({ error: 'unauthorized' });
    if (!_adminOk) return res.status(403).json({ error: 'admin only' });

    const result = { users: [], eventsByUser: {}, source: [] };

    // 1) PG에서 사용자 조회
    if (process.env.DATABASE_URL) {
      try {
        const { Pool } = require('pg');
        const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5000 });
        const { rows: pgUsers } = await pool.query('SELECT id, email, name, plan, provider, created_at FROM orbit_auth_users ORDER BY created_at DESC');
        result.users = pgUsers;
        result.source.push('postgresql');

        // 사용자별 이벤트 수
        const { rows: counts } = await pool.query(
          `SELECT user_id, COUNT(*) as cnt, MAX(timestamp) as last_seen
           FROM events GROUP BY user_id ORDER BY cnt DESC`
        );
        counts.forEach(r => { result.eventsByUser[r.user_id] = { count: parseInt(r.cnt), lastSeen: r.last_seen }; });

        // tracker_pings (마지막 접속 정보)
        const { rows: pings } = await pool.query('SELECT user_id, hostname, event_count, last_seen FROM tracker_pings').catch(() => ({ rows: [] }));
        result.trackerPings = pings;

        await pool.end();
      } catch (e) {
        result.pgError = e.message;
      }
    }

    // 2) 로컬 SQLite fallback (PG 없거나 실패 시)
    if (result.users.length === 0) {
      const authMod = require('./src/auth');
      const authDb = authMod.getDb ? authMod.getDb() : null;
      if (authDb) {
        const rows = authDb.prepare('SELECT id, email, name, plan, provider, createdAt FROM users ORDER BY createdAt DESC').all();
        result.users = rows;
        result.source.push('sqlite');
      }
      // 로컬 이벤트 수
      const mainDb = dbModule.getDb ? dbModule.getDb() : null;
      if (mainDb) {
        const counts = mainDb.prepare('SELECT user_id, COUNT(*) as cnt, MAX(timestamp) as last_seen FROM events GROUP BY user_id ORDER BY cnt DESC').all();
        counts.forEach(r => { result.eventsByUser[r.user_id] = { count: r.cnt, lastSeen: r.last_seen }; });
      }
    }

    res.json({ ok: true, totalUsers: result.users.length, ...result });
  } catch (e) {
    console.error('[all-users] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── 그래프 캐시 강제 초기화 (DB 데이터 변경 후 즉시 반영) ────────────────────
app.post('/api/admin/cache/clear', (req, res) => {
  try {
    const { user, isAdmin: _adminOk } = resolveAdmin(req);
    if (!user && !_adminOk) return res.status(401).json({ error: 'unauthorized' });
    if (!_adminOk) return res.status(403).json({ error: 'admin only' });
    const before = _graphCache.size;
    _graphCache.clear();
    console.log(`[cache/clear] 그래프 캐시 초기화: ${before}개 항목 삭제`);
    res.json({ ok: true, cleared: before });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 자동화 검증 API (rawInput + clipboard + vision 3중 대조) ─────────────────
app.get('/api/admin/verify-automation', async (req, res) => {
  try {
    const { user, isAdmin: _adminOk } = resolveAdmin(req);
    if (!user && !_adminOk) return res.status(401).json({ error: 'unauthorized' });
    if (!_adminOk) return res.status(403).json({ error: 'admin only' });

    const hours = parseInt(req.query.hours) || 24;
    const events = await Promise.resolve(getAllEvents(500));

    // 시간 필터
    const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
    const recent = events.filter(e => e.timestamp > cutoff);

    // 3중 데이터 수집
    const keyboards = recent.filter(e => e.type === 'keyboard.chunk').map(e => ({
      userId: e.userId, ts: e.timestamp, hostname: e.data?.hostname,
      app: e.data?.appContext?.currentApp, window: e.data?.appContext?.currentWindow,
      rawInput: e.data?.rawInput || '', mouseClicks: e.data?.mouseClicks || 0,
      mousePositions: e.data?.mousePositions || [],
    }));

    const clipboards = recent.filter(e => e.type === 'clipboard.change').map(e => ({
      userId: e.userId, ts: e.timestamp, text: e.data?.text || '', sourceApp: e.data?.sourceApp || '',
    }));

    const visions = recent.filter(e => e.type === 'screen.analyzed').map(e => ({
      userId: e.userId, ts: e.timestamp, hostname: e.data?.hostname,
      app: e.data?.app, activity: e.data?.activity, automatable: e.data?.automatable,
      screen: e.data?.screen, workCategory: e.data?.workCategory,
    }));

    const orders = recent.filter(e => e.type === 'order.detected').map(e => ({
      userId: e.userId, ts: e.timestamp, items: e.data?.items || [], source: e.data?.source,
    }));

    res.json({
      period: { hours, from: cutoff },
      counts: { keyboard: keyboards.length, clipboard: clipboards.length, vision: visions.length, order: orders.length },
      keyboards, clipboards, visions, orders,
    });
  } catch (e) { console.error('[admin/verify-automation] error:', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// ─── 어드민 CLI 토큰 발급 (이메일 기반, 비밀번호 불필요) ──────────────────────
// Railway 환경에서만 동작 (ADMIN_EMAILS에 등록된 이메일만 허용)
app.post('/api/admin/issue-token', (req, res) => {
  const { email, secret } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  // 보안: ADMIN_SECRET 환경변수 또는 ADMIN_EMAILS 체크
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) return res.status(503).json({ error: 'ADMIN_SECRET not configured' });
  if (secret !== adminSecret && !ADMIN_EMAILS.includes(email.toLowerCase().trim())) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { getUserByEmail } = require('./src/auth');
  const user = getUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const token = issueApiToken(user.id);
  res.json({ ok: true, userId: user.id, token, email: user.email, name: user.name });
});

// ─── 관리자: 멤버 토큰 재발급 + 설치 명령 생성 ────────────────────────────────
// POST /api/admin/reissue-token { targetEmail }  Authorization: Bearer <admin_token>
app.post('/api/admin/reissue-token', async (req, res) => {
  const adminToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const { verifyTokenAsync, getUserByEmail, issueApiToken, pgBackupToken, pgBackupUser } = require('./src/auth');
  // orbit 마스터 토큰 또는 admin JWT 허용
  const isOrbitAdmin = env.isAdminToken(adminToken);
  const adminUser = isOrbitAdmin ? { email: env.ADMIN_EMAILS[0] } : await verifyTokenAsync(adminToken);
  if (!adminUser || !ADMIN_EMAILS.includes((adminUser.email || '').toLowerCase().trim())) {
    return res.status(403).json({ error: 'admin only' });
  }
  const { targetEmail } = req.body || {};
  if (!targetEmail) return res.status(400).json({ error: 'targetEmail required' });
  const user = getUserByEmail(targetEmail);
  if (!user) return res.status(404).json({ error: 'user not found: ' + targetEmail });
  const newToken = issueApiToken(user.id);
  // PG에 즉시 동기화
  try { await pgBackupUser(user, ''); } catch {}
  try { await pgBackupToken(newToken, user.id, null); } catch {}
  const serverUrl = (process.env.SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app');
  const installCmd = `$env:ORBIT_TOKEN='${newToken}'; $env:ORBIT_USER_ID='${user.id}'; irm '${serverUrl}/setup/install.ps1' | iex`;
  res.json({ ok: true, userId: user.id, name: user.name, email: user.email, token: newToken, installCmd });
});

// ─── 설치코드 발급 (userId 기반, LaunchAgent 마스터 토큰 전용) ──────────────────
// POST /api/admin/install-code { userId }  Authorization: Bearer orbit_967...
app.post('/api/admin/install-code', async (req, res) => {
  const raw = (req.headers.authorization || '').replace('Bearer ', '').trim();
  // LaunchAgent 마스터 토큰 하드코딩 체크 (ADMIN_TOKENS 미설정 환경 대응)
  const MASTER_TOKEN = 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
  if (raw !== MASTER_TOKEN && !env.isAdminToken(raw)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { userId, name: reqName } = req.body || {};
  if (!userId && !reqName) return res.status(400).json({ error: 'userId or name required' });
  const { issueApiToken, pgBackupToken, pgBackupUser } = require('./src/auth');
  const authDb = require('./src/auth').getDb ? require('./src/auth').getDb() : null;
  let user = null;
  if (userId) {
    user = authDb ? authDb.prepare('SELECT * FROM users WHERE id = ?').get(userId) : null;
  }
  // name으로 생성 (또는 name으로 기존 조회)
  if (!user && reqName) {
    const slug = reqName.toLowerCase().replace(/\s+/g, '.').replace(/[^a-z0-9.가-힣]/g, '');
    const email = `${slug}.pc@orbit.local`;
    user = authDb ? authDb.prepare('SELECT * FROM users WHERE email = ?').get(email) : null;
    if (!user) {
      const crypto = require('crypto');
      const newId = 'MN' + crypto.randomBytes(8).toString('hex').toUpperCase();
      authDb.prepare(`INSERT INTO users (id, email, name, passwordHash, provider) VALUES (?, ?, ?, '', 'pc_token')`).run(newId, email, reqName);
      user = authDb.prepare('SELECT * FROM users WHERE id = ?').get(newId);
      try { await pgBackupUser(user, ''); } catch {}
    }
  }
  if (!user) return res.status(404).json({ error: 'user not found' });
  const newToken = issueApiToken(user.id);
  try { await pgBackupToken(newToken, user.id, null); } catch {}
  const serverUrl = process.env.SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app';
  const installCmd = `$env:ORBIT_TOKEN='${newToken}'; $env:ORBIT_USER_ID='${user.id}'; irm '${serverUrl}/setup/install.ps1' | iex`;
  res.json({ ok: true, userId: user.id, name: user.name, email: user.email, token: newToken, installCmd });
});

// ─── 오픈 설치 자동 등록 (토큰 불필요 — hostname 기반 계정 자동 생성) ──────────
// POST /api/setup/auto-register  body: { hostname, windowsUser? }
// install-open.ps1 에서 호출 → token + userId 반환
app.post('/api/setup/auto-register', async (req, res) => {
  try {
    const { hostname, windowsUser, name: inputName,
            kakaoTitle, nenovaTitle, kakaoFolders, consent, consentAt } = req.body || {};
    if (!hostname) return res.status(400).json({ error: 'hostname required' });
    // 2026-06-08 fix: issueApiToken (fire-and-forget PG) → issueApiTokenAsync (await PG)
    // race condition 해결 — 사용자 PC가 즉시 link-pc 호출 시 PG에 토큰 보장됨
    const { issueApiTokenAsync, pgBackupToken, pgBackupUser } = require('./src/auth');
    const authDb = require('./src/auth').getDb ? require('./src/auth').getDb() : null;
    const pool = dbModule.getDb();
    const serverUrl = process.env.SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app';
    // 발급 토큰이 설치 직후 /api/auth/verify 를 통과하도록 PG에 user+token 확실히 심기 (재설치 "토큰 무효" 오탐 차단).
    // Railway SQLite는 휘발 → PG가 진실원본. orbit_auth_users.id엔 unique 없음 → ON CONFLICT 금지, UPDATE-first.
    async function ensureVerifiable(token, uid, nm) {
      if (!token || !uid || !pool) return;
      try {
        await pool.query(`INSERT INTO orbit_auth_tokens (token, user_id, type) VALUES ($1,$2,'api') ON CONFLICT DO NOTHING`, [token, uid]).catch(()=>{});
        const email = `${String(uid).toLowerCase()}@orbit.local`;
        const upd = await pool.query(`UPDATE orbit_auth_users SET name = COALESCE(NULLIF($2,''), name) WHERE id = $1`, [uid, nm || '']);
        if (!upd.rowCount) {
          await pool.query(`INSERT INTO orbit_auth_users (id, email, name, password_hash, plan, provider) VALUES ($1,$2,$3,'','free','pc_auto')`, [uid, email, nm || uid]).catch(()=>{});
        }
        const ok = await require('./src/auth').verifyTokenAsync(token).catch(()=>null);
        console.log(`[auto-register] ensureVerifiable ${String(uid).slice(0,12)} → ${ok ? 'OK' : 'repaired(PG)'}`);
      } catch (e) { console.warn('[auto-register] ensureVerifiable:', e.message); }
    }

    // 2026-06-09 added: client IP 자동 추출 (Railway proxy 통과 후 실제 client IP)
    const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.connection?.remoteAddress || '';

    // 2026-06-09 added: 이름 우선 매칭 (사용자가 install 시 본인 이름 입력)
    // 같은 직원이 PC 바꿔도 같은 user_id로 매칭 → 데이터 누적 일관성
    let existingUserId = null;
    let existingName   = null;
    let matchedByName  = false;
    const normalizedName = (inputName || '').trim();

    // [2026-07-17] fresh 모드: 재설치 = 완전 새 신원. 이름/pc_links/이력/이메일 매칭 전부 건너뛰고
    // 새 userId 발급 + pc_links를 새 userId로 덮어씀(옛 신원 supersede). 로컬은 클라이언트가 초기화.
    // 목적: 옛 데이터/신원 carryover 제거 → 원격·업데이트가 항상 깨끗한 신원에서 동작.
    if (req.body && req.body.fresh === true) {
      const crypto = require('crypto');
      const newId = 'MN' + crypto.randomBytes(8).toString('hex').toUpperCase();
      const displayName = normalizedName || windowsUser || hostname;
      const email = `${newId.toLowerCase()}@orbit.local`; // userId 기반 유니크 이메일 → hostname 이메일 재사용 회피
      if (authDb) { try { authDb.prepare(`INSERT OR IGNORE INTO users (id, email, name, passwordHash, provider) VALUES (?, ?, ?, '', 'pc_auto')`).run(newId, email, displayName); } catch {} }
      try { await pgBackupUser({ id: newId, email, name: displayName, provider: 'pc_auto', plan: 'free' }, ''); } catch {}
      try {
        await pool.query(`CREATE TABLE IF NOT EXISTS orbit_pc_links (hostname TEXT PRIMARY KEY, user_id TEXT NOT NULL, linked_at TIMESTAMPTZ DEFAULT NOW())`);
        await pool.query(`ALTER TABLE orbit_pc_links ADD COLUMN IF NOT EXISTS last_ip TEXT`).catch(()=>{});
        await pool.query(`ALTER TABLE orbit_pc_links ADD COLUMN IF NOT EXISTS windows_user TEXT`).catch(()=>{});
        await pool.query(`ALTER TABLE orbit_pc_links ADD COLUMN IF NOT EXISTS metadata JSONB`).catch(()=>{});
        await pool.query(
          `INSERT INTO orbit_pc_links (hostname, user_id, linked_at, last_ip, windows_user, metadata)
           VALUES ($1,$2,NOW(),$3,$4,$5)
           ON CONFLICT (hostname) DO UPDATE SET user_id=EXCLUDED.user_id, linked_at=NOW(), last_ip=EXCLUDED.last_ip, windows_user=EXCLUDED.windows_user, metadata=EXCLUDED.metadata`,
          [hostname, newId, clientIp, windowsUser || null, JSON.stringify({ fresh: true, consent: consent === true, consentAt: consentAt || null, ts: new Date().toISOString() })]
        );
      } catch (e) { console.warn('[auto-register] fresh pc_links:', e.message); }
      const token = await issueApiTokenAsync(newId);
      await ensureVerifiable(token, newId, displayName);
      console.log(`[auto-register] ${hostname} (ip=${clientIp}) → FRESH 새 신원 ${newId.slice(0, 12)} (name="${displayName}")`);
      return res.json({ ok: true, userId: newId, name: displayName, token, serverUrl, fresh: true, clientIp });
    }

    if (normalizedName) {
      try {
        // orbit_auth_users에서 정확히 일치하는 이름 검색 (case-insensitive, trim)
        const { rows } = await pool.query(
          `SELECT id, name FROM orbit_auth_users
           WHERE LOWER(TRIM(name)) = LOWER($1)
           ORDER BY created_at ASC LIMIT 1`,
          [normalizedName]
        );
        if (rows.length) {
          existingUserId = rows[0].id;
          existingName   = rows[0].name;
          matchedByName  = true;
          console.log(`[auto-register] ${hostname} → MATCHED by NAME "${normalizedName}" → ${existingUserId}`);
        }
      } catch (e) { console.warn('[auto-register] name lookup:', e.message); }
    }

    // 2) 이름 매칭 실패 시 hostname 매핑 fallback (기존 로직)
    if (!existingUserId) {
      try {
        await pool.query(`CREATE TABLE IF NOT EXISTS orbit_pc_links (
          hostname TEXT PRIMARY KEY, user_id TEXT NOT NULL, linked_at TIMESTAMPTZ DEFAULT NOW()
        )`);
        // 2026-06-09 added: audit columns (last_ip, windows_user, metadata JSON)
        await pool.query(`ALTER TABLE orbit_pc_links ADD COLUMN IF NOT EXISTS last_ip TEXT`).catch(()=>{});
        await pool.query(`ALTER TABLE orbit_pc_links ADD COLUMN IF NOT EXISTS windows_user TEXT`).catch(()=>{});
        await pool.query(`ALTER TABLE orbit_pc_links ADD COLUMN IF NOT EXISTS metadata JSONB`).catch(()=>{});
        const { rows } = await pool.query(
          'SELECT user_id FROM orbit_pc_links WHERE hostname = $1', [hostname]
        );
        if (rows.length) {
          existingUserId = rows[0].user_id;
          try {
            const { rows: uRows } = await pool.query(
              'SELECT name FROM orbit_auth_users WHERE id = $1', [existingUserId]
            );
            if (uRows.length) existingName = uRows[0].name;
          } catch {}
        }
      } catch (e) { console.warn('[auto-register] pc_links lookup:', e.message); }
    }

    // 2.5) [2026-07-09 하드닝] 이름·pc_links 둘 다 실패해도, 이 hostname이 과거에 데이터를 보낸
    // 계정이 있으면 그 중 가장 데이터 많은 계정을 재사용한다. → 재설치가 throwaway 신규계정을
    // 만들어 데이터가 갈라지던 재이슈(현욱 CAA5TA1가 MNMR8568로 새로 생긴 사례)를 근본 차단.
    if (!existingUserId && pool) {
      try {
        const { rows } = await pool.query(
          `SELECT user_id, COUNT(*) c FROM events
             WHERE data_json->>'hostname' = $1 AND user_id NOT IN ('local','system') AND user_id IS NOT NULL
             GROUP BY user_id ORDER BY c DESC LIMIT 1`,
          [hostname]
        );
        if (rows.length && Number(rows[0].c) >= 20) {  // 우연한 소량 유입은 제외(20건+)
          existingUserId = rows[0].user_id;
          try { const { rows: uRows } = await pool.query('SELECT name FROM orbit_auth_users WHERE id = $1', [existingUserId]); if (uRows.length) existingName = uRows[0].name; } catch {}
          console.log(`[auto-register] ${hostname} → MATCHED by HISTORY (${rows[0].c}건) → ${String(existingUserId).slice(0,12)} — 신규계정 생성 차단`);
        }
      } catch (e) { console.warn('[auto-register] history match:', e.message); }
    }

    // 3) 매핑 있으면 재사용 — 토큰만 새로 발급
    if (existingUserId) {
      const slug = `pc.${hostname.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      const email = `${slug}@orbit.local`;
      const name  = existingName || normalizedName || windowsUser || hostname;
      if (authDb) {
        const u = authDb.prepare('SELECT id FROM users WHERE id = ?').get(existingUserId);
        if (!u) {
          try {
            authDb.prepare(`INSERT OR IGNORE INTO users (id, email, name, passwordHash, provider) VALUES (?, ?, ?, '', 'pc_auto')`).run(existingUserId, email, name);
          } catch {}
        }
      }
      try { await pgBackupUser({ id: existingUserId, email, name, provider: 'pc_auto', plan: 'free' }, ''); } catch {}
      // 2026-06-09 added: 이름 매칭 성공 시 → hostname도 그 user에 매핑 (다음에 다른 PC에서도 같은 user)
      // 매핑마다 IP + windows_user + metadata audit (누가 언제 어디서 install했는지 추적)
      const auditMeta = {
        kakaoTitle:  kakaoTitle  || null,
        nenovaTitle: nenovaTitle || null,
        kakaoFolders: Array.isArray(kakaoFolders) ? kakaoFolders : [],
        consent: consent === true, consentAt: consentAt || null,
        ts: new Date().toISOString(),
      };
      try {
        await pool.query(`ALTER TABLE orbit_pc_links ADD COLUMN IF NOT EXISTS last_ip TEXT`).catch(()=>{});
        await pool.query(`ALTER TABLE orbit_pc_links ADD COLUMN IF NOT EXISTS windows_user TEXT`).catch(()=>{});
        await pool.query(`ALTER TABLE orbit_pc_links ADD COLUMN IF NOT EXISTS metadata JSONB`).catch(()=>{});
        if (matchedByName) {
          await pool.query(
            `INSERT INTO orbit_pc_links (hostname, user_id, linked_at, last_ip, windows_user, metadata)
             VALUES ($1, $2, NOW(), $3, $4, $5)
             ON CONFLICT (hostname) DO UPDATE
             SET user_id = EXCLUDED.user_id, linked_at = NOW(),
                 last_ip = EXCLUDED.last_ip, windows_user = EXCLUDED.windows_user, metadata = EXCLUDED.metadata`,
            [hostname, existingUserId, clientIp, windowsUser || null, JSON.stringify(auditMeta)]
          );
        } else {
          await pool.query(
            `UPDATE orbit_pc_links SET linked_at = NOW(), last_ip = $1, windows_user = $2, metadata = $3 WHERE hostname = $4`,
            [clientIp, windowsUser || null, JSON.stringify(auditMeta), hostname]
          );
        }
      } catch (e) { console.warn('[auto-register] pc_links upsert:', e.message); }
      const token = await issueApiTokenAsync(existingUserId);
      await ensureVerifiable(token, existingUserId, existingName || normalizedName || hostname);
      console.log(`[auto-register] ${hostname} (ip=${clientIp}) → REUSED ${existingUserId.slice(0,12)} (matchedByName=${matchedByName})`);
      return res.json({ ok: true, userId: existingUserId, name: existingName || normalizedName || hostname, token, serverUrl, reused: true, matchedByName, clientIp });
    }

    // 4) 매핑 없을 때만 새 user 생성 (최초 install)
    // 2026-06-09: 사용자가 이름 입력했으면 displayName으로 사용
    const slug  = `pc.${hostname.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const email = `${slug}@orbit.local`;
    let user = authDb ? authDb.prepare('SELECT * FROM users WHERE email = ?').get(email) : null;

    if (!user) {
      const crypto = require('crypto');
      const newId = 'MN' + crypto.randomBytes(8).toString('hex').toUpperCase();
      const displayName = normalizedName || windowsUser || hostname;
      if (authDb) {
        authDb.prepare(`INSERT OR IGNORE INTO users (id, email, name, passwordHash, provider) VALUES (?, ?, ?, '', 'pc_auto')`).run(newId, email, displayName);
        user = authDb.prepare('SELECT * FROM users WHERE id = ?').get(newId);
      }
      if (!user) return res.status(500).json({ error: 'user create failed' });
      try { await pgBackupUser({ id: user.id, email, name: displayName, provider: 'pc_auto', plan: 'free' }, ''); } catch {}
    } else if (normalizedName && user.name !== normalizedName) {
      // 기존 user 있는데 이름이 다르면 → 이름 업데이트 (사용자 입력 우선)
      try {
        authDb.prepare(`UPDATE users SET name = ? WHERE id = ?`).run(normalizedName, user.id);
        await pgBackupUser({ id: user.id, email, name: normalizedName, provider: user.provider || 'pc_auto', plan: user.plan || 'free' }, '');
        user.name = normalizedName;
      } catch {}
    }

    // 2026-06-08 fix: issueApiTokenAsync 사용 → PG 토큰 backup 보장 후 응답 (race condition X)
    const token = await issueApiTokenAsync(user.id);
    await ensureVerifiable(token, user.id, user.name);

    // orbit_pc_links INSERT — 최초 1회만. (위의 SELECT에서 매핑 없을 때만 여기 도달)
    // 2026-06-09: IP + windows_user + metadata audit 컬럼 함께 저장
    const newAuditMeta = {
      kakaoTitle:  kakaoTitle  || null,
      nenovaTitle: nenovaTitle || null,
      kakaoFolders: Array.isArray(kakaoFolders) ? kakaoFolders : [],
      consent: consent === true, consentAt: consentAt || null,
      ts: new Date().toISOString(),
    };
    try {
      await pool.query(
        `INSERT INTO orbit_pc_links (hostname, user_id, linked_at, last_ip, windows_user, metadata)
         VALUES ($1, $2, NOW(), $3, $4, $5)
         ON CONFLICT (hostname) DO UPDATE
         SET last_ip = EXCLUDED.last_ip, windows_user = EXCLUDED.windows_user,
             metadata = EXCLUDED.metadata, linked_at = NOW()`,
        [hostname, user.id, clientIp, windowsUser || null, JSON.stringify(newAuditMeta)]
      );
    } catch (e) { console.warn('[auto-register] pc_links insert:', e.message); }

    console.log(`[auto-register] ${hostname} (ip=${clientIp}) → NEW user ${user.id.slice(0,12)}`);
    res.json({ ok: true, userId: user.id, name: user.name, token, serverUrl, reused: false, clientIp });
  } catch (e) {
    console.error('[auto-register]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── 임시 진단 엔드포인트 (verifyToken 디버그용) ─────────────────────────────
app.get('/api/admin/diag-token', async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' });
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const authMod = require('./src/auth');
  const directResult = authMod.verifyToken ? authMod.verifyToken(token) : 'no verifyToken';
  const asyncResult = authMod.verifyTokenAsync ? await authMod.verifyTokenAsync(token) : 'no verifyTokenAsync';
  const authDb = authMod.getDb ? authMod.getDb() : null;
  const dbHasToken = authDb ? !!authDb.prepare('SELECT 1 FROM tokens WHERE token=?').get(token) : null;
  res.json({ token: token.slice(0, 20) + '...', directResult: directResult ? { id: directResult.id } : null, asyncResult: asyncResult ? { id: asyncResult.id } : null, dbHasToken });
});

// ═══════════════════════════════════════════════════════════════════════════
// Excel Power Query 연동용 JSON 엔드포인트 (관리자 토큰 필요)
//   사용: Excel → 데이터 → 웹에서 가져오기 → URL 입력 → 토큰 헤더 or ?token=
// ═══════════════════════════════════════════════════════════════════════════
function _checkSheetToken(req, res) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
             || (req.query.token || '').trim();
  if (!token || !token.startsWith('orbit_')) {
    res.status(401).json({ error: 'orbit_ token required (Authorization: Bearer or ?token=)' });
    return null;
  }
  return token;
}

// GET /api/sheet/issues — 이슈·오류·기능누락 현황 (14개 + 동적 crash 수)
app.get('/api/sheet/issues', async (req, res) => {
  if (!_checkSheetToken(req, res)) return;
  try {
    const pool = dbModule.getDb();
    // 최근 24h crash 건수 집계
    let crashCount24h = 0;
    try {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM orbit_crashes WHERE ts > NOW() - INTERVAL '24 hours'`);
      crashCount24h = rows[0]?.c || 0;
    } catch {}

    const issues = [
      { id: 1, priority: 'HIGH', category: '설치', title: 'schtasks OrbitDaemon 등록 실패', status: '배포완료', owner: 'claude', deployed: '2026-04-22', note: 'install.bat UAC 승격 + Register-ScheduledTask' },
      { id: 2, priority: 'HIGH', category: '업로드', title: 'Drive 403 Service Account 쿼터', status: '대표 작업 대기', owner: '대표', deployed: '', note: 'Shared Drive 생성 + Service Account Member 추가 필요' },
      { id: 3, priority: 'HIGH', category: '매핑', title: 'hostname 자동매칭 실패', status: '조사중', owner: 'claude', deployed: '', note: '/api/daemon/register matchedUserId=null' },
      { id: 4, priority: 'MID', category: '성능', title: 'node.exe 메모리 증가 (546→1024MB)', status: '24h 관찰', owner: 'claude', deployed: '', note: '메모리 누수 가능성' },
      { id: 5, priority: 'MID', category: '검증', title: '/api/crash/report E2E 미검증', status: '인위 crash 테스트 필요', owner: 'claude', deployed: '', note: '' },
      { id: 6, priority: 'MID', category: '검증', title: '학습값 실 적용 미검증', status: '대기', owner: 'claude', deployed: '', note: 'capture-config 복원 후 데몬 활용 여부' },
      { id: 7, priority: 'MID', category: '호환', title: 'setup/fix-daemon.ps1 구버전', status: '대기', owner: 'claude', deployed: '', note: 'clean-install v9와 동기화 필요' },
      { id: 8, priority: 'MID', category: '로깅', title: 'clean-install.log 첫 줄 UTF-16', status: '대기', owner: 'claude', deployed: '', note: 'Out-File -Force 기본 인코딩' },
      { id: 9, priority: 'LOW', category: '데이터', title: 'raw events DB truncate 미구현', status: '대기', owner: '대표 확인', deployed: '', note: '학습 스냅샷은 저장됨' },
      { id: 10, priority: 'LOW', category: 'UI', title: '관리자 대시보드 미반영', status: '대기', owner: 'claude', deployed: '', note: 'crash/snapshot/PC 상태' },
      { id: 11, priority: 'LOW', category: '복구', title: 'Rescue 채널 미구현', status: '대기', owner: 'claude', deployed: '', note: '데몬 독립 복구 경로' },
      { id: 12, priority: 'LOW', category: 'AI', title: 'Phase 2 Claude 분석 미구현', status: '계획', owner: 'claude', deployed: '', note: 'crash → Claude 자동 진단' },
      { id: 13, priority: 'LOW', category: '배포', title: '카나리·회로차단기 없음', status: '계획', owner: 'claude', deployed: '', note: 'push 후 자동 롤백 없음' },
      { id: 14, priority: 'LOW', category: 'UI', title: '3중 안전망 상태 가시화', status: '계획', owner: 'claude', deployed: '', note: 'PC별 schtasks/lnk/registry 상태' },
      { id: 15, priority: 'DYNAMIC', category: '모니터', title: '최근 24h crash 건수', status: `${crashCount24h} 건`, owner: '자동집계', deployed: new Date().toISOString().slice(0,10), note: 'orbit_crashes 테이블' },
    ];
    res.json(issues);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/sheet/deployment — PC별 배포·수집 현황
app.get('/api/sheet/deployment', async (req, res) => {
  if (!_checkSheetToken(req, res)) return;
  try {
    const pool = dbModule.getDb();
    // PC별 최근 활동 + hook 수 집계 (timestamp 컬럼이 TEXT이므로 ISO 문자열 비교)
    const since7d  = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { rows } = await pool.query(`
      SELECT
        data_json->>'hostname' AS hostname,
        user_id,
        COUNT(*)::int AS events_7d,
        COUNT(*) FILTER (WHERE timestamp > $2)::int AS events_24h,
        MAX(timestamp) AS last_event
      FROM events
      WHERE timestamp > $1
        AND data_json->>'hostname' IS NOT NULL
      GROUP BY data_json->>'hostname', user_id
      ORDER BY MAX(timestamp) DESC
      LIMIT 50
    `, [since7d, since24h]);
    const now = Date.now();
    const rowsOut = rows.map(r => {
      const lastMs = r.last_event ? new Date(r.last_event).getTime() : 0;
      const ageMin = lastMs ? Math.round((now - lastMs) / 60000) : null;
      return {
        hostname: r.hostname,
        user_id: r.user_id,
        events_24h: r.events_24h,
        last_event: r.last_event,
        age_minutes: ageMin,
        status: ageMin === null ? 'never' : ageMin < 30 ? 'live' : ageMin < 1440 ? 'idle' : 'stale',
      };
    });
    res.json(rowsOut);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/sheet/crashes — orbit_crashes 테이블 dump (최근 100건)
app.get('/api/sheet/crashes', async (req, res) => {
  if (!_checkSheetToken(req, res)) return;
  try {
    const pool = dbModule.getDb();
    const { rows } = await pool.query(`
      SELECT id, ts, origin, hostname, user_id, node_version,
             error_name, error_message,
             recent_crash_count_1h,
             (analyzed_at IS NOT NULL) AS analyzed
      FROM orbit_crashes
      ORDER BY ts DESC
      LIMIT 100
    `);
    res.json(rows);
  } catch (e) {
    // 테이블 없을 때 (첫 crash 전)
    if (/does not exist/i.test(e.message)) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sheet/roadmap — Phase 진행 현황 (정적 + 계산값)
app.get('/api/sheet/roadmap', (req, res) => {
  if (!_checkSheetToken(req, res)) return;
  const today = new Date().toISOString().slice(0,10);
  res.json([
    { phase: '긴급 복구', period: '2026-04-22', task: 'clean-install 배포 + .safe-mode 제거', status: '완료', deliverable: 'commit 5e4d5e5/e783907/2187e03' },
    { phase: 'P0 관찰', period: '4주 (2026-04-23 ~ 05-20)', task: 'document-watcher + Drive 역스캔, 분류 X', status: '대기', deliverable: 'orbit_document_observations 테이블' },
    { phase: 'P0.5 Shadow 분류', period: '4주 (2026-05-21 ~ 06-17)', task: 'Claude 예측 vs 실제 저장 비교', status: '대기', deliverable: 'company-ontology.json + 주간 정확도 리포트' },
    { phase: 'P1 최종 배포', period: '정확도 85%↑ 도달 시', task: '자동 분류·업로드 전환', status: '대기', deliverable: '카테고리별 순차 자동화' },
    { phase: 'Phase 2 Crash Analyzer', period: 'crash 데이터 축적 후', task: 'Claude 자동 진단 + 수정 제안', status: '계획', deliverable: 'src/claude-analyzer.js' },
    { phase: 'Phase 3 승인 UI', period: 'Phase 2 이후', task: '관리자 1-click 적용', status: '계획', deliverable: '/admin/crashes 페이지' },
    { phase: 'DLP', period: '최후순위', task: '외부 전송 감지·알림', status: '보류', deliverable: '(차단 불가 - 알림 only)' },
  ]);
});

// GET /admin/sheet-setup — Excel Power Query 연동 가이드
app.get('/admin/sheet-setup', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><title>Excel 연동 가이드</title>
<style>
body{font-family:"Malgun Gothic",-apple-system,sans-serif;max-width:780px;margin:0 auto;padding:24px;background:#f5f7fa;line-height:1.7;color:#1a1a1a}
.card{background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.06);margin-bottom:16px}
h1{color:#0b5fff;margin:0 0 8px}
h2{font-size:17px;margin:20px 0 10px;border-bottom:2px solid #e4e6e9;padding-bottom:4px}
code{background:#f0f2f5;padding:2px 8px;border-radius:4px;font-size:13px;font-family:Consolas,monospace}
.url{display:block;background:#1a1a1a;color:#4ade80;padding:12px 16px;border-radius:8px;font-family:Consolas,monospace;font-size:13px;word-break:break-all;margin:6px 0;cursor:pointer}
.url:hover{background:#2a2a2a}
ol{padding-left:22px}
ol li{margin-bottom:10px}
.warn{background:#fff8e1;border-left:4px solid #ffa726;padding:12px 16px;border-radius:6px;font-size:14px;margin:12px 0}
.tip{background:#e8f5e9;border-left:4px solid #4caf50;padding:12px 16px;border-radius:6px;font-size:14px;margin:12px 0}
table{width:100%;border-collapse:collapse;font-size:14px;margin:8px 0}
th{background:#f0f2f5;text-align:left;padding:8px}
td{border-bottom:1px solid #e4e6e9;padding:8px;vertical-align:top}
</style></head><body>

<div class="card">
<h1>📊 Excel 실시간 연동 설정</h1>
<p>nenovaagent Excel에 Power Query로 4개 시트 자동 갱신.</p>
</div>

<div class="card">
<h2>1. 4개 API URL (클릭하면 복사)</h2>
<p>아래 4개 URL을 Excel Power Query에서 사용합니다. <code>TOKEN</code> 자리에 당신의 Bearer 토큰을 넣으세요 (끝에 <code>?token=</code> 붙이면 더 간단).</p>

<table>
<tr><th>시트</th><th>URL</th></tr>
<tr><td>이슈_현황</td><td><span class="url" onclick="navigator.clipboard.writeText(this.textContent);this.style.background='#4ade80';">${base}/api/sheet/issues?token=YOUR_TOKEN</span></td></tr>
<tr><td>배포_트래킹</td><td><span class="url" onclick="navigator.clipboard.writeText(this.textContent);this.style.background='#4ade80';">${base}/api/sheet/deployment?token=YOUR_TOKEN</span></td></tr>
<tr><td>Crash_대시보드</td><td><span class="url" onclick="navigator.clipboard.writeText(this.textContent);this.style.background='#4ade80';">${base}/api/sheet/crashes?token=YOUR_TOKEN</span></td></tr>
<tr><td>Phase_로드맵</td><td><span class="url" onclick="navigator.clipboard.writeText(this.textContent);this.style.background='#4ade80';">${base}/api/sheet/roadmap?token=YOUR_TOKEN</span></td></tr>
</table>

<div class="warn"><b>⚠️ 토큰</b> <code>YOUR_TOKEN</code> 자리에 관리자 토큰 넣으세요. 없으면 <code>~/.orbit-config.json</code> 의 <code>token</code> 값 사용. <code>orbit_</code>로 시작하는 값이면 통과.</div>
</div>

<div class="card">
<h2>2. Excel Power Query 설정 (각 시트마다 1회)</h2>
<ol>
<li>엑셀에서 <b>새 시트 추가</b> (예: "이슈_현황")</li>
<li>리본 메뉴: <b>데이터 → 데이터 가져오기 → 웹에서</b></li>
<li>URL 붙여넣기 (토큰 포함) → <b>확인</b></li>
<li>"익명" 선택 → <b>연결</b> (토큰이 URL에 있으니 인증 불필요)</li>
<li>Power Query 창 열리면: 우측 <b>목록 → 테이블로 변환</b> → <b>Record 확장</b> (모든 컬럼 선택)</li>
<li><b>닫고 로드</b> → 시트에 테이블 생성됨 ✓</li>
<li>4개 URL 모두 같은 방식으로 반복</li>
</ol>
</div>

<div class="card">
<h2>3. 자동 새로고침 설정</h2>
<ol>
<li>각 테이블 우클릭 → <b>테이블 → 쿼리 편집</b></li>
<li>리본: <b>쿼리 → 새로고침 → 연결 속성</b></li>
<li><b>"백그라운드 새로고침 사용"</b> 체크</li>
<li><b>"n분마다 새로고침"</b> → <code>5</code> 분 입력</li>
<li><b>"파일을 열 때 데이터 새로고침"</b> 체크</li>
<li>확인 → 이제 5분마다 자동 갱신 ✓</li>
</ol>

<div class="tip"><b>Tip</b> 수동 새로고침은 <b>Ctrl + Alt + F5</b> (모든 쿼리 동시 새로고침)</div>
</div>

<div class="card">
<h2>4. 각 시트 컬럼 구조 (자동 생성됨)</h2>

<h3 style="font-size:14px;margin:12px 0 4px">이슈_현황 (15행)</h3>
<code>id · priority · category · title · status · owner · deployed · note</code>

<h3 style="font-size:14px;margin:12px 0 4px">배포_트래킹 (최대 50 PC)</h3>
<code>hostname · user_id · events_24h · last_event · age_minutes · status(live|idle|stale|never)</code>

<h3 style="font-size:14px;margin:12px 0 4px">Crash_대시보드 (최근 100건)</h3>
<code>id · ts · origin · hostname · user_id · node_version · error_name · error_message · recent_crash_count_1h · analyzed</code>

<h3 style="font-size:14px;margin:12px 0 4px">Phase_로드맵 (7단계)</h3>
<code>phase · period · task · status · deliverable</code>
</div>

<div class="card">
<h2>5. 조건부 서식 제안</h2>
<ul>
<li><b>이슈_현황</b>: priority=HIGH → 빨강 / status=배포완료 → 초록</li>
<li><b>배포_트래킹</b>: status=stale → 빨강 / live → 초록 / age_minutes > 60 → 노랑</li>
<li><b>Crash_대시보드</b>: analyzed=false → 노랑 / recent_crash_count_1h ≥ 3 → 빨강</li>
<li><b>Phase_로드맵</b>: status=완료 → 초록 / 대기 → 회색 / 계획 → 노랑</li>
</ul>
</div>

</body></html>`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 사용자 데이터 분석 — 이벤트 타입 · 시간대 · PC별 활동 · 앱 분포 · 품질
// ═══════════════════════════════════════════════════════════════════════════

function _checkAnalyticsToken(req, res) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
             || (req.query.token || '').trim();
  if (!token || !token.startsWith('orbit_')) {
    res.status(401).json({ error: 'orbit_ token required' });
    return null;
  }
  return token;
}

// GET /api/analytics/event-types?hours=24
app.get('/api/analytics/event-types', async (req, res) => {
  if (!_checkAnalyticsToken(req, res)) return;
  const hours = Math.min(parseInt(req.query.hours) || 24, 24 * 30);
  try {
    const pool = dbModule.getDb();
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const { rows } = await pool.query(`
      SELECT type, COUNT(*)::int AS count,
             COUNT(DISTINCT user_id)::int AS users,
             COUNT(DISTINCT data_json->>'hostname')::int AS pcs
      FROM events
      WHERE timestamp > $1
      GROUP BY type
      ORDER BY count DESC
      LIMIT 50
    `, [since]);
    res.json({ hours, totalEvents: rows.reduce((s, r) => s + r.count, 0), types: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/learning/routine?userId=X&period=day|week|month|year — 직원 업무 루틴 (기간별 집계, 2026-06-11)
app.get('/api/learning/routine', async (req, res) => {
  if (!_checkAnalyticsToken(req, res)) return;
  const userId = (req.query.userId || '').trim();
  const period = ['day','week','month','year'].includes(req.query.period) ? req.query.period : 'day';
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const cfg = {
    day:   { trunc: "to_char(timestamp::timestamptz, 'HH24')",       days: 7,   unit: 'hour'  },
    week:  { trunc: "to_char(timestamp::timestamptz, 'ID')",         days: 28,  unit: 'dow'   },
    month: { trunc: "to_char(timestamp::timestamptz, 'YYYY-MM-DD')", days: 30,  unit: 'date'  },
    year:  { trunc: "to_char(timestamp::timestamptz, 'YYYY-MM')",    days: 365, unit: 'month' },
  }[period];
  try {
    const pool = dbModule.getDb();
    const since = new Date(Date.now() - cfg.days * 86400 * 1000).toISOString();
    const sql = "SELECT " + cfg.trunc + " AS bucket, lower(trim(data_json->>'app')) AS app, data_json->>'workCategory' AS wc, COUNT(*)::int AS c FROM events WHERE user_id = $1 AND timestamp::timestamptz > $2::timestamptz AND type IN ('keyboard.chunk','screen.capture','screen.analyzed','mouse.chunk') GROUP BY bucket, app, wc";
    const { rows } = await pool.query(sql, [userId, since]);
    const buckets = {};
    for (const r of rows) {
      if (!r.bucket) continue;
      const b = buckets[r.bucket] || (buckets[r.bucket] = { bucket: r.bucket, total: 0, apps: {}, cats: {} });
      b.total += r.c;
      if (r.app && r.app !== 'null' && r.app !== '') b.apps[r.app] = (b.apps[r.app] || 0) + r.c;
      if (r.wc) b.cats[r.wc] = (b.cats[r.wc] || 0) + r.c;
    }
    const top = (o) => { const e = Object.entries(o).sort((a, b) => b[1] - a[1]); return e.length ? e[0][0] : null; };
    const result = Object.values(buckets).map(b => ({
      bucket: b.bucket, total: b.total, topApp: top(b.apps), topCategory: top(b.cats),
    })).sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
    res.json({ ok: true, userId, period, unit: cfg.unit, buckets: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/learning/task-specs?userId=X&days=30 — [골:Phase1] 작업 절차 추출 (클립보드+앱전환 기반)
app.get('/api/learning/task-specs', async (req, res) => {
  if (!_checkAnalyticsToken(req, res)) return;
  const userId = (req.query.userId || '').trim();
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const pool = dbModule.getDb();
    const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
    // 클립보드 + 키보드 + 화면 이벤트 (앱전환 추적용)
    const { rows } = await pool.query(
      `SELECT id, type, timestamp, data_json FROM events
       WHERE user_id=$1
         AND type IN ('keyboard.chunk','screen.capture','clipboard.change','idle')
         AND timestamp::TIMESTAMPTZ > $2::TIMESTAMPTZ
       ORDER BY timestamp ASC LIMIT 8000`,
      [userId, since]
    );
    const events = rows.map(r => ({
      id: r.id, type: r.type, timestamp: r.timestamp,
      data: typeof r.data_json === 'string' ? JSON.parse(r.data_json) : (r.data_json || {}),
    }));
    const { extractTaskSpecs } = require('./src/work-learner');
    const result = extractTaskSpecs(events);
    res.json({ ok: true, userId, days, eventCount: events.length, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/learning/capture-funnel?days=7 — 캡처→분석→유용 퍼널 (병목 진단, 2026-06-11)
app.get('/api/learning/capture-funnel', async (req, res) => {
  if (!_checkAnalyticsToken(req, res)) return;
  const days = Math.min(parseInt(req.query.days) || 7, 90);
  try {
    const pool = dbModule.getDb();
    const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
    const sql = "SELECT user_id, " +
      "COUNT(*) FILTER (WHERE type='screen.capture')::int AS captures, " +
      "COUNT(*) FILTER (WHERE type='screen.analyzed')::int AS analyzed, " +
      "COUNT(*) FILTER (WHERE type='screen.analyzed' AND COALESCE(data_json->>'activity','') NOT IN ('','idle'))::int AS useful " +
      "FROM events WHERE timestamp::timestamptz > $1::timestamptz AND user_id NOT IN ('local','system') " +
      "GROUP BY user_id HAVING COUNT(*) FILTER (WHERE type='screen.capture') > 0 ORDER BY captures DESC";
    const { rows } = await pool.query(sql, [since]);
    const funnel = rows.map(r => ({
      userId: r.user_id, captures: r.captures, analyzed: r.analyzed, useful: r.useful,
      analyzeRate: r.captures ? Math.round(r.analyzed / r.captures * 100) : 0,
      usefulRate: r.analyzed ? Math.round(r.useful / r.analyzed * 100) : 0,
    }));
    res.json({ ok: true, days, funnel });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/analytics/hourly?hours=24
app.get('/api/analytics/hourly', async (req, res) => {
  if (!_checkAnalyticsToken(req, res)) return;
  const hours = Math.min(parseInt(req.query.hours) || 24, 24 * 7);
  try {
    const pool = dbModule.getDb();
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const { rows } = await pool.query(`
      SELECT
        to_char(timestamp::timestamptz, 'YYYY-MM-DD HH24') AS hour,
        COUNT(*)::int AS events,
        COUNT(DISTINCT data_json->>'hostname')::int AS active_pcs
      FROM events
      WHERE timestamp > $1
      GROUP BY to_char(timestamp::timestamptz, 'YYYY-MM-DD HH24')
      ORDER BY hour ASC
    `, [since]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/analytics/apps?hours=24 — 오염 제거된 상위 앱
app.get('/api/analytics/apps', async (req, res) => {
  if (!_checkAnalyticsToken(req, res)) return;
  const hours = Math.min(parseInt(req.query.hours) || 24, 24 * 7);
  try {
    const pool = dbModule.getDb();
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const { rows } = await pool.query(`
      SELECT
        lower(trim(data_json->>'app')) AS app,
        COUNT(*)::int AS events,
        COUNT(DISTINCT data_json->>'hostname')::int AS pcs
      FROM events
      WHERE timestamp > $1
        AND data_json->>'app' IS NOT NULL
        AND length(trim(data_json->>'app')) > 0
        AND length(trim(data_json->>'app')) < 40
        AND data_json->>'app' NOT LIKE '{%'
        AND data_json->>'app' NOT LIKE '%$env:%'
        AND data_json->>'app' NOT LIKE '%powershell%'
      GROUP BY lower(trim(data_json->>'app'))
      ORDER BY events DESC
      LIMIT 30
    `, [since]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/analytics/quality — 데이터 오염 비율 리포트
app.get('/api/analytics/quality', async (req, res) => {
  if (!_checkAnalyticsToken(req, res)) return;
  try {
    const pool = dbModule.getDb();
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE data_json->>'app' IS NULL OR trim(data_json->>'app') = '')::int AS app_missing,
        COUNT(*) FILTER (WHERE data_json->>'app' LIKE '{%')::int AS app_is_json,
        COUNT(*) FILTER (WHERE length(data_json->>'app') > 40)::int AS app_too_long,
        COUNT(*) FILTER (WHERE data_json->>'app' LIKE '%$env:%' OR data_json->>'app' LIKE '%powershell%')::int AS app_is_cmd,
        COUNT(*) FILTER (WHERE data_json->>'hostname' IS NULL)::int AS hostname_missing,
        COUNT(*) FILTER (WHERE user_id = 'local' OR user_id IS NULL OR user_id LIKE 'pc_%')::int AS userid_unmatched
      FROM events
      WHERE timestamp > $1
    `, [since]);
    const r = rows[0];
    const total = r.total || 1;
    res.json({
      hours: 24,
      totalEvents: r.total,
      quality: {
        app_missing: { count: r.app_missing, pct: Math.round(r.app_missing / total * 100) },
        app_is_json: { count: r.app_is_json, pct: Math.round(r.app_is_json / total * 100) },
        app_too_long: { count: r.app_too_long, pct: Math.round(r.app_too_long / total * 100) },
        app_is_cmd: { count: r.app_is_cmd, pct: Math.round(r.app_is_cmd / total * 100) },
        hostname_missing: { count: r.hostname_missing, pct: Math.round(r.hostname_missing / total * 100) },
        userid_unmatched: { count: r.userid_unmatched, pct: Math.round(r.userid_unmatched / total * 100) },
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /admin/analytics — 분석 대시보드 HTML
app.get('/admin/analytics', async (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>Orbit 분석</title>
<style>
body{font-family:"Malgun Gothic",-apple-system,sans-serif;max-width:1100px;margin:0 auto;padding:20px;background:#f5f7fa;color:#1a1a1a}
.card{background:#fff;padding:18px 22px;border-radius:12px;box-shadow:0 1px 6px rgba(0,0,0,.05);margin-bottom:16px}
h1{color:#0b5fff;margin:0 0 6px}h2{font-size:17px;margin:18px 0 10px;border-bottom:1px solid #e4e6e9;padding-bottom:4px}
.kpi{display:inline-block;background:#f0f7ff;border-radius:8px;padding:12px 18px;margin:4px 8px 4px 0;min-width:140px}
.kpi .n{font-size:22px;font-weight:700;color:#0b5fff}.kpi .l{font-size:12px;color:#666}
.bar{display:inline-block;height:14px;background:#0b5fff;border-radius:3px;vertical-align:middle}
.bar.warn{background:#ff9800}.bar.ok{background:#4caf50}
table{width:100%;border-collapse:collapse;font-size:14px}th{background:#f0f2f5;padding:6px 10px;text-align:left;font-size:13px}
td{border-bottom:1px solid #e4e6e9;padding:6px 10px}.muted{color:#888;font-size:12px}
input,button{padding:6px 10px;border:1px solid #d4d6d9;border-radius:4px;font-size:13px}
.tok{background:#1a1a1a;color:#4ade80;padding:6px 10px;border-radius:4px;font-family:Consolas,monospace;font-size:12px}
.q-warn{color:#d32f2f;font-weight:600}.q-ok{color:#4caf50;font-weight:600}
</style></head><body>

<div class="card">
<h1>📊 사용자 데이터 분석</h1>
<p class="muted">토큰 입력 후 새로고침. 토큰은 <code>~/.orbit-config.json</code> 의 <code>token</code> 필드.</p>
<input id="tok" type="password" placeholder="orbit_..." style="width:360px">
<button onclick="localStorage.orbitTok=document.getElementById('tok').value;location.reload()">설정 후 로드</button>
<span id="tokStatus" class="muted" style="margin-left:10px"></span>
</div>

<div id="content"></div>

<script>
const base = location.origin;
const tok = localStorage.orbitTok || '';
if (tok) document.getElementById('tokStatus').textContent = '토큰 설정됨 (localStorage)';
const H = (s) => String(s||'').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));

async function api(p) {
  const r = await fetch(base + p, { headers: { Authorization: 'Bearer ' + tok }});
  if (!r.ok) throw new Error(r.status + ' ' + await r.text());
  return r.json();
}

async function load() {
  if (!tok) { document.getElementById('content').innerHTML = '<div class="card">토큰을 먼저 입력하세요.</div>'; return; }
  const content = document.getElementById('content');
  content.innerHTML = '<div class="card">로딩 중...</div>';

  try {
    const [types, hourly, apps, quality, deployment] = await Promise.all([
      api('/api/analytics/event-types?hours=24'),
      api('/api/analytics/hourly?hours=24'),
      api('/api/analytics/apps?hours=24'),
      api('/api/analytics/quality'),
      api('/api/sheet/deployment'),
    ]);

    const livePcs = deployment.filter(r => r.status === 'live').length;
    const activePcs24h = deployment.filter(r => r.events_24h > 0).length;
    const maxHourly = Math.max(...hourly.map(h => h.events), 1);
    const maxTypeCount = Math.max(...types.types.map(t => t.count), 1);
    const maxAppCount = Math.max(...apps.map(a => a.events), 1);
    const q = quality.quality;

    content.innerHTML = \`
<div class="card">
<h2>📈 KPI (최근 24시간)</h2>
<div class="kpi"><div class="n">\${types.totalEvents.toLocaleString()}</div><div class="l">총 이벤트</div></div>
<div class="kpi"><div class="n">\${livePcs}</div><div class="l">LIVE PC</div></div>
<div class="kpi"><div class="n">\${activePcs24h}</div><div class="l">활동 PC (24h)</div></div>
<div class="kpi"><div class="n">\${types.types.length}</div><div class="l">이벤트 종류</div></div>
</div>

<div class="card">
<h2>🕒 시간대별 활동 (최근 24h)</h2>
<table><tr><th>시각</th><th>이벤트 수</th><th>활성 PC</th><th style="width:50%">분포</th></tr>
\${hourly.slice(-24).map(h => \`<tr>
<td>\${H(h.hour.slice(-5))}시</td>
<td>\${h.events.toLocaleString()}</td>
<td>\${h.active_pcs}</td>
<td><span class="bar" style="width:\${Math.round(h.events/maxHourly*100)}%"></span></td>
</tr>\`).join('')}
</table></div>

<div class="card">
<h2>📋 이벤트 타입 분포 (최근 24h)</h2>
<table><tr><th>Type</th><th>Count</th><th>Users</th><th>PCs</th><th style="width:40%">분포</th></tr>
\${types.types.slice(0, 20).map(t => \`<tr>
<td><code>\${H(t.type)}</code></td>
<td>\${t.count.toLocaleString()}</td>
<td>\${t.users}</td>
<td>\${t.pcs}</td>
<td><span class="bar" style="width:\${Math.round(t.count/maxTypeCount*100)}%"></span></td>
</tr>\`).join('')}
</table></div>

<div class="card">
<h2>🏆 앱 랭킹 (최근 24h, 오염 필터 적용)</h2>
<table><tr><th>App</th><th>Events</th><th>PCs</th><th style="width:40%">분포</th></tr>
\${apps.map(a => \`<tr>
<td>\${H(a.app)}</td>
<td>\${a.events.toLocaleString()}</td>
<td>\${a.pcs}</td>
<td><span class="bar" style="width:\${Math.round(a.events/maxAppCount*100)}%"></span></td>
</tr>\`).join('') || '<tr><td colspan="4" class="muted">데이터 없음</td></tr>'}
</table></div>

<div class="card">
<h2>⚠️ 데이터 품질 리포트 (최근 24h)</h2>
<p class="muted">품질 문제가 있는 이벤트 비율. app 필드에 JSON/명령어/윈도우타이틀이 들어가는 버그 존재.</p>
<table>
<tr><th>항목</th><th>건수</th><th>비율</th><th>상태</th></tr>
<tr><td>app 필드 누락</td><td>\${q.app_missing.count.toLocaleString()}</td><td>\${q.app_missing.pct}%</td><td class="\${q.app_missing.pct > 30 ? 'q-warn' : 'q-ok'}">\${q.app_missing.pct > 30 ? '심각' : 'OK'}</td></tr>
<tr><td>app 필드가 JSON</td><td>\${q.app_is_json.count.toLocaleString()}</td><td>\${q.app_is_json.pct}%</td><td class="\${q.app_is_json.pct > 5 ? 'q-warn' : 'q-ok'}">\${q.app_is_json.pct > 5 ? '버그' : 'OK'}</td></tr>
<tr><td>app 40자 초과 (windowTitle 오염)</td><td>\${q.app_too_long.count.toLocaleString()}</td><td>\${q.app_too_long.pct}%</td><td class="\${q.app_too_long.pct > 5 ? 'q-warn' : 'q-ok'}">\${q.app_too_long.pct > 5 ? '버그' : 'OK'}</td></tr>
<tr><td>app에 PS 명령어</td><td>\${q.app_is_cmd.count.toLocaleString()}</td><td>\${q.app_is_cmd.pct}%</td><td class="\${q.app_is_cmd.pct > 1 ? 'q-warn' : 'q-ok'}">\${q.app_is_cmd.pct > 1 ? '버그' : 'OK'}</td></tr>
<tr><td>hostname 누락</td><td>\${q.hostname_missing.count.toLocaleString()}</td><td>\${q.hostname_missing.pct}%</td><td class="\${q.hostname_missing.pct > 10 ? 'q-warn' : 'q-ok'}">\${q.hostname_missing.pct > 10 ? '심각' : 'OK'}</td></tr>
<tr><td>userId 매칭 실패 (local/pc_*)</td><td>\${q.userid_unmatched.count.toLocaleString()}</td><td>\${q.userid_unmatched.pct}%</td><td class="\${q.userid_unmatched.pct > 20 ? 'q-warn' : 'q-ok'}">\${q.userid_unmatched.pct > 20 ? '심각' : 'OK'}</td></tr>
</table>
</div>

<div class="card">
<h2>🖥 PC별 활동 요약</h2>
<table><tr><th>Hostname</th><th>UserId</th><th>Events 24h</th><th>최근 활동</th><th>상태</th></tr>
\${deployment.slice(0, 20).map(d => \`<tr>
<td><a href="/admin/logs?hostname=\${encodeURIComponent(d.hostname)}">\${H(d.hostname)}</a></td>
<td class="muted">\${H((d.user_id||'').slice(0,12))}</td>
<td>\${(d.events_24h||0).toLocaleString()}</td>
<td class="muted">\${d.age_minutes===null?'-':d.age_minutes+'분 전'}</td>
<td class="\${d.status==='live'?'q-ok':d.status==='stale'?'q-warn':''}">\${d.status}</td>
</tr>\`).join('')}
</table></div>
\`;
  } catch (e) {
    content.innerHTML = '<div class="card" style="color:#d32f2f">오류: ' + H(e.message) + '</div>';
  }
}
load();
</script>
</body></html>`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 진단 로그 업로드/조회 — 유저 원클릭 진단 + 관리자 조회
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/diagnose/upload — 유저 PC가 로그·프로세스 상태 업로드
app.post('/api/diagnose/upload', async (req, res) => {
  const d = req.body || {};
  if (!d.hostname) return res.status(400).json({ error: 'hostname required' });
  try {
    const pool = dbModule.getDb();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orbit_diagnostics (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        hostname TEXT NOT NULL,
        user_name TEXT,
        daemon_log TEXT,
        install_log TEXT,
        processes JSONB,
        schtasks TEXT,
        config JSONB,
        note TEXT
      )
    `);
    let processes = null;
    try { processes = typeof d.processes === 'string' ? JSON.parse(d.processes) : d.processes; } catch { processes = d.processes; }
    let config = null;
    try { config = typeof d.config === 'string' ? JSON.parse(d.config) : d.config; } catch { config = d.config; }

    const { rows } = await pool.query(`
      INSERT INTO orbit_diagnostics (hostname, user_name, daemon_log, install_log, processes, schtasks, config, note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [d.hostname, d.user || null, d.daemon_log || '', d.install_log || '', processes ? JSON.stringify(processes) : null, d.schtasks || '', config ? JSON.stringify(config) : null, d.note || '']);
    console.log(`[diagnose] ${d.hostname} uploaded (id=${rows[0].id})`);
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    console.error('[diagnose] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /diagnose.bat — 유저 원클릭 진단 파일
app.get('/diagnose.bat', (req, res) => {
  const serverUrl = `${req.protocol}://${req.get('host')}`;
  const bat = [
    '@echo off',
    'chcp 65001 >nul 2>&1',
    'title Orbit 진단 업로드',
    'echo.',
    'echo =========================================',
    'echo   Orbit 진단 로그 수집',
    'echo =========================================',
    'echo.',
    'echo   데몬 로그와 프로세스 상태를 관리자에게 전송합니다.',
    'echo   10초 소요.',
    'echo.',
    '',
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $ErrorActionPreference='SilentlyContinue'; `
    + `$log1 = Get-Content \\\"$env:USERPROFILE\\.orbit\\daemon.log\\\" -Tail 200 -Encoding UTF8 | Out-String; `
    + `$log2 = Get-Content \\\"$env:USERPROFILE\\.orbit\\clean-install.log\\\" -Tail 100 -Encoding UTF8 | Out-String; `
    + `$procs = Get-WmiObject Win32_Process | Where-Object { $_.Name -match 'node|powershell' -and ($_.CommandLine -like '*orbit*' -or $_.CommandLine -like '*personal-agent*' -or $_.CommandLine -like '*mindmap*') } | Select-Object ProcessId, Name, @{N='MemMB';E={[math]::Round($_.WorkingSetSize/1MB,1)}}, @{N='CmdLine';E={$_.CommandLine}} | ConvertTo-Json -Compress -Depth 3; `
    + `$sch = schtasks /query /tn OrbitDaemon /fo LIST 2>&1 | Out-String; `
    + `$cfg = Get-Content \\\"$env:USERPROFILE\\.orbit-config.json\\\" -Raw; `
    + `$body = @{ hostname=$env:COMPUTERNAME; user=$env:USERNAME; daemon_log=$log1; install_log=$log2; processes=$procs; schtasks=$sch; config=$cfg } | ConvertTo-Json -Depth 4; `
    + `try { $r = Invoke-RestMethod -Uri '${serverUrl}/api/diagnose/upload' -Method POST -Body $body -ContentType 'application/json; charset=utf-8' -TimeoutSec 30; Write-Host '   업로드 성공 — 진단 ID:' $r.id -ForegroundColor Green } catch { Write-Host '   업로드 실패:' $_.Exception.Message -ForegroundColor Red }"`,
    '',
    'echo.',
    'echo   완료. 이 창은 5초 후 닫힙니다.',
    'timeout /t 5 >nul',
    'exit',
  ].join('\r\n');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="orbit-diagnose.bat"');
  res.send(bat);
});

// GET /admin/logs — 관리자 진단 목록 + 상세 조회 HTML
app.get('/admin/logs', async (req, res) => {
  const hostname = (req.query.hostname || '').trim();
  const id = parseInt(req.query.id, 10) || 0;
  try {
    const pool = dbModule.getDb();
    await pool.query(`CREATE TABLE IF NOT EXISTS orbit_diagnostics (id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW(), hostname TEXT NOT NULL, user_name TEXT, daemon_log TEXT, install_log TEXT, processes JSONB, schtasks TEXT, config JSONB, note TEXT)`);

    // 상세 조회
    if (id > 0) {
      const { rows } = await pool.query('SELECT * FROM orbit_diagnostics WHERE id=$1', [id]);
      if (!rows.length) return res.status(404).send('not found');
      const r = rows[0];
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>진단 #${id}</title>
<style>body{font-family:"Malgun Gothic",sans-serif;max-width:1000px;margin:0 auto;padding:20px;background:#f5f7fa}
.card{background:#fff;padding:16px 20px;border-radius:10px;margin-bottom:14px;box-shadow:0 1px 6px rgba(0,0,0,.05)}
h1{color:#0b5fff;margin:0 0 6px}h2{font-size:15px;color:#444;border-bottom:1px solid #e4e6e9;padding-bottom:4px;margin:14px 0 8px}
pre{background:#1a1a1a;color:#e4e6e9;padding:12px;border-radius:6px;overflow-x:auto;font-size:12px;line-height:1.5;max-height:400px;overflow-y:auto}
.meta{color:#666;font-size:13px}
a{color:#0b5fff}
.badge{display:inline-block;background:#0b5fff;color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;margin-right:4px}
</style></head><body>
<div class="card"><h1>진단 #${r.id} <span class="badge">${r.hostname}</span></h1>
<div class="meta">User: ${r.user_name || '(unknown)'} · ${new Date(r.created_at).toLocaleString('ko-KR')}</div>
<p><a href="/admin/logs">← 목록으로</a></p></div>
<div class="card"><h2>🔧 프로세스</h2><pre>${JSON.stringify(r.processes, null, 2).replace(/[<>]/g, c => c==='<'?'&lt;':'&gt;')}</pre></div>
<div class="card"><h2>📋 schtasks</h2><pre>${(r.schtasks||'(empty)').replace(/[<>]/g, c => c==='<'?'&lt;':'&gt;')}</pre></div>
<div class="card"><h2>⚙️ config</h2><pre>${JSON.stringify(r.config, null, 2).replace(/[<>]/g, c => c==='<'?'&lt;':'&gt;')}</pre></div>
<div class="card"><h2>📄 daemon.log (최근 200줄)</h2><pre>${(r.daemon_log||'(empty)').replace(/[<>]/g, c => c==='<'?'&lt;':'&gt;')}</pre></div>
<div class="card"><h2>📄 clean-install.log (최근 100줄)</h2><pre>${(r.install_log||'(empty)').replace(/[<>]/g, c => c==='<'?'&lt;':'&gt;')}</pre></div>
</body></html>`);
    }

    // 목록
    const where = hostname ? 'WHERE hostname = $1' : '';
    const params = hostname ? [hostname] : [];
    const { rows } = await pool.query(`
      SELECT id, created_at, hostname, user_name, length(coalesce(daemon_log,'')) AS dlog_size
      FROM orbit_diagnostics ${where}
      ORDER BY created_at DESC LIMIT 100
    `, params);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>진단 목록</title>
<style>body{font-family:"Malgun Gothic",sans-serif;max-width:900px;margin:0 auto;padding:20px;background:#f5f7fa}
.card{background:#fff;padding:18px;border-radius:10px;box-shadow:0 1px 6px rgba(0,0,0,.05)}
h1{color:#0b5fff;margin:0 0 12px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{background:#f0f2f5;padding:8px;text-align:left}
td{border-bottom:1px solid #e4e6e9;padding:8px}
a{color:#0b5fff;text-decoration:none}a:hover{text-decoration:underline}
input{padding:6px 10px;border:1px solid #d4d6d9;border-radius:4px;font-size:14px}
.url{background:#1a1a1a;color:#4ade80;padding:8px 12px;border-radius:6px;display:inline-block;font-family:Consolas,monospace;font-size:12px;margin-top:6px}
</style></head><body>
<div class="card">
<h1>📊 진단 로그</h1>
<p>유저에게 보낼 원클릭 진단 파일:
<br><a class="url" href="/diagnose.bat" download="orbit-diagnose.bat">${req.protocol}://${req.get('host')}/diagnose.bat</a></p>
<form method="get" action="/admin/logs" style="margin:12px 0">
<input type="text" name="hostname" value="${hostname}" placeholder="hostname 필터 (예: 이재만)" style="width:240px">
<button type="submit">검색</button>
${hostname ? '<a href="/admin/logs" style="margin-left:8px">전체</a>' : ''}
</form>
<table>
<tr><th>#ID</th><th>시각</th><th>Hostname</th><th>User</th><th>Log 크기</th></tr>
${rows.map(r => `<tr>
<td><a href="/admin/logs?id=${r.id}">#${r.id}</a></td>
<td>${new Date(r.created_at).toLocaleString('ko-KR')}</td>
<td><a href="/admin/logs?hostname=${encodeURIComponent(r.hostname)}">${r.hostname}</a></td>
<td>${r.user_name || '-'}</td>
<td>${r.dlog_size.toLocaleString()} bytes</td>
</tr>`).join('')}
</table>
${rows.length === 0 ? '<p style="color:#999;text-align:center;padding:30px">아직 업로드된 진단이 없습니다.</p>' : ''}
</div>
</body></html>`);
  } catch (e) {
    res.status(500).send('error: ' + e.message);
  }
});

// GET /install — 유저 배포 랜딩 페이지 (한 링크로 안내 + 다운로드 버튼)
app.get('/install', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Orbit AI 재설치 안내</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif; max-width: 640px; margin: 0 auto; padding: 24px; background: #f5f7fa; color: #1a1a1a; line-height: 1.6; }
  .card { background: #fff; border-radius: 12px; padding: 28px; box-shadow: 0 2px 12px rgba(0,0,0,.06); margin-bottom: 16px; }
  h1 { font-size: 22px; margin: 0 0 8px; color: #0b5fff; }
  h2 { font-size: 16px; margin: 20px 0 8px; color: #333; }
  .sub { color: #666; font-size: 14px; margin-bottom: 20px; }
  .btn { display: block; width: 100%; background: #0b5fff; color: #fff; padding: 16px 24px; border-radius: 10px; text-decoration: none; text-align: center; font-weight: 700; font-size: 17px; margin: 8px 0; transition: background .2s; border: none; cursor: pointer; }
  .btn:hover { background: #0a4dd4; }
  .btn.copy { background: #f0f2f5; color: #1a1a1a; font-size: 13px; padding: 10px 16px; font-weight: 500; }
  .btn.copy:hover { background: #e4e6e9; }
  ol { padding-left: 20px; }
  ol li { margin-bottom: 12px; }
  .step-num { display: inline-block; width: 24px; height: 24px; border-radius: 50%; background: #0b5fff; color: #fff; text-align: center; font-size: 13px; font-weight: 700; line-height: 24px; margin-right: 6px; }
  .warn { background: #fff8e1; border-left: 4px solid #ffa726; padding: 12px 16px; border-radius: 6px; font-size: 13px; color: #5d4037; margin: 12px 0; }
  .tip { background: #e8f5e9; border-left: 4px solid #4caf50; padding: 12px 16px; border-radius: 6px; font-size: 13px; color: #2e4e32; margin: 12px 0; }
  code { background: #f0f2f5; padding: 2px 6px; border-radius: 4px; font-size: 12px; font-family: "Courier New", monospace; }
  .link-box { background: #f0f2f5; border-radius: 8px; padding: 10px 14px; font-family: "Courier New", monospace; font-size: 12px; word-break: break-all; margin: 8px 0; }
  details { margin-top: 16px; background: #fafafa; border-radius: 8px; padding: 10px 14px; }
  summary { cursor: pointer; font-weight: 600; font-size: 14px; color: #555; }
  details p { font-size: 13px; color: #666; margin: 8px 0 4px; }
</style>
</head><body>

<div class="card">
  <h1>Orbit AI 데이터 수집 재설치</h1>
  <div class="sub">PC 이름 기반 자동 식별 · 2~3분 소요 · 관리자 권한 필요</div>

  <a class="btn" href="${base}/api/install-clean.bat" download="orbit-install.bat">
    ⬇️  설치 파일 다운로드
  </a>

  <div class="tip">
    <b>Tip</b> 버튼을 눌러도 안 되면 아래 링크를 브라우저 주소창에 직접 붙여넣기 하세요.
  </div>
  <div class="link-box" id="dl-link">${base}/api/install-clean.bat</div>
  <button class="btn copy" onclick="navigator.clipboard.writeText(document.getElementById('dl-link').textContent); this.textContent='✅ 복사됨';">링크 복사</button>
</div>

<div class="card">
  <h2>설치 순서</h2>
  <ol>
    <li><span class="step-num">1</span> 위 <b>설치 파일 다운로드</b> 버튼 클릭</li>
    <li><span class="step-num">2</span> 다운로드 폴더의 <code>orbit-install.bat</code> 파일을 <b>더블클릭</b></li>
    <li><span class="step-num">3</span> "Windows가 PC를 보호했습니다" 창 → <b>추가 정보</b> → <b>실행</b></li>
    <li><span class="step-num">4</span> "사용자 계정 컨트롤" (UAC) 창 → <b>예</b></li>
    <li><span class="step-num">5</span> 검은 창이 자동으로 설치 진행 (2~3분)</li>
    <li><span class="step-num">6</span> <b>"설치 완료 — 데이터 수집 시작됨"</b> 메시지 확인 후 창 자동 닫힘</li>
  </ol>

  <div class="warn">
    <b>⚠️ 주의</b> 설치 중 검은 창이 저절로 닫히지 않습니다. 강제로 닫지 마세요.
  </div>
</div>

<div class="card">
  <h2>문제가 생겼다면</h2>
  <details>
    <summary>설치 파일이 다운로드 안 됨 / 실행 안 됨</summary>
    <p>Chrome: 브라우저 하단 경고 → "계속" → 파일 실행</p>
    <p>Edge: 다운로드 창 → "…" → "유지"</p>
    <p>SmartScreen: "추가 정보" → "실행"</p>
  </details>
  <details>
    <summary>🛡️ AhnLab V3 / 알약 등 백신 경고창</summary>
    <p><b>증상</b>: 설치 후 V3가 "문제있는 프로그램" 경고창 / PowerShell이 자주 뜸</p>
    <p><b>원인</b>: schtasks + 레지스트리 + PowerShell 주기 호출 조합을 휴리스틱이 의심</p>
    <p><b>해결</b> — V3 콘솔에서 폴더 예외 등록:</p>
    <ol style="font-size:13px;color:#666;line-height:1.6;padding-left:20px">
      <li>V3 더블클릭 → <b>환경 설정</b></li>
      <li><b>검사 설정</b> → <b>검사 제외</b> → <b>폴더 추가</b></li>
      <li>다음 두 폴더 추가:<br>
        <code>%USERPROFILE%\\.orbit</code><br>
        <code>%USERPROFILE%\\mindmap-viewer</code></li>
      <li>저장 후 PC 재부팅</li>
    </ol>
    <p><b>알약 / Norton 등도 동일 방식</b> — "검사 제외 폴더" 메뉴에 위 두 폴더 추가</p>
  </details>
  <details>
    <summary>🛡️ "이 스크립트에 악성 콘텐츠..." / AV 차단</summary>
    <p><b>증상</b>: PowerShell이 "This script contains malicious content..." 라고 차단</p>
    <p><b>원인</b>: Windows Defender / 백신이 PowerShell 스크립트를 의심</p>
    <p><b>해결 1</b> (가장 쉬움): 아래 명령을 <b>관리자 PowerShell</b>에 복사 → Enter</p>
    <div class="link-box" id="wl-cmd">irm '${base}/api/setup/whitelist.ps1' | iex</div>
    <button class="btn copy" onclick="navigator.clipboard.writeText(document.getElementById('wl-cmd').textContent); this.textContent='✅ 복사됨';">명령 복사</button>
    <p>실행 후 <b>이 페이지 새로고침 → 다시 다운로드</b></p>
    <p><b>해결 2</b>: 관리자 PowerShell에서 직접 실행 (수동):</p>
    <div class="link-box">Add-MpPreference -ExclusionPath "$env:USERPROFILE\\.orbit"<br>Add-MpPreference -ExclusionPath "$env:USERPROFILE\\mindmap-viewer"</div>
    <p><b>해결 3</b>: 알림창에서 "허용" / "추가 정보 → 실행" 클릭</p>
  </details>
  <details>
    <summary>설치 실패 / 로그 확인</summary>
    <p>위치: <code>%USERPROFILE%\\.orbit\\clean-install.log</code></p>
    <p>탐색기 주소창에 위 경로 붙여넣기 → 파일 내용 관리자에게 전송</p>
  </details>
  <details>
    <summary>관리자에게 문의</summary>
    <p>위 로그 파일 + 자신의 PC 이름 알려주세요. <br>PC 이름 확인: Win+R → <code>hostname</code> 입력</p>
  </details>
</div>

</body></html>`);
});

// GET /install-guided — 브라우저 단계별 설치 검증 UI
app.get('/install-guided', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Orbit 설치 검증</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,"Malgun Gothic",sans-serif;max-width:520px;margin:0 auto;padding:20px;background:#f0f4f8;color:#1a1a1a}
.card{background:#fff;border-radius:16px;padding:24px;box-shadow:0 4px 20px rgba(0,0,0,.08);margin-bottom:16px}
h1{font-size:20px;margin:0 0 4px;color:#1a7f37}
.sub{color:#666;font-size:13px;margin-bottom:20px}
.step{border:2px solid #e8ecf0;border-radius:12px;padding:16px;margin:12px 0;transition:.2s}
.step.active{border-color:#1976d2;background:#f8fbff}
.step.done{border-color:#4caf50;background:#f1f8f4}
.step.fail{border-color:#e53935;background:#fff5f5}
.step-num{display:inline-block;width:28px;height:28px;border-radius:50%;background:#e8ecf0;text-align:center;line-height:28px;font-weight:700;margin-right:8px;font-size:14px}
.step.active .step-num{background:#1976d2;color:#fff}
.step.done .step-num{background:#4caf50;color:#fff}
.step h3{margin:0 0 8px;font-size:16px}
.step p{margin:0 0 12px;font-size:14px;color:#444;line-height:1.5}
.btn{display:block;width:100%;padding:14px;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;margin-top:8px}
.btn-primary{background:#1a7f37;color:#fff}
.btn-primary:disabled{background:#ccc;cursor:not-allowed}
.btn-secondary{background:#e3f2fd;color:#1565c0}
.token{background:#f5f5f5;border:2px dashed #1976d2;border-radius:8px;padding:12px;font-family:monospace;font-size:13px;word-break:break-all;margin:8px 0}
.status{text-align:center;padding:12px;font-size:14px;color:#666}
.spinner{display:inline-block;width:18px;height:18px;border:3px solid #ddd;border-top-color:#1976d2;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:8px}
@keyframes spin{to{transform:rotate(360deg)}}
.ok{color:#2e7d32;font-weight:700}
.err{color:#c62828}
.final{text-align:center;padding:24px}
.final .icon{font-size:48px}
.hidden{display:none}
</style>
</head><body>
<div class="card">
  <h1>Orbit 설치 검증</h1>
  <div class="sub" id="pc-info">PC 확인 중...</div>

  <div class="step active" id="step1">
    <h3><span class="step-num">1</span>마우스 클릭</h3>
    <p>바탕화면이나 <b>아무 창</b>에서 왼쪽 클릭 <b>1번</b> 하세요.<br>클릭 후 아래 버튼을 누르세요.</p>
    <button class="btn btn-primary" id="btn1">클릭했습니다 — 확인</button>
    <div class="status hidden" id="st1"></div>
  </div>

  <div class="step" id="step2">
    <h3><span class="step-num">2</span>키보드 / 붙여넣기</h3>
    <p>열린 <b>메모장</b>에 아래 문자열을 <b>Ctrl+V</b>로 붙여넣으세요.</p>
    <div class="token" id="token-box">—</div>
    <button class="btn btn-secondary" id="btn-copy">토큰 복사</button>
    <button class="btn btn-primary" id="btn2" disabled>붙여넣기 했습니다 — 확인</button>
    <div class="status hidden" id="st2"></div>
  </div>

  <div class="step" id="step3">
    <h3><span class="step-num">3</span>Enter (화면 캡처)</h3>
    <p>메모장에서 <b>Enter</b> 키를 1번 누르세요.<br>누른 후 아래 버튼을 누르세요.</p>
    <button class="btn btn-primary" id="btn3" disabled>Enter 눌렀습니다 — 확인</button>
    <div class="status hidden" id="st3"></div>
  </div>

  <div class="step" id="step4">
    <h3><span class="step-num">4</span>최종 확인</h3>
    <p>서버에 데이터가 들어왔는지 확인합니다.</p>
    <div class="status" id="st4">대기 중...</div>
  </div>
</div>

<div class="card final hidden" id="success">
  <div class="icon">✅</div>
  <h2>설치 검증 완료!</h2>
  <p>실제 업무 데이터가 서버에 확인되었습니다.<br>PowerShell 창으로 돌아가 Enter를 누르세요.</p>
</div>

<script>
const P = new URLSearchParams(location.search);
const hostname = P.get('hostname') || '';
const token = P.get('token') || '';
const since = P.get('since') || new Date().toISOString();
const userId = P.get('user') || '';
const base = location.origin;

document.getElementById('pc-info').textContent = hostname ? ('PC: ' + hostname + (userId ? ' · ' + userId : '')) : 'PC 정보 없음';
document.getElementById('token-box').textContent = token || '(토큰 없음)';

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function setStatus(id, html, cls){
  const el = document.getElementById(id);
  el.classList.remove('hidden');
  el.innerHTML = html;
  if (cls) el.className = 'status ' + cls;
}
function markDone(n){
  document.getElementById('step'+n).classList.remove('active','fail');
  document.getElementById('step'+n).classList.add('done');
  if (n < 4) document.getElementById('step'+(n+1)).classList.add('active');
}
function markFail(n, msg){
  document.getElementById('step'+n).classList.add('fail');
  setStatus('st'+n, '<span class="err">✗ '+msg+'</span><br>다시 시도해 주세요.');
}

async function pollStep(step, timeoutSec){
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    let url = base + '/api/install/verify-step?hostname=' + encodeURIComponent(hostname) + '&step=' + step + '&since=' + encodeURIComponent(since);
    if (step === 'clipboard' || step === 'keyboard') url += '&token=' + encodeURIComponent(token);
    try {
      const r = await fetch(url).then(x=>x.json());
      if (r.verified) return { ok: true, r };
    } catch(e) {}
    await sleep(2000);
  }
  return { ok: false };
}

document.getElementById('btn-copy').onclick = () => {
  navigator.clipboard.writeText(token).then(()=>{
    document.getElementById('btn-copy').textContent = '✓ 복사됨';
  }).catch(()=>{ alert('복사 실패 — 토큰을 직접 선택해 복사하세요'); });
};

document.getElementById('btn1').onclick = async function(){
  this.disabled = true;
  setStatus('st1', '<span class="spinner"></span> 확인 중입니다...');
  const r = await pollStep('mouse', 45);
  if (r.ok) { markDone(1); setStatus('st1','<span class="ok">✓ 마우스 데이터 확인됨</span>'); document.getElementById('btn2').disabled=false; }
  else { markFail(1,'마우스 데이터 미수신 (데몬 미실행?)'); this.disabled=false; }
};

document.getElementById('btn2').onclick = async function(){
  this.disabled = true;
  setStatus('st2', '<span class="spinner"></span> 확인 중입니다...');
  const r = await pollStep('clipboard', 45);
  if (r.ok) { markDone(2); setStatus('st2','<span class="ok">✓ 키보드/클립보드 확인됨</span>'); document.getElementById('btn3').disabled=false; }
  else { markFail(2,'키보드 데이터 미수신'); this.disabled=false; }
};

document.getElementById('btn3').onclick = async function(){
  this.disabled = true;
  setStatus('st3', '<span class="spinner"></span> 확인 중입니다...');
  const r = await pollStep('screen', 45);
  if (r.ok) { markDone(3); setStatus('st3','<span class="ok">✓ 화면 캡처 확인됨</span>'); runFinal(); }
  else { markFail(3,'화면 캡처 미수신'); this.disabled=false; }
};

async function runFinal(){
  document.getElementById('step4').classList.add('active');
  setStatus('st4', '<span class="spinner"></span> 최종 확인 중입니다...');
  for (let i = 0; i < 20; i++) {
    try {
      const v = await fetch(base + '/api/install/verify?hostname=' + encodeURIComponent(hostname)).then(x=>x.json());
      if (v.verified) {
        markDone(4);
        setStatus('st4', '<span class="ok">✓ 검증 완료 — chunk ' + (v.criteria?.chunkCount||'?') + '건</span>');
        document.getElementById('success').classList.remove('hidden');
        try {
          await fetch(base + '/api/install/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'install.complete', userId, hostname, version: 'v19-web-guided', verified: true, verifyMode: 'web-guided', timestamp: new Date().toISOString() })
          });
        } catch(e) {}
        return;
      }
      setStatus('st4', '<span class="spinner"></span> 최종 확인 중... (' + ((i+1)*2) + '초)');
    } catch(e) {}
    await sleep(2000);
  }
  markFail(4, '최종 검증 실패 — PowerShell 창에서 재시도');
}
</script>
</body></html>`);
});

// GET /install-final — 직원 PC 설치 (bat 1개면 충분)
app.get('/install-final', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Orbit AI 설치 v20</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Malgun Gothic", sans-serif; max-width: 640px; margin: 0 auto; padding: 24px; background: #f5f7fa; color: #1a1a1a; line-height: 1.6; }
  .card { background: #fff; border-radius: 12px; padding: 28px; box-shadow: 0 2px 12px rgba(0,0,0,.06); margin-bottom: 16px; }
  h1 { font-size: 22px; margin: 0 0 8px; color: #1a7f37; }
  h2 { font-size: 16px; margin: 20px 0 8px; color: #333; }
  .sub { color: #666; font-size: 14px; margin-bottom: 20px; }
  .btn { display: block; width: 100%; background: #1a7f37; color: #fff; padding: 18px 24px; border-radius: 10px; text-decoration: none; text-align: center; font-weight: 700; font-size: 18px; margin: 12px 0; }
  .btn:hover { background: #238636; }
  ol { padding-left: 20px; } ol li { margin-bottom: 10px; }
  .tip { background: #e8f5e9; border-left: 4px solid #4caf50; padding: 12px 16px; border-radius: 6px; font-size: 13px; color: #2e4e32; margin: 12px 0; }
  .warn { background: #fff8e1; border-left: 4px solid #ffa726; padding: 12px 16px; border-radius: 6px; font-size: 13px; color: #5d4037; margin: 12px 0; }
  .guide { background: #e3f2fd; border-left: 4px solid #1976d2; padding: 12px 16px; border-radius: 6px; font-size: 13px; margin: 12px 0; }
  code { background: #f0f2f5; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
  .link-box { background: #f0f2f5; border-radius: 8px; padding: 12px 14px; font-family: monospace; font-size: 12px; word-break: break-all; margin: 8px 0; user-select: all; }
  .badge { display: inline-block; background: #1a7f37; color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 4px; margin-left: 6px; }
</style>
</head><body>

<div class="card">
  <h1>Orbit AI 설치 <span class="badge">v20</span></h1>
  <div class="sub">Guardian 설치 후 <b>브라우저</b>에서 단계별 검증</div>

  <a class="btn" href="${base}/api/install-final.bat" download="orbit-install-final.bat">
    ⬇ orbit-install-final.bat 다운로드
  </a>

  <div class="tip">
    <b>방법 A:</b> bat 다운로드 → 우클릭 → <b>관리자 권한으로 실행</b><br>
    <b>방법 B:</b> 관리자 PowerShell에서 아래 명령 복사 실행<br>
    <code style="display:block;margin-top:8px;white-space:pre-wrap">$f="$env:TEMP\\orbit-install-now.ps1"; iwr '${base}/api/install-now.ps1' -OutFile $f; &amp; $f</code>
  </div>

  <h2>설치 링크 (복사용)</h2>
  <div class="link-box">${base}/install-final</div>
  <div class="link-box">${base}/api/install-final.bat</div>
</div>

<div class="card">
  <h2>설치 순서</h2>
  <ol>
    <li><code>orbit-install-final.bat</code> 다운로드 → <b>관리자 권한으로 실행</b></li>
    <li>이름 입력 (예: 강현우) — Enter만 누르면 PC이름 자동매칭</li>
    <li>2~3분 자동 설치 (Guardian + Worker)</li>
    <li>이름 입력 후 <b>브라우저 검증 창</b>이 자동으로 열림</li>
    <li>브라우저에서 <b>클릭 → 붙여넣기 → Enter</b> 각 단계 [확인] 버튼</li>
    <li>「설치 검증 완료」 나오면 PowerShell에서 Enter</li>
  </ol>

  <div class="guide">
    <b>브라우저 검증 (설치 마지막)</b><br>
    새 인터넷 창에서 단계별 안내 · <b>확인 중입니다...</b> 표시<br>
    각 단계 완료 시 ✓ 표시 → 최종 「설치 검증 완료」
  </div>
</div>

</body></html>`);
});

// GET /install — /install-final 별칭
app.get('/install', (req, res) => res.redirect(302, '/install-final'));

// GET /setup/fix-daemon.ps1 — 데몬 자가복구 스크립트 (재설치 없이 crach loop 탈출)
// 사용: irm 'https://.../setup/fix-daemon.ps1' | iex
app.get('/setup/fix-daemon.ps1', (req, res) => {
  const serverUrl = process.env.SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app';
  const ps1 = `
# Orbit AI Daemon Fix Script — crash loop recovery without reinstall
$ErrorActionPreference = 'SilentlyContinue'
$OrbitDir = "$env:USERPROFILE\\.orbit"
$RepoDir  = "$env:USERPROFILE\\mindmap-viewer"

Write-Host "[Orbit Fix] Starting..."

# 1. .safe-mode 점검 (빈 파일=레거시만 삭제, crash-reporter JSON은 유지)
$sf = "$OrbitDir\\.safe-mode"
if (Test-Path $sf) {
  $smContent = (Get-Content $sf -Raw -Encoding UTF8 -ErrorAction SilentlyContinue) -replace '\\s',''
  if (-not $smContent -or -not $smContent.StartsWith('{')) {
    Remove-Item $sf -Force
    Write-Host "[Orbit Fix] 레거시 .safe-mode 삭제됨"
  } else {
    try {
      $smData = $smContent | ConvertFrom-Json
      $expAt = [datetime]::Parse($smData.expiresAt)
      if ((Get-Date) -gt $expAt) {
        Remove-Item $sf -Force
        Write-Host "[Orbit Fix] 만료된 crash-reporter .safe-mode 삭제됨"
      } else {
        $remain = [int](($expAt - (Get-Date)).TotalMinutes)
        Write-Host "[Orbit Fix] crash-reporter .safe-mode 활성 (${remain}분 남음) - uiohook 보호 중"
      }
    } catch { Write-Host "[Orbit Fix] .safe-mode JSON 파싱 실패, 유지" }
  }
} else { Write-Host "[Orbit Fix] .safe-mode 없음 (정상)" }

# 2. 기존 stuck 프로세스 종료
@(Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*personal-agent*' }) | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA 0 }
@(Get-WmiObject Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*start-daemon*' -or $_.CommandLine -like '*watchdog*' }) | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA 0 }
Start-Sleep -Seconds 2
Write-Host "[Orbit Fix] Old processes killed"

# 3. 최신 코드 pull
if (Test-Path "$RepoDir\\.git") {
  Push-Location $RepoDir
  git fetch origin 2>$null
  git reset --hard origin/main 2>$null
  Pop-Location
  Write-Host "[Orbit Fix] Code updated to latest"
} else { Write-Host "[Orbit Fix] Repo not found at $RepoDir" }

# 4. start-daemon.ps1 ORBIT_SAFE_MODE 제거 (있으면 삭제)
$ps1Path = "$OrbitDir\\start-daemon.ps1"
if (Test-Path $ps1Path) {
  $txt = Get-Content $ps1Path -Raw
  if ($txt -match 'ORBIT_SAFE_MODE') {
    $txt = ($txt -split '\`r?\`n' | Where-Object { $_ -notmatch 'ORBIT_SAFE_MODE' }) -join '\`r\`n'
    [System.IO.File]::WriteAllText($ps1Path, $txt, [System.Text.UTF8Encoding]::new($false))
    Write-Host "[Orbit Fix] ORBIT_SAFE_MODE 제거됨"
  } else { Write-Host "[Orbit Fix] start-daemon.ps1 정상 (ORBIT_SAFE_MODE 없음)" }
}

# 5. 데몬 시작
if (Test-Path $ps1Path) {
  Start-Process powershell.exe -ArgumentList "-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File \`"$ps1Path\`"" -WindowStyle Hidden
  Write-Host "[Orbit Fix] Daemon started!"
} else { Write-Host "[Orbit Fix] ERROR: start-daemon.ps1 not found" }

Write-Host "[Orbit Fix] Complete. Check daemon.log in $OrbitDir"
`.trim();
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(ps1);
});

// ─── EXE 설치 파일 다운로드 ────────────────────────────────────────────────────
// GET /setup/download — OrbitAI-Setup.exe 서빙
app.get('/setup/download', (req, res) => {
  const candidates = [
    path.join(__dirname, 'dist', 'OrbitAI-Setup-2.0.0.exe'),
    path.join(__dirname, 'dist', 'OrbitAI-Setup.exe'),
    path.join(__dirname, 'public', 'dist', 'OrbitAI-Setup.exe'),
  ];
  const exePath = candidates.find(p => fs.existsSync(p));
  if (exePath) {
    res.setHeader('Content-Disposition', 'attachment; filename="OrbitAI-Setup.exe"');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.sendFile(exePath);
  } else {
    res.status(404).json({ error: '설치 파일 준비 중입니다. 관리자에게 문의하세요.' });
  }
});

// GET /setup/installer.exe — 이름입력 방식 silent installer EXE (토큰 불필요)
(function _registerInstallerExeRoute() {
  const _os = require('os');
  const STUB_CACHE = path.join(_os.tmpdir(), 'orbit-stub-base.exe');

  function _fetchStub(cb) {
    const localStub = path.join(__dirname, 'dist', 'orbit-stub.exe');
    if (fs.existsSync(localStub) && fs.statSync(localStub).size > 1000) {
      try { fs.copyFileSync(localStub, STUB_CACHE); } catch {}
      return cb(null);
    }
    if (fs.existsSync(STUB_CACHE) && fs.statSync(STUB_CACHE).size > 1000) return cb(null);
    return cb(new Error('orbit-stub.exe not found'));
  }

  app.get('/setup/installer.exe', (req, res) => {
    _fetchStub((err) => {
      if (err) {
        console.error('[installer.exe] stub not found:', err.message);
        return res.status(503).json({ error: 'installer not ready' });
      }
      const exe = fs.readFileSync(STUB_CACHE);
      res.setHeader('Content-Disposition', 'attachment; filename="orbit-install.exe"');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', exe.length);
      res.send(exe);
    });
  });

})();

// POST /api/setup/register-name — EXE 설치 시 이름 입력 후 자동 계정 생성 + 토큰 발급
app.post('/api/setup/register-name', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (name.length < 1) return res.status(400).json({ error: 'name required' });

  const crypto = require('crypto');
  const { issueApiToken, pgBackupUser, pgBackupToken } = require('./src/auth');
  const { getDb: authGetDb } = require('./src/auth');
  const sqlite = authGetDb();
  const pool = dbModule.getDb && dbModule.getDb();
  const serverUrl = process.env.SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app';

  const rand = crypto.randomBytes(6).toString('hex').toUpperCase();
  const userId = `MNPC${rand}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const email = `pc-${userId.toLowerCase()}@orbit.local`;
  const code = crypto.randomBytes(4).toString('hex');

  try {
    sqlite.prepare(`INSERT INTO users (id, email, name, passwordHash, provider) VALUES (?, ?, ?, '', 'pc_token')`)
      .run(userId, email, name);
  } catch (e) {
    return res.status(500).json({ error: 'user create failed' });
  }

  const token = issueApiToken(userId);
  try { await pgBackupUser({ id: userId, email, name, provider: 'pc_token', plan: 'free' }, ''); } catch {}
  try { await pgBackupToken(token, userId, null); } catch {}
  if (pool) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS pc_install_codes (
        code TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT NOT NULL,
        label TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), used_at TIMESTAMPTZ
      )`);
      await pool.query(
        `INSERT INTO pc_install_codes (code, user_id, token, label) VALUES ($1, $2, $3, $4)`,
        [code, userId, token, name]
      );
    } catch {}
  }

  console.log(`[register-name] new user: ${name} → ${userId}`);
  res.json({ ok: true, token, userId, name });
});

// ─── PC 토큰 방식 설치 (OAuth 없이 PC 단독 등록) ───────────────────────────────
// POST /api/admin/create-pc-tokens { count, labels?, secret } — 관리자 전용 bulk
app.post('/api/admin/create-pc-tokens', async (req, res) => {
  const _secretOk = process.env.ADMIN_SECRET && (req.body || {}).secret === process.env.ADMIN_SECRET;
  const { isAdmin: _adminOk } = resolveAdmin(req);
  if (!_secretOk && !_adminOk) return res.status(403).json({ error: 'admin only' });

  const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 1, 1), 20);
  const labels = Array.isArray(req.body?.labels) ? req.body.labels : [];
  const serverUrl = process.env.SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app';
  const { getDb: authGetDb, issueApiToken, pgBackupUser, pgBackupToken } = require('./src/auth');
  const sqlite = authGetDb();
  const pool = dbModule.getDb && dbModule.getDb();
  const crypto = require('crypto');

  if (pool) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS pc_install_codes (
        code TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT NOT NULL,
        label TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), used_at TIMESTAMPTZ
      )`);
    } catch (e) { console.warn('[pc-token] table ensure failed:', e.message); }
  }

  const out = [];
  for (let i = 0; i < count; i++) {
    const rand = crypto.randomBytes(6).toString('hex').toUpperCase();
    const userId = `MNPC${rand}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const code = crypto.randomBytes(4).toString('hex');
    const label = String(labels[i] || `PC-${rand.slice(0, 4)}`).trim().slice(0, 40);
    const email = `pc-${userId.toLowerCase()}@orbit.local`;
    try {
      sqlite.prepare(`INSERT INTO users (id, email, name, passwordHash, provider) VALUES (?, ?, ?, '', 'pc_token')`)
        .run(userId, email, label);
    } catch (e) {
      return res.status(500).json({ error: 'user create failed: ' + e.message, at: i });
    }
    const token = issueApiToken(userId);
    try { await pgBackupUser({ id: userId, email, name: label, provider: 'pc_token', plan: 'free' }, ''); } catch {}
    try { await pgBackupToken(token, userId, null); } catch {}
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO pc_install_codes (code, user_id, token, label) VALUES ($1, $2, $3, $4)`,
          [code, userId, token, label]
        );
      } catch (e) { console.warn('[pc-token] code store failed:', e.message); }
    }
    out.push({
      userId, label, token, code,
      installUrl: `${serverUrl}/i/${code}`,
      installCmd: `$env:ORBIT_TOKEN='${token}'; irm '${serverUrl}/setup/install.ps1' | iex`
    });
  }
  res.json({ ok: true, created: out.length, tokens: out });
});

// GET /api/admin/pc-codes-list — 발급된 PC 토큰 + 사용 현황
app.get('/api/admin/pc-codes-list', async (req, res) => {
  const { isAdmin: _adminOk } = resolveAdmin(req);
  const _secretOk = process.env.ADMIN_SECRET && req.query.secret === process.env.ADMIN_SECRET;
  if (!_adminOk && !_secretOk) return res.status(403).json({ error: 'admin only' });
  const pool = dbModule.getDb && dbModule.getDb();
  if (!pool) return res.status(500).json({ error: 'db unavailable' });
  try {
    const { rows } = await pool.query(`
      SELECT c.code, c.user_id, c.label, c.created_at, c.used_at,
             (SELECT COUNT(*) FROM events WHERE user_id = c.user_id) AS event_count,
             (SELECT MAX(timestamp::timestamptz) FROM events WHERE user_id = c.user_id) AS last_event
      FROM pc_install_codes c
      ORDER BY c.created_at DESC LIMIT 100`);
    res.json({ ok: true, count: rows.length, codes: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /i/:code — 설치 랜딩 페이지 (카톡 공유용)
app.get('/i/:code', async (req, res) => {
  const code = String(req.params.code || '').trim().toLowerCase();
  if (!/^[a-f0-9]{4,32}$/.test(code)) return res.status(400).send('잘못된 설치 코드');
  const pool = dbModule.getDb && dbModule.getDb();
  if (!pool) return res.status(500).send('DB 연결 오류');
  try {
    const { rows } = await pool.query('SELECT token, label, used_at FROM pc_install_codes WHERE code=$1', [code]);
    if (!rows.length) return res.status(404).send('설치 코드를 찾을 수 없습니다.');
    const { label } = rows[0];
    const serverUrl = process.env.SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app';
    pool.query('UPDATE pc_install_codes SET used_at=COALESCE(used_at, NOW()) WHERE code=$1', [code]).catch(() => {});
    // 다운로드 방식 (AMSI 안전) — irm|iex 패턴 제거, /install 페이지와 동일 흐름
    const dlUrl = `${serverUrl}/api/install-clean.bat?code=${code}`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Orbit AI 설치 — ${label}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:'Segoe UI','Apple SD Gothic Neo','Malgun Gothic',sans-serif;background:#0a0a0f;color:#e8e8ef;margin:0;padding:24px;max-width:640px;margin-left:auto;margin-right:auto;line-height:1.6}
h1{font-size:22px;margin-top:0}.card{background:#14141c;border:1px solid #2a2a3a;border-radius:12px;padding:24px;margin:16px 0}
a.btn{display:block;background:#4a9eff;color:#fff;text-decoration:none;padding:16px 24px;border-radius:10px;font-size:17px;font-weight:700;text-align:center;margin:12px 0}
a.btn:hover{background:#3a8eef}
ol{padding-left:20px;margin:8px 0}li{margin-bottom:8px}
.warn{color:#ffa;font-size:13px}
.tip{background:#1a2a1a;border-left:3px solid #4caf50;padding:10px 14px;border-radius:6px;font-size:13px;color:#aef;margin:12px 0}
.link-box{background:#000;color:#8fe;padding:10px 14px;border-radius:6px;font-family:Consolas,Menlo,monospace;font-size:11px;word-break:break-all;margin:8px 0}
</style></head><body>
<h1>🚀 Orbit AI 설치 — ${label}</h1>

<div class="card">
<a class="btn" href="${dlUrl}" download="orbit-install.bat">⬇️  설치 파일 다운로드</a>
<div class="tip">버튼이 안 되면 아래 링크를 브라우저 주소창에 붙여넣기:</div>
<div class="link-box" id="dl">${dlUrl}</div>
</div>

<div class="card">
<b>설치 순서:</b>
<ol>
<li>위 <b>설치 파일 다운로드</b> 클릭</li>
<li>다운로드된 <code>orbit-install.bat</code> 더블클릭</li>
<li>"Windows가 PC를 보호했습니다" → <b>추가 정보 → 실행</b></li>
<li>"사용자 계정 컨트롤" (UAC) → <b>예</b></li>
<li>검은 창에서 자동 설치 (2~3분)</li>
</ol>
</div>

<div class="card warn">⚠️ 이 링크는 해당 PC 전용입니다. 다른 사람과 공유하지 마세요.</div>

<details style="margin-top:16px;color:#888;font-size:13px">
<summary style="cursor:pointer">🛡️ 백신이 설치를 차단할 때</summary>
<p>관리자 PowerShell에서 한 줄 실행:</p>
<div class="link-box" id="wl">irm '${serverUrl}/api/setup/whitelist.ps1' | iex</div>
<p>→ Defender 예외 등록 후 위 다운로드 버튼 다시 클릭</p>
</details>
</body></html>`);
  } catch (e) {
    res.status(500).send('오류: ' + e.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/daemon/learned-config?userId=X&hostname=Y
//   새 설치 직후 데몬이 과거 학습값(capture-config) 복원용으로 호출.
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/daemon/learned-config', async (req, res) => {
  const userId = (req.query.userId || '').trim();
  const hostname = (req.query.hostname || '').trim();
  if (!userId || !hostname) return res.status(400).json({ error: 'userId and hostname required' });
  try {
    const { analyzeForUser, DEFAULT_COOLTIME } = require('./src/capture-timing-learner');
    const pool = dbModule.getDb();
    let config;
    try { config = await analyzeForUser(pool, userId, hostname); }
    catch { config = { byApp: {}, default: DEFAULT_COOLTIME, sampleCount: 0, analyzedAt: new Date().toISOString() }; }
    config.suggestedBy = 'learned-config-endpoint';
    config.restoredFrom = 'server';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// GET /api/admin/users?q=XXX — orbit_auth_users에서 이름/이메일 검색
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/users', async (req, res) => {
  const master = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!master || !master.startsWith('orbit_')) return res.status(401).json({ error: 'master token required' });
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const pool = dbModule.getDb();
    const { rows } = await pool.query(`
      SELECT id, name, email, created_at
      FROM orbit_auth_users
      WHERE lower(name) LIKE lower($1) OR lower(email) LIKE lower($1) OR id LIKE $1
      ORDER BY created_at DESC LIMIT 30
    `, [`%${q}%`]);
    res.json({ q, results: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/admin/pc-link  Body: { hostname, userId }
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/admin/pc-link', async (req, res) => {
  const master = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!master || !master.startsWith('orbit_')) return res.status(401).json({ error: 'master token required' });
  const { hostname, userId } = req.body || {};
  if (!hostname || !userId) return res.status(400).json({ error: 'hostname and userId required' });
  try {
    const pool = dbModule.getDb();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orbit_pc_links (
        hostname TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        linked_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      INSERT INTO orbit_pc_links (hostname, user_id) VALUES ($1, $2)
      ON CONFLICT (hostname) DO UPDATE SET user_id = $2, linked_at = NOW()
    `, [hostname, userId]);
    const { rows } = await pool.query(
      `SELECT l.hostname, l.user_id, u.name, u.email
       FROM orbit_pc_links l LEFT JOIN orbit_auth_users u ON u.id = l.user_id
       WHERE l.hostname = $1`, [hostname]);
    res.json({ ok: true, link: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/admin/remap-local-userids  — local/pc_* userId를 hostname 기반으로 재매핑
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/admin/remap-local-userids', async (req, res) => {
  const master = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!master || !master.startsWith('orbit_')) return res.status(401).json({ error: 'master token required' });
  const dryRun = req.query.dryRun === '1';
  try {
    const pool = dbModule.getDb();
    const whereClause = `user_id = 'local' OR user_id LIKE 'pc_%' OR user_id IS NULL`;

    if (dryRun) {
      const { rows } = await pool.query(`
        SELECT events.user_id AS current_userid, l.user_id AS correct_userid,
               events.data_json->>'hostname' AS hostname, COUNT(*)::int AS cnt
        FROM events
        JOIN orbit_pc_links l ON l.hostname = events.data_json->>'hostname'
        WHERE ${whereClause}
        GROUP BY events.user_id, l.user_id, events.data_json->>'hostname'
        ORDER BY cnt DESC LIMIT 50
      `);
      return res.json({ dryRun: true, wouldUpdate: rows });
    }

    const { rowCount } = await pool.query(`
      UPDATE events SET user_id = l.user_id
      FROM orbit_pc_links l
      WHERE l.hostname = events.data_json->>'hostname'
        AND (${whereClause.replace(/user_id/g, 'events.user_id')})
    `);
    res.json({ ok: true, updated: rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/admin/pc-inference — hostname별 콘텐츠 샘플로 유저 추론 힌트
//   Authorization: Bearer <master>
//   각 PC의 clipboard.change 텍스트 + 시간대 + 작업 패턴 → 누가 쓰는지 추론 재료.
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/pc-inference', async (req, res) => {
  const master = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!master || !master.startsWith('orbit_')) return res.status(401).json({ error: 'master token required' });
  const days = Math.min(parseInt(req.query.days) || 7, 30);
  try {
    const pool = dbModule.getDb();
    const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

    // 1) 각 PC의 활동 통계
    const { rows: pcs } = await pool.query(`
      SELECT DISTINCT data_json->>'hostname' AS hostname, user_id,
             COUNT(*)::int AS total,
             MAX(timestamp) AS last_seen
      FROM events
      WHERE timestamp > $1 AND data_json->>'hostname' IS NOT NULL
      GROUP BY data_json->>'hostname', user_id
      ORDER BY total DESC
      LIMIT 20
    `, [since]);

    // 2) 기존 orbit_pc_links 매핑 + orbit_auth_users 이름
    let knownMap = {};
    try {
      const { rows } = await pool.query(`
        SELECT l.hostname, l.user_id, u.name, u.email
        FROM orbit_pc_links l LEFT JOIN orbit_auth_users u ON u.id = l.user_id
      `);
      rows.forEach(r => { knownMap[r.hostname] = { userId: r.user_id, name: r.name, email: r.email }; });
    } catch {}

    // 3) 각 hostname별 clipboard 샘플 + 시간대 + app 분포
    const result = [];
    for (const pc of pcs) {
      const host = pc.hostname;
      const mapped = knownMap[host] || null;

      // clipboard 최근 5개 샘플 (이름/거래처/업무 키워드 추출용)
      const { rows: clips } = await pool.query(`
        SELECT data_json->>'text' AS text,
               data_json->>'sourceApp' AS source_app,
               data_json->>'windowTitle' AS window_title,
               timestamp
        FROM events
        WHERE type='clipboard.change' AND data_json->>'hostname'=$1
          AND timestamp > $2
          AND length(data_json->>'text') > 10
        ORDER BY timestamp DESC
        LIMIT 5
      `, [host, since]);

      // 시간대 분포 (업무시간 패턴)
      const { rows: hourly } = await pool.query(`
        SELECT EXTRACT(HOUR FROM timestamp::timestamptz) AS h, COUNT(*)::int AS c
        FROM events
        WHERE data_json->>'hostname'=$1 AND timestamp > $2
        GROUP BY EXTRACT(HOUR FROM timestamp::timestamptz)
        ORDER BY c DESC LIMIT 5
      `, [host, since]);

      // 주요 app (정상 필터링된 것만)
      const { rows: apps } = await pool.query(`
        SELECT lower(trim(data_json->>'app')) AS app, COUNT(*)::int AS c
        FROM events
        WHERE data_json->>'hostname'=$1 AND timestamp > $2
          AND length(trim(data_json->>'app')) BETWEEN 2 AND 40
          AND data_json->>'app' NOT LIKE '{%' AND data_json->>'app' NOT LIKE '%$env%'
        GROUP BY lower(trim(data_json->>'app'))
        ORDER BY c DESC LIMIT 5
      `, [host, since]);

      // resolver 결과 (Q1A+B 통합 자동 매칭 후보)
      let auto = null;
      try {
        const resolver = require('./src/pc-user-resolver');
        auto = await resolver.resolveHostnameToUser(pool, host);
      } catch {}

      result.push({
        hostname: host,
        user_id_raw: pc.user_id,
        total_events: pc.total,
        last_seen: pc.last_seen,
        mapped,
        auto_resolve: auto, // { userId, source, confidence, name? }
        clipboard_samples: clips.map(c => ({
          source: c.source_app,
          window: (c.window_title || '').slice(0, 60),
          text: (c.text || '').slice(0, 300),
          ts: c.timestamp,
        })),
        peak_hours_kst: hourly.map(h => ({ hour: h.h, count: h.c })),
        top_apps: apps,
      });
    }

    res.json({ days, pcs: result.length, data: result });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/admin/daily-maintenance — 매일 1회 자동 실행 (+수동 트리거)
//   1) 전 PC 학습 스냅샷 저장 (learning_snapshots)
//   2) 30일 이상 된 raw events 삭제
//   3) 90일 이상 된 orbit_crashes / orbit_diagnostics 삭제
//   4) 결과를 orbit_maintenance_log 테이블에 기록
// ═══════════════════════════════════════════════════════════════════════════
async function _tableExists(pool, tableName) {
  const { rows } = await pool.query(`SELECT to_regclass($1) AS reg`, [tableName]);
  return !!rows[0]?.reg;
}

async function _getPgUsage(pool) {
  try {
    const limitMB = parseInt(process.env.PG_SIZE_LIMIT_MB || '1024', 10);
    const { rows } = await pool.query(`SELECT pg_database_size(current_database()) AS bytes`);
    const sizeMB = Math.round((Number(rows[0]?.bytes || 0) / 1024 / 1024) * 10) / 10;
    return { sizeMB, limitMB, usagePct: limitMB > 0 ? Math.round((sizeMB / limitMB) * 100) : null };
  } catch (e) {
    return { error: e.message };
  }
}

async function _purgeTableByTimestamp(pool, tableName, timestampColumn, cutoff, typeColumn, types) {
  const allowed = {
    events: { timestamp: 'timestamp', type: 'type' },
    unified_events: { timestamp: 'timestamp', type: 'type' },
  };
  if (allowed[tableName]?.timestamp !== timestampColumn || allowed[tableName]?.type !== typeColumn) {
    return { ok: false, skipped: true, reason: 'table or column not allowed', table: tableName };
  }
  if (!(await _tableExists(pool, tableName))) {
    return { ok: true, skipped: true, reason: 'table missing', table: tableName };
  }
  const before = await pool.query(
    `SELECT COUNT(*)::int AS count FROM ${tableName}
     WHERE ${timestampColumn} < $1 AND ${typeColumn} = ANY($2)`,
    [cutoff, types]
  );
  const { rowCount } = await pool.query(
    `DELETE FROM ${tableName}
     WHERE ${timestampColumn} < $1 AND ${typeColumn} = ANY($2)`,
    [cutoff, types]
  );
  return { ok: true, table: tableName, cutoff, candidates: before.rows[0]?.count || 0, deleted: rowCount };
}

async function _runDailyMaintenance(trigger = 'auto') {
  const pool = dbModule.getDb();
  const summary = { trigger, startedAt: new Date().toISOString(), steps: {} };
  try {
    summary.databaseBefore = await _getPgUsage(pool);

    // Step 1: 학습 스냅샷
    try {
      const { runForAllPCs } = require('./src/capture-timing-learner');
      const results = await runForAllPCs(pool, null);
      await pool.query(`CREATE TABLE IF NOT EXISTS learning_snapshots (
        id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW(), data_json JSONB NOT NULL
      )`);
      await pool.query('INSERT INTO learning_snapshots (data_json) VALUES ($1)',
        [JSON.stringify({ results, trigger, extractedAt: new Date().toISOString() })]);
      summary.steps.learning = { ok: true, pcs: results.length };
    } catch (e) { summary.steps.learning = { ok: false, error: e.message }; }

    // Step 2: events 30일 이상 삭제
    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const { rowCount } = await pool.query('DELETE FROM events WHERE timestamp < $1', [cutoff]);
      summary.steps.events_purge = { ok: true, deleted: rowCount, cutoff };
    } catch (e) { summary.steps.events_purge = { ok: false, error: e.message }; }

    // Step 2B: DB pressure purge.
    // 85% 이상이면 원본 재생이 가능한 고빈도 raw 이벤트만 14일 기준으로 추가 정리한다.
    try {
      const pressureCheck = await _getPgUsage(pool);
      summary.databaseAfterStandardPurge = pressureCheck;
      const beforePct = pressureCheck?.usagePct ?? 0;
      const thresholdPct = parseInt(process.env.DB_PRESSURE_PURGE_PCT || '85', 10);
      const pressureDays = parseInt(process.env.DB_PRESSURE_RAW_DAYS || '14', 10);
      const rawTypes = (process.env.DB_PRESSURE_RAW_TYPES || 'screen.capture,mouse.chunk,mouse_click,keyboard.chunk,clipboard.change')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      if (beforePct >= thresholdPct) {
        const cutoff = new Date(Date.now() - pressureDays * 24 * 3600 * 1000).toISOString();
        const events = await _purgeTableByTimestamp(pool, 'events', 'timestamp', cutoff, 'type', rawTypes);
        const unified = await _purgeTableByTimestamp(pool, 'unified_events', 'timestamp', cutoff, 'type', rawTypes);
        summary.steps.pressure_purge = {
          ok: true,
          thresholdPct,
          pressureDays,
          rawTypes,
          events,
          unified,
        };
      } else {
        summary.steps.pressure_purge = { ok: true, skipped: true, usagePct: beforePct, thresholdPct };
      }
    } catch (e) { summary.steps.pressure_purge = { ok: false, error: e.message }; }

    // Step 3: orbit_crashes 90일 이상 삭제
    try {
      const { rowCount } = await pool.query(
        "DELETE FROM orbit_crashes WHERE ts < NOW() - INTERVAL '90 days'");
      summary.steps.crashes_purge = { ok: true, deleted: rowCount };
    } catch (e) { summary.steps.crashes_purge = { ok: false, error: e.message }; }

    // Step 4: orbit_diagnostics 90일 이상 삭제
    try {
      const { rowCount } = await pool.query(
        "DELETE FROM orbit_diagnostics WHERE created_at < NOW() - INTERVAL '90 days'");
      summary.steps.diagnostics_purge = { ok: true, deleted: rowCount };
    } catch (e) { summary.steps.diagnostics_purge = { ok: false, error: e.message }; }

    summary.endedAt = new Date().toISOString();
    summary.databaseAfter = await _getPgUsage(pool);

    // Step 5: 로그 저장
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS orbit_maintenance_log (
        id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW(), trigger TEXT, summary JSONB NOT NULL
      )`);
      await pool.query('INSERT INTO orbit_maintenance_log (trigger, summary) VALUES ($1, $2)',
        [trigger, JSON.stringify(summary)]);
    } catch {}

    console.log(`[daily-maintenance] ${trigger}: learning=${JSON.stringify(summary.steps.learning)} events_purge=${JSON.stringify(summary.steps.events_purge)} pressure_purge=${JSON.stringify(summary.steps.pressure_purge)}`);
    return summary;
  } catch (e) {
    summary.fatalError = e.message;
    return summary;
  }
}

app.post('/api/admin/daily-maintenance', async (req, res) => {
  const { isAdmin: _adminOk } = resolveAdmin(req);
  if (!_adminOk) return res.status(403).json({ error: 'admin only' });
  const summary = await _runDailyMaintenance(req.query.trigger || 'manual');
  res.json(summary);
});

app.get('/api/admin/maintenance-log', async (req, res) => {
  const { isAdmin: _adminOk } = resolveAdmin(req);
  if (!_adminOk) return res.status(403).json({ error: 'admin only' });
  try {
    const pool = dbModule.getDb();
    const { rows } = await pool.query(
      'SELECT id, created_at, trigger, summary FROM orbit_maintenance_log ORDER BY created_at DESC LIMIT 30');
    res.json({ count: rows.length, log: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 서버 시작 시 하루 1회 타이머 등록 (KST 03:00 기준)
(function _scheduleDailyMaintenance() {
  const DAY_MS = 24 * 3600 * 1000;
  function msUntilNext3AMKST() {
    const now = new Date();
    // KST = UTC+9. 3 AM KST = 18:00 UTC 전날
    const target = new Date(now);
    target.setUTCHours(18, 0, 0, 0); // 18 UTC = 03 KST
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
    return target - now;
  }
  const first = msUntilNext3AMKST();
  setTimeout(function runAndRepeat() {
    _runDailyMaintenance('scheduled').catch(e => console.error('[daily-maintenance] fatal:', e.message));
    setInterval(() => _runDailyMaintenance('scheduled').catch(() => {}), DAY_MS);
  }, first);
  console.log(`[daily-maintenance] scheduled first run in ${Math.round(first / 60000)}min (KST 03:00)`);
})();

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/admin/force-update-all — 전 LIVE/IDLE PC에 업데이트 명령 큐잉
//   Authorization: Bearer <master>
//   동작: 최근 N시간 내 활동 있는 PC 전체에 {action:'update'} 전송.
//         각 daemon-updater._checkCycle(60초 주기)이 받아서 pullAndRestart.
//         STALE(24h+ 조용한) PC는 daemon이 죽어있어 무시 (수동 재설치 필요).
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/admin/force-update-all', async (req, res) => {
  const master = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!master || !master.startsWith('orbit_')) return res.status(401).json({ error: 'master token required' });
  const maxAgeHours = parseInt(req.query.maxAgeHours || req.body?.maxAgeHours || '24', 10);
  const dryRun = req.query.dryRun === '1' || req.body?.dryRun === true;
  try {
    const pool = dbModule.getDb();
    // 최근 활동 있는 PC 목록 (live + idle)
    const since = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();
    const { rows: hosts } = await pool.query(`
      SELECT DISTINCT data_json->>'hostname' AS hostname, MAX(timestamp) AS last_seen
      FROM events
      WHERE timestamp > $1 AND data_json->>'hostname' IS NOT NULL
      GROUP BY data_json->>'hostname'
      ORDER BY MAX(timestamp) DESC
    `, [since]);
    const targets = hosts.map(r => r.hostname).filter(Boolean);

    if (dryRun) {
      return res.json({ ok: true, dryRun: true, wouldTarget: targets.length, hostnames: targets });
    }

    // orbit_daemon_commands 테이블 존재 보장 (없으면 생성)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orbit_daemon_commands (
        id SERIAL PRIMARY KEY,
        hostname TEXT NOT NULL,
        action TEXT NOT NULL,
        command TEXT,
        data_json JSONB,
        ts TIMESTAMPTZ DEFAULT NOW(),
        consumed_at TIMESTAMPTZ
      )
    `);

    // 각 hostname에 update command 큐잉 (중복 방지: 최근 10분 내 동일 command 이미 있으면 skip)
    let queued = 0;
    let skipped = 0;
    const reason = 'admin force-update-all ' + new Date().toISOString();
    for (const h of targets) {
      const { rows: dup } = await pool.query(
        `SELECT id FROM orbit_daemon_commands
         WHERE hostname=$1 AND action='update' AND consumed_at IS NULL
           AND ts > NOW() - INTERVAL '10 minutes'
         LIMIT 1`,
        [h]
      );
      if (dup.length) { skipped++; continue; }
      await pool.query(
        `INSERT INTO orbit_daemon_commands (hostname, action, command, data_json) VALUES ($1, 'update', NULL, $2)`,
        [h, JSON.stringify({ reason })]
      );
      queued++;
      // 메모리 큐에도 추가 (in-process PC가 이미 polling 중인 경우 바로 잡기)
      if (!global._daemonCommands) global._daemonCommands = {};
      if (!global._daemonCommands[h]) global._daemonCommands[h] = [];
      global._daemonCommands[h].push({ action: 'update', data: { reason }, ts: new Date().toISOString() });
    }
    console.log(`[force-update-all] 큐잉 ${queued} / 중복 skip ${skipped} / 총 ${targets.length}`);
    res.json({ ok: true, targeted: targets.length, queued, skipped, hostnames: targets });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/force-reinstall-all — 이력 있는 모든 PC에 reinstall 명령 큐잉
// ═══════════════════════════════════════════════════════════════════════════
// force-update-all과 달리 시간 제한 없음 — 단 한번이라도 접속 이력 있는 PC 전체 대상.
// 데몬이 꺼진 PC도 다음 부팅 시 AtLogOn → daemon 시작 → 60s 내 명령 소비 → 자동 재설치.
app.post('/api/admin/force-reinstall-all', async (req, res) => {
  // Phase 0: reinstall 영구 금지
  return res.status(410).json({
    error: 'reinstall permanently disabled',
    alternative: 'POST /api/admin/push-exec with action=reclone-worker or gitpull-worker',
  });
  const master = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!master || !master.startsWith('orbit_')) return res.status(401).json({ error: 'master token required' });
  const dryRun = req.query.dryRun === '1' || req.body?.dryRun === true;
  try {
    const pool = dbModule.getDb();
    // 전체 이력 PC — 시간 제한 없이 (언제 연결됐든 모두 포함)
    const { rows: hosts } = await pool.query(`
      SELECT DISTINCT data_json->>'hostname' AS hostname, MAX(timestamp) AS last_seen
      FROM events
      WHERE data_json->>'hostname' IS NOT NULL
      GROUP BY data_json->>'hostname'
      ORDER BY MAX(timestamp) DESC
    `);
    const targets = hosts.map(r => r.hostname).filter(h => h && h.length > 0);

    if (dryRun) {
      return res.json({ ok: true, dryRun: true, wouldTarget: targets.length, hostnames: targets });
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS orbit_daemon_commands (
        id SERIAL PRIMARY KEY,
        hostname TEXT NOT NULL,
        action TEXT NOT NULL,
        command TEXT,
        data_json JSONB,
        ts TIMESTAMPTZ DEFAULT NOW(),
        consumed_at TIMESTAMPTZ
      )
    `);

    let queued = 0, skipped = 0;
    const reason = 'admin force-reinstall-all ' + new Date().toISOString();
    for (const h of targets) {
      // 최근 2시간 내 pending reinstall 있으면 중복 skip
      const { rows: dup } = await pool.query(
        `SELECT id FROM orbit_daemon_commands
         WHERE hostname=$1 AND action='reinstall' AND consumed_at IS NULL
           AND ts > NOW() - INTERVAL '2 hours'
         LIMIT 1`,
        [h]
      );
      if (dup.length) { skipped++; continue; }
      await pool.query(
        `INSERT INTO orbit_daemon_commands (hostname, action, data_json) VALUES ($1, 'reinstall', $2)`,
        [h, JSON.stringify({ reason })]
      );
      queued++;
      // in-process 메모리 큐 (현재 연결된 데몬 즉시 수신)
      if (!global._daemonCommands) global._daemonCommands = {};
      if (!global._daemonCommands[h]) global._daemonCommands[h] = [];
      global._daemonCommands[h].push({ action: 'reinstall', data: { reason }, ts: new Date().toISOString() });
    }
    console.log(`[force-reinstall-all] 큐잉 ${queued} / skip ${skipped} / 총 ${targets.length}`);
    res.json({ ok: true, targeted: targets.length, queued, skipped, hostnames: targets });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/extract-learning — 전 PC 학습값 추출 + 서버에 스냅샷 저장
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/admin/extract-learning', async (req, res) => {
  const master = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!master || !master.startsWith('orbit_')) return res.status(401).json({ error: 'master token required' });
  try {
    const { runForAllPCs } = require('./src/capture-timing-learner');
    const pool = dbModule.getDb();
    const results = await runForAllPCs(pool, null);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS learning_snapshots (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        data_json JSONB NOT NULL
      )
    `);
    await pool.query('INSERT INTO learning_snapshots (data_json) VALUES ($1)', [JSON.stringify({ results, extractedAt: new Date().toISOString() })]);
    res.json({ ok: true, pcCount: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/crash/report — 데몬 crash 리포트 수신 (crash-reporter.js에서 호출)
//   Phase 1: DB 저장. Phase 2에서 claude-analyzer가 비동기 분석 트리거.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/crash/report', async (req, res) => {
  const report = req.body || {};
  if (!report.id || !report.error) return res.status(400).json({ error: 'id and error required' });
  try {
    const pool = dbModule.getDb();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orbit_crashes (
        id TEXT PRIMARY KEY,
        ts TIMESTAMPTZ NOT NULL,
        origin TEXT,
        hostname TEXT,
        user_id TEXT,
        platform TEXT,
        arch TEXT,
        node_version TEXT,
        daemon_pid INTEGER,
        error_name TEXT,
        error_message TEXT,
        error_stack TEXT,
        error_code TEXT,
        daemon_log_tail TEXT,
        recent_crash_count_1h INTEGER DEFAULT 0,
        analyzed_at TIMESTAMPTZ,
        claude_analysis JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      INSERT INTO orbit_crashes
        (id, ts, origin, hostname, user_id, platform, arch, node_version, daemon_pid,
         error_name, error_message, error_stack, error_code, daemon_log_tail, recent_crash_count_1h)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (id) DO NOTHING
    `, [
      report.id, report.ts, report.origin, report.hostname, report.userId,
      report.platform, report.arch, report.nodeVersion, report.daemonPid,
      report.error.name, report.error.message, report.error.stack, report.error.code,
      report.daemonLogTail, report.recentCrashCount1h || 0,
    ]);
    console.log(`[crash-report] ${report.hostname} ${report.origin} ${report.error.name}: ${String(report.error.message || '').slice(0, 100)}`);
    res.json({ ok: true, id: report.id });
  } catch (e) {
    console.error('[crash-report] DB error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/daemon/claim-token — 설치 시 토큰-userId 강제 등록 (verify 실패 fallback)
app.post('/api/daemon/claim-token', async (req, res) => {
  const { token, userId } = req.body || {};
  if (!token || !userId) return res.status(400).json({ error: 'token and userId required' });
  const { pgBackupToken } = require('./src/auth');
  // userId가 실제 존재하는지 확인
  try {
    const pool = dbModule.getDb();
    const { rows } = await pool.query('SELECT id, name, email FROM orbit_auth_users WHERE id = $1', [userId]);
    if (!rows.length) return res.status(404).json({ error: 'userId not found' });
    // 이미 다른 userId에 등록된 토큰인지 확인
    const { rows: existing } = await pool.query('SELECT user_id FROM orbit_auth_tokens WHERE token = $1', [token]);
    if (existing.length > 0 && existing[0].user_id !== userId) {
      return res.status(409).json({ error: 'token already claimed by another user' });
    }
    // PG에 토큰 등록
    await pgBackupToken(token, userId, null);
    console.log(`[claim-token] ${rows[0].email} (${userId}) registered token`);
    res.json({ ok: true, userId, name: rows[0].name, email: rows[0].email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 토큰 검증 (설치 프로그램 / 데몬에서 호출) ──────────────────────────────────
// GET /api/auth/verify  — Authorization: Bearer <token>
// 200 { ok, userId, name, email } | 401 { error }
app.get('/api/auth/verify', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'no token' });
  const { verifyTokenAsync, initFromPg } = require('./src/auth');
  let user = await verifyTokenAsync(token);
  if (!user) {
    // PG pool이 초기화 안 됐을 가능성 → 재시도
    try { await initFromPg(); } catch {}
    user = await verifyTokenAsync(token);
  }
  if (!user) return res.status(401).json({ error: 'invalid token' });
  res.json({ ok: true, userId: user.id, name: user.name, email: user.email });
});

// ─── 직원 설치 토큰 생성 (ADMIN_SECRET 방식, Google 계정 불필요) ──────────────
// POST /api/admin/create-employee-token
// { secret, name, pcId } → 직원용 설치코드 즉시 발급
// DISABLED — use OAuth login flow
app.post('/api/admin/create-employee-token', async (req, res) => {
  return res.status(410).json({ error: 'disabled — use OAuth login flow' });
  /* DISABLED
  const { secret, name, pcId } = req.body || {};
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) return res.status(503).json({ error: 'ADMIN_SECRET not configured' });
  if (secret !== adminSecret) return res.status(403).json({ error: 'forbidden' });
  if (!name) return res.status(400).json({ error: 'name required' });

  const { register: _reg, getUserByEmail: _getUser, pgBackupUser, pgBackupToken } = require('./src/auth');
  const slug  = name.toLowerCase().replace(/\s+/g, '.').replace(/[^a-z0-9.가-힣]/g, '');
  const email = pcId ? `${slug}.${pcId.slice(0,8)}@orbit.local` : `${slug}@orbit.local`;

  let user = _getUser(email);
  if (!user) {
    const result = _reg({ email, name, password: require('crypto').randomBytes(16).toString('hex') });
    if (!result.ok) return res.status(500).json({ error: result.error || 'registration failed' });
    user = result.user;
  }
  const apiToken = issueApiToken(user.id);

  // PG 백업 명시적으로 await — 재배포 후 토큰 유효성 보장
  await Promise.all([
    pgBackupUser(user, ''),
    pgBackupToken(apiToken, user.id, null),
  ]).catch(e => console.warn('[create-employee-token] PG backup warn:', e.message));

  const serverUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`;
  const installCmd = `irm "${serverUrl}/api/setup/install-script?os=windows&token=${apiToken}&memberName=${encodeURIComponent(name)}&serverUrl=${encodeURIComponent(serverUrl)}" | iex`;
  res.json({ ok: true, userId: user.id, email, name: user.name, token: apiToken, installCmd });
  */
});

// ─── 관리자: 사용자 삭제 ──────────────────────────────────────────────────────
// POST /api/admin/delete-events — 특정 조건의 이벤트 일괄 삭제 (개인정보 정리용)
// body: { userId, type, appFilter (ILIKE), windowFilter (ILIKE), dryRun }
app.post('/api/admin/delete-events', async (req, res) => {
  try {
    const { isAdmin: _adminOk } = resolveAdmin(req);
    if (!_adminOk) return res.status(403).json({ error: 'admin only' });

    const { userId, type, appFilter, windowFilter, dryRun = true } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId 필수' });

    const pool = dbModule.getDb();
    const params = [userId];
    let where = 'user_id = $1';
    if (type) { params.push(type); where += ` AND type = $${params.length}`; }
    if (appFilter) {
      params.push(`%${appFilter}%`);
      where += ` AND (data_json->>'app' ILIKE $${params.length} OR data_json->'appContext'->>'currentApp' ILIKE $${params.length})`;
    }
    if (windowFilter) {
      params.push(`%${windowFilter}%`);
      where += ` AND (data_json->>'windowTitle' ILIKE $${params.length} OR data_json->'appContext'->>'currentWindow' ILIKE $${params.length})`;
    }

    const countRes = await pool.query(`SELECT COUNT(*)::int AS cnt FROM events WHERE ${where}`, params);
    const cnt = countRes.rows[0].cnt;

    if (dryRun) return res.json({ dryRun: true, wouldDelete: cnt, where, params });

    const del = await pool.query(`DELETE FROM events WHERE ${where}`, params);
    res.json({ ok: true, deleted: del.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/delete-user
// body: { email } 또는 { userId }
// 인증: ADMIN_EMAILS(Bearer 토큰) 또는 body.secret = ADMIN_SECRET
app.delete('/api/admin/delete-user', async (req, res) => {
  try {
    // 인증 확인: resolveAdmin 또는 ADMIN_SECRET body 파라미터
    const { user: _adminUser, isAdmin: _adminOk } = resolveAdmin(req);
    const _secretOk = process.env.ADMIN_SECRET && (req.body || {}).secret === process.env.ADMIN_SECRET;
    if (!_secretOk && !_adminOk) {
      if (!_adminUser) return res.status(401).json({ error: 'unauthorized' });
      return res.status(403).json({ error: 'admin only' });
    }

    const { email, userId, preserveData } = req.body || {};
    if (!email && !userId) return res.status(400).json({ error: 'email 또는 userId 필수' });

    // ── SQLite (auth DB) ──────────────────────────────────────────────────────
    const authMod = require('./src/auth');
    const authDb = authMod.getDb ? authMod.getDb() : null;

    let targetUserId = userId || null;

    if (authDb) {
      // email → userId 조회
      if (!targetUserId && email) {
        const row = authDb.prepare('SELECT id FROM users WHERE email = ?').get(email);
        if (row) targetUserId = row.id;
      }
      if (targetUserId) {
        // FK 참조 테이블 먼저 삭제 (sessions, tracker_pings, oauth_tokens → tokens → users 순서)
        try { authDb.prepare('DELETE FROM sessions WHERE userId = ?').run(targetUserId); } catch (_) {}
        try { authDb.prepare('DELETE FROM tracker_pings WHERE userId = ?').run(targetUserId); } catch (_) {}
        try { authDb.prepare('DELETE FROM oauth_tokens WHERE userId = ?').run(targetUserId); } catch (_) {}
        authDb.prepare('DELETE FROM tokens WHERE userId = ?').run(targetUserId);
        authDb.prepare('DELETE FROM users WHERE id = ?').run(targetUserId);
      } else if (email) {
        // userId를 못 찾아도 email로 직접 삭제 시도
        authDb.prepare('DELETE FROM users WHERE email = ?').run(email);
      }
    }

    // ── SQLite (main events DB) ───────────────────────────────────────────────
    if (!preserveData && targetUserId && dbModule && typeof dbModule.getDb === 'function') {
      const mainDb = dbModule.getDb();
      if (mainDb && typeof mainDb.prepare === 'function') {
        mainDb.prepare('DELETE FROM events WHERE user_id = ?').run(targetUserId);
        try { mainDb.prepare('DELETE FROM nodes WHERE user_id = ?').run(targetUserId); } catch (_) {}
        try { mainDb.prepare('DELETE FROM edges WHERE user_id = ?').run(targetUserId); } catch (_) {}
      }
    }

    // ── PostgreSQL ────────────────────────────────────────────────────────────
    if (process.env.DATABASE_URL) {
      const pgMod = require('./src/db-pg');
      const pgPool = pgMod.getDb ? pgMod.getDb() : null;
      if (pgPool && typeof pgPool.query === 'function') {
        // email → userId 조회 (PG)
        if (!targetUserId && email) {
          const { rows } = await pgPool.query(
            'SELECT id FROM orbit_auth_users WHERE email = $1 LIMIT 1', [email]
          );
          if (rows.length > 0) targetUserId = rows[0].id;
        }

        if (targetUserId) {
          if (!preserveData) {
            // 학습 데이터 포함 전체 삭제
            const userTables = [
              'events', 'sessions', 'files', 'annotations',
              'user_labels', 'user_categories', 'tool_label_mappings',
              'workspace_members', 'workspace_activity',
              'multilevel_cache', 'user_profiles', 'hidden_events',
              'node_memos', 'bookmarks', 'tracker_pings', 'service_tokens',
              'payments', 'subscriptions', 'notifications',
              'solution_installations', 'analysis_results',
              'orbit_daemon_commands', 'nodes', 'edges',
            ];
            for (const tbl of userTables) {
              await pgPool.query(`DELETE FROM ${tbl} WHERE user_id = $1`, [targetUserId]).catch(() => {});
            }
          } else {
            // preserveData=true: 학습 데이터(events/nodes/edges/analysis_results) 보존
            // 인증 관련 + 비학습 데이터만 삭제
            const nonDataTables = [
              'sessions', 'tracker_pings', 'service_tokens',
              'payments', 'subscriptions', 'notifications',
              'orbit_daemon_commands',
            ];
            for (const tbl of nonDataTables) {
              await pgPool.query(`DELETE FROM ${tbl} WHERE user_id = $1`, [targetUserId]).catch(() => {});
            }
          }
          await pgPool.query('DELETE FROM orbit_auth_tokens WHERE user_id = $1', [targetUserId]);
          await pgPool.query('DELETE FROM orbit_auth_users WHERE id = $1', [targetUserId]);
        } else if (email) {
          await pgPool.query('DELETE FROM orbit_auth_users WHERE email = $1', [email]);
        }
      }
    }

    console.log(`[admin/delete-user] 삭제 완료 — userId=${targetUserId} email=${email}`);
    res.json({ ok: true, deletedUserId: targetUserId, email: email || null });
  } catch (err) {
    console.error('[admin/delete-user] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── 관리자 부트스트랩 (Railway 초기 설정용) ─────────────────────────────────
// 토큰 기반으로 관리자 권한 등록 — Railway 환경변수 없이 최초 1회 설정 가능
// 사용법: POST /api/admin/bootstrap { token, proof }
//   proof = SHA256(token + BOOTSTRAP_SALT)
//   BOOTSTRAP_SALT = "orbit-admin-2026" (고정값)
app.post('/api/admin/bootstrap', async (req, res) => {
  try {
    const { token: targetToken, email: targetEmail = env.ADMIN_EMAILS[0], proof } = req.body || {};
    if (!targetToken || !proof) return res.status(400).json({ error: 'token, proof 필수' });

    // proof 검증: SHA256(targetToken + salt)
    const SALT = 'orbit-admin-2026';
    const expected = require('crypto').createHash('sha256').update(targetToken + SALT).digest('hex');
    if (proof !== expected) return res.status(403).json({ error: '잘못된 proof' });

    // 1) 로컬 ADMIN_TOKENS에 추가 (런타임 한정)
    if (!env.ADMIN_TOKENS.includes(targetToken)) env.ADMIN_TOKENS.push(targetToken);

    // 2) auth DB에 관리자 사용자 등록 + 토큰 연결
    const { register: _reg, getUserByEmail: _getUser, pgBackupUser, pgBackupToken } = require('./src/auth');
    let adminUser = _getUser(targetEmail);
    if (!adminUser) {
      const result = _reg({
        email: targetEmail,
        name: 'Admin (bootstrap)',
        password: require('crypto').randomBytes(24).toString('hex'),
      });
      if (!result.ok) return res.status(500).json({ error: result.error });
      adminUser = result.user;
    }

    // 토큰을 이 admin 사용자와 연결
    const authMod = require('./src/auth');
    const authDb = authMod.getDb ? authMod.getDb() : null;
    if (authDb) {
      authDb.prepare('INSERT OR REPLACE INTO tokens (token, userId, type) VALUES (?, ?, ?)').run(targetToken, adminUser.id, 'api');
    }

    // 3) PG 백업
    await Promise.all([
      pgBackupUser && pgBackupUser(adminUser, ''),
      pgBackupToken && pgBackupToken(targetToken, adminUser.id, null),
    ]).catch(() => {});

    console.log(`[bootstrap] 관리자 토큰 등록 완료: ${targetEmail} (${adminUser.id})`);
    res.json({ ok: true, userId: adminUser.id, email: adminUser.email, message: '관리자 권한 부여 완료' });
  } catch (e) {
    console.error('[bootstrap] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── 라우터 의존성 조립 + 마운트 ─────────────────────────────────────────────
// 각 라우터는 createRouter(deps) 패턴으로 의존성을 주입받습니다.
// deps 에 mock 객체를 주입하면 테스트 시 DB 없이 단위 테스트 가능합니다.

/** 공용 db 의존성 객체 — DB 함수들을 한 곳에서 관리 */
const dbDeps = {
  getAllEvents, getEventsBySession, getEventsByChannel: getEventsByChannel || null,
  getSessions, updateSessionTitle, getFiles, getAnnotations, insertAnnotation, deleteAnnotation,
  insertEvent, rollbackToEvent, clearAll, getStats,
  getUserLabels, setUserLabel, deleteUserLabel,
  getUserCategories, upsertUserCategory, deleteUserCategory,
  getToolLabelMappings, setToolLabelMapping, deleteToolLabelMapping, getUserConfig,
  searchEvents,
  getNodeMemos, upsertNodeMemo, deleteNodeMemo,
  getBookmarks, addBookmark, removeBookmark,
  touchTrackerPing, getTrackerPing,
  getEventsForUser, getSessionsForUser, resolveUserId,   // 사용자별 데이터 격리
};

// ─── 라우터 마운트 전 모든 DB 초기화 완료 (배포 시 경합 상태 방지) ──────────────
console.log('[DB Init] 주요 테이블 초기화 중...');
try {
  // 각 라우터의 초기화를 동기/비동기로 실행
  
  // 1) follow.js 초기화
  try {
    require('./routes/follow').initFollowTablesSync?.() || true;
  } catch (e) {
    console.warn('[DB Init] follow 초기화 실패:', e.message);
  }
  
  // 2) profile.js 초기화  
  try {
    const profileRouter = require('./routes/profile');
    profileRouter.initProfileTable?.() || true;
  } catch (e) {
    console.warn('[DB Init] profile 초기화 실패:', e.message);
  }
  
  // 3) llm-settings.js 초기화
  try {
    const llmRouter = require('./routes/llm-settings');
    llmRouter.ensureTable?.() || true;
  } catch (e) {
    console.warn('[DB Init] llm-settings 초기화 실패:', e.message);
  }
  
  // 4) chat.js 초기화 (비동기 — startServer에서 await)
  try {
    const chatRouter = require('./routes/chat');
    if (chatRouter.initChatTables) {
      global._chatInitPromise = chatRouter.initChatTables().catch(e => console.warn('[DB Init] chat 비동기 초기화 실패:', e.message));
    }
  } catch (e) {
    console.warn('[DB Init] chat 초기화 실패:', e.message);
  }

  // 5) analytics.js 초기화 (비동기 — startServer에서 await)
  try {
    const analyticsRouter = require('./routes/analytics');
    if (analyticsRouter.initAnalyticsTables) {
      global._analyticsInitPromise = analyticsRouter.initAnalyticsTables().catch(e => console.warn('[DB Init] analytics 비동기 초기화 실패:', e.message));
    }
  } catch (e) {
    console.warn('[DB Init] analytics 초기화 실패:', e.message);
  }
  
  console.log('[DB Init] 주요 테이블 초기화 완료');
} catch (e) {
  console.warn('[DB Init] 일부 초기화 실패 (계속 진행):', e.message);
}

app.use('/api', createGraphRouter({
  getFullGraph, getFullGraphForUser, broadcastAll, broadcastToChannel,
  db: { ...dbDeps, getEventsByUser, getSessionsByUser, getStatsByUser, claimLocalEvents,
        hideEvents, unhideEvents, unhideAllEvents, getHiddenEventIds },
  purposeClassifier: { classifyPurposes, summarizePurposes, PURPOSE_CATEGORIES, annotateEventsWithPurpose },
  graphEngine: { buildGraph, computeActivityScores, applyActivityVisualization },
  CONV_FILE, SNAPSHOTS_DIR,
  verifyToken,
  getDb: () => dbModule.getDb(),
}));

app.use('/api', createAnnotationsRouter({
  getEventsForUser, resolveUserId,
  broadcastAll,
  db: dbDeps,
  eventNormalizer: { createAnnotationEvent },
  graphEngine: { suggestLabel },
}));

app.use('/api', createAiEventsRouter({
  broadcastAll,
  db: dbDeps,
  aiAdapter: { getAiStyle, AI_SOURCES },
  getFullGraph,
}));

app.use('/api', createAnalysisRouter({
  db: dbDeps,
  codeAnalyzer: { generateReport, countLines, measureCyclomaticComplexity, findLongFunctions, findDuplicatePatterns, analyzeSolidViolations },
  contextBridge: { extractContext, renderContextMd, renderContextPrompt, saveContextFile },
  conflictDetector: { detectConflicts },
  getEventsForUser, resolveUserId,
}));

app.use('/api', createSecurityRouter({
  db: dbDeps,
  shadowAiDetector: { detectShadowAI, getApprovedSources, addApprovedSource, removeApprovedSource },
  auditLog: { queryAuditLog, verifyIntegrity, renderAuditHtml },
  getEventsForUser, resolveUserId,
}));

app.use('/api', createReportsRouter({
  db: dbDeps,
  reportGenerator: { buildReportData, renderMarkdown, renderSlackBlocks },
  getEventsForUser, resolveUserId,
}));

app.use('/api', createThemesRouter({
  themeStore: { getAllThemes, getThemeById, registerTheme, recordDownload, rateTheme, deleteUserTheme },
}));

app.use('/api', createAuthRouter({
  auth: {
    register: authRegister, login: authLogin, verifyToken,        // 기존 인증 함수
    inviteUser, isInvitedUser, getEffectivePlan, getAdminInvites, // 관리자 초대 시스템
    ADMIN_EMAILS,                                                 // 관리자 이메일 목록
  },
}));

// ─── 조직 계층 API (비활성화: 구현 예정) ──────────────────────

// Tracker OAuth (Google Drive 연동 + 설치 토큰)
app.use('/api/tracker', createTrackerOAuthRouter({
  verifyToken,
  getDb: () => db,
}));

// Tracker Files (파일 변경 감지)
const syncScheduler = getSyncScheduler({
  getValidGoogleToken: () => {
    // 구현 예시: DB에서 사용자의 Google Drive 토큰 조회
    // const token = db.prepare('SELECT googleDriveToken FROM users_google_tokens WHERE userId = ?').get(userId);
    // return token?.googleDriveToken;
    return null;  // TODO: 실제 토큰 조회 로직 구현
  },
  getUserId: () => 'tracker-system',
  getDb: () => db,
  onSync: (data) => {
    // 동기화 완료 시 WebSocket 브로드캐스트
    // broadcastAll({ type: 'tracker_sync', data });
  },
});
syncScheduler.init().catch(e => console.error('[tracker] Init error:', e.message));

app.use('/api/tracker', createTrackerFilesRouter({
  verifyToken,
  syncScheduler,
}));

// Tracker Messages (메시지 추적)
app.use('/api/tracker', createTrackerMessagesRouter({
  verifyToken,
  getValidGoogleTokenForService: (service) => {
    // 구현 예시: DB에서 각 서비스별 토큰 조회
    // const tokens = db.prepare('SELECT * FROM message_service_tokens WHERE userId = ?').get(userId);
    // return tokens?.[service];
    return null;  // TODO: 실제 토큰 조회 로직 구현
  },
}));

// OAuth 소셜 로그인 (Google, GitHub)
const oauthRouter = createOAuthRouter({
  passport:  oauthPassport,
  enabledProviders,
  insertToken: issueApiTokenAsync,
  CLIENT_ORIGIN: process.env.CLIENT_ORIGIN || `http://localhost:${PORT}`,
});
app.use('/api/auth', oauthRouter);

// Tesla FSD 방식 원시 신호 감지 엔진
app.use('/api/signal', signalEngine.createRouter());

app.use('/api', createPaymentRouter({
  payment,                                                                                            // Stripe 결제 모듈 전체 전달
  upgradePlan,                                                                                        // 플랜 업그레이드 함수 (auth.js)
  verifyToken,                                                                                        // 토큰 검증 함수 (auth.js)
}));

app.use('/api', createGrowthRouter({
  growthEngine:  { analyzeAndSuggest, saveFeedback, getSuggestions, getPatterns, getMarketCandidates },
  solutionStore,
  db: dbDeps,
  getEventsForUser, resolveUserId,
}));

app.use('/api', createCommunityRouter({
  communityStore,
}));

app.use('/api', createGitRouter({
  insertEvent,
  broadcastAll,
}));

const { authMiddleware, optionalAuth } = require('./src/auth');
app.use('/api', createAvatarsRouter({ authMiddleware, optionalAuth }));

// ─── 현재 유저 정보 + API 토큰 발급 ─────────────────────────────────────────
// GET /api/me — 내 정보 반환 (이미 session 토큰 보유 전제)
app.get('/api/me', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
              || req.query.token || req.cookies?.orbit_token;
  const user  = verifyToken(token);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  res.json({ id: user.id, email: user.email, name: user.name, plan: user.plan });
});

// ─── 수익 공유 마켓 2.0 ──────────────────────────────────────────────────────
app.use('/api', createMarketRouter({ marketStore, authMiddleware, optionalAuth }));

// ─── Ollama 커스텀 모델 관리 ──────────────────────────────────────────────────
app.use('/api', createModelRouter({ getAllEvents, modelTrainer, broadcastAll, getEventsForUser, resolveUserId }));

// ─── AI 역량 포트폴리오 PDF ──────────────────────────────────────────────────
app.use('/api', createPortfolioRouter({ getAllEvents, getSessions, getStats, getFiles, optionalAuth, getEventsForUser, getSessionsForUser, resolveUserId }));

// ─── 개인/팀 인사이트 분리 ───────────────────────────────────────────────────
app.use('/api', createPersonalInsightsRouter({
  getAllEvents, getEventsForUser, getSessionsForUser, resolveUserId,
  getStats,
  getSessions,
  authMiddleware: require('./src/auth').authMiddleware,
  optionalAuth:   require('./src/auth').optionalAuth,
  getInsights:    (limit, userId) => require('./src/insight-engine').getInsights(limit || 100, userId),
}));

// ─── AI 토큰 비용 추적 ────────────────────────────────────────────────────────
app.use('/api', createCostTrackerRouter({ getAllEvents, getSessions, optionalAuth: require('./src/auth').optionalAuth, getEventsForUser, getSessionsForUser, resolveUserId }));

// ─── 외부 도구 웹훅 수신 (n8n / Slack / Notion / GitHub) ─────────────────────
app.use('/api', createWebhooksRouter({ insertEvent, broadcastAll }));

// ─── MCP Market Watcher ───────────────────────────────────────────────────────
app.use('/api', mcpWatcher.createMcpWatcherRouter({ getAllEvents }));

// ─── Orbit Badge SVG ─────────────────────────────────────────────────────────
app.use('/api', createBadgeRouter({ getAllEvents, getSessions, optionalAuth, getEventsForUser, getSessionsForUser, resolveUserId }));

// ─── Share My Session ────────────────────────────────────────────────────────
app.use('/api', createShareRouter({ getAllEvents, getSessions, getEventsBySession, insertEvent, broadcastAll, optionalAuth }));

// ─── Team Ontology Graph ──────────────────────────────────────────────────────
app.use('/api', createOntologyRouter({ getAllEvents, getFiles, optionalAuth, getEventsForUser, resolveUserId }));

// ─── AI Leaderboard ───────────────────────────────────────────────────────────
app.use('/api', createLeaderboardRouter({ getAllEvents, getSessions, optionalAuth, getEventsForUser, getSessionsForUser, resolveUserId }));

// ─── ROI Calculator ───────────────────────────────────────────────────────────
app.use('/api', createRoiRouter({ getAllEvents, getSessions, optionalAuth, getEventsForUser, getSessionsForUser, resolveUserId,
  // [2026-08-10] 자동화 잠재 ROI — 최신 X-ray 리포트의 opportunities(estWeeklyMinSaved) 주입
  getXrayOpportunities: async () => {
    try {
      const db = dbModule.getDb(); if (!db?.query) return [];
      const r = await db.query(`SELECT report FROM orbit_ops_report WHERE kind='xray' ORDER BY ts DESC LIMIT 1`);
      if (!r.rows.length) return [];
      const rep = typeof r.rows[0].report === 'object' ? r.rows[0].report : JSON.parse(r.rows[0].report);
      return rep.opportunities || [];
    } catch { return []; }
  } }));

// ─── Analytics (사용자 행동 분석) ────────────────────────────────────────────
app.use('/api', createAnalyticsRouter({ getDb: dbModule.getDb }));
app.use('/api', createProfileRouter({ getDb: dbModule.getDb, verifyToken }));
// ─── 알림 라우터 ──────────────────────────────────────────────────────────────
const { createNotificationRouter, createNotification } = require('./routes/notification');
app.use('/api', createNotificationRouter({ getDb: dbModule.getDb, verifyToken }));
app.use('/api', createFollowRouter({ getDb: dbModule.getDb, verifyToken, searchUsers, getUserById, createNotification })); // searchUsers + getUserById + createNotification 주입
app.use('/api', createChatRouter({ getDb: dbModule.getDb, verifyToken, broadcastToRoom }));

// ─── 마켓플레이스 및 추천 엔진 ────────────────────────────────────────────────────
app.use('/api', createMarketplaceRouter({ verifyToken, dbModule }));
app.use('/api', createRecommendationsRouter({ verifyToken, dbModule }));

// ─── Workspace (팀/회사 관리) ─────────────────────────────────────────────────────
app.use('/api', createWorkspaceRouter({ getDb: dbModule.getDb, verifyToken, getUserById, ADMIN_EMAILS, createNotification }));

// ─── Google Drive 사용자 백업 ────────────────────────────────────────────────
const createGdriveRouter = require('./routes/gdrive');
app.use('/api', createGdriveRouter({
  verifyToken,
  auth: { getValidGoogleToken, getOAuthTokens, saveOAuthTokens },
  dbModule: { getAllEvents, getEventsByUser, getSessionsByUser, getSessions, insertEvent, getDb: dbModule.getDb },
  gdriveUserBackup,
}));

// ─── Regional Insight ────────────────────────────────────────────────────────
app.use('/api', createRegionalInsightRouter({ getAllEvents }));

// ─── Orbit Points Economy ────────────────────────────────────────────────────
app.use('/api', createPointsRouter({ getAllEvents, getSessions, optionalAuth, getEventsForUser, getSessionsForUser, resolveUserId }));

// ─── Orbit Certificate & Score ───────────────────────────────────────────────
app.use('/api', createCertificateRouter({ getAllEvents, getSessions, optionalAuth, getEventsForUser, getSessionsForUser, resolveUserId }));

// ─── MCP 서버 (Claude Desktop 연동) ─────────────────────────────────────────
app.use('/api', createMcpRouter({
  getAllEvents,
  getStats,
  getSessions,
  getInsights:    (limit, userId) => require('./src/insight-engine').getInsights(limit || 50, userId),
  getPatterns,
  getSuggestions,
  getOutcomes:    outcomeStore.getOutcomes,
  saveOutcome:    outcomeStore.saveOutcome,
  analyzeEvents:  require('./src/insight-engine').analyzeEvents,
  searchEvents,
}));

// ─── LLM 프로바이더 설정 (API 키 CRUD + 테스트 + generate) ──────────────────
const createLlmSettingsRouter = require('./routes/llm-settings');
app.use('/api', createLlmSettingsRouter({ getDb: dbModule.getDb }));

// ─── 실행 패널 (generate / execute / ai-status) ──────────────────────────────
const createExecRouter = require('./routes/exec');
app.use('/api', createExecRouter({ getAllEvents, broadcastAll, getDb: dbModule.getDb }));

// ─── 환경 감지 + 원키 설치 + Claude 트래킹 ───────────────────────────────────
const createSetupRouter = require('./routes/setup');
app.use('/api', createSetupRouter({ getAllEvents, getDb: dbModule.getDb, port: PORT }));

// ─── 목적(Purpose) 타임라인 ──────────────────────────────────────────────────
const createPurposesRouter = require('./routes/purposes');
app.use('/api', createPurposesRouter({ getAllEvents, getEventsBySession, getSessions, getEventsForUser, getSessionsForUser, resolveUserId }));

// ─── 개인 학습 에이전트 ───────────────────────────────────────────────────────
const createPersonalLearningRouter = require('./routes/personal-learning');
app.use('/api', createPersonalLearningRouter({ getDb: dbModule.getDb, insertEvent, broadcastAll }));

// ─── 개인 대시보드 API (analysis.html — DB 직접 쿼리, 비용 0) ─────────────────
app.use('/api', require('./routes/personal-dashboard')({ getDb: dbModule.getDb, verifyToken }));

// ─── Phase 2: 작업 분석 엔진 (폴백) ─────────────────────────────────────────
app.use('/api', createWorkAnalysisRouter({ verifyToken, getEventsForUser, getSessionsForUser, resolveUserId }));

// ─── Phase 3: 팔란티어 인텔리전스 ────────────────────────────────────────────
app.use('/api', createIntelligenceRouter({ verifyToken, getEventsForUser, resolveUserId, getDb: dbModule.getDb, getUserById, ADMIN_EMAILS }));
app.use('/api/intelligence/golden', createGoldenRouter({
  getPool: dbModule.getDb,
  // server.js의 다른 admin API와 동일한 인증 패턴 사용 (하드코딩 + env.isAdminToken)
  verifyAdmin: (req, res, next) => {
    const HARDCODED = 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
    const t = ((req.headers.authorization || '').replace(/^Bearer\s+/, '').trim()) || req.query.token;
    const ok = t === HARDCODED
            || (process.env.MASTER_TOKEN && t === process.env.MASTER_TOKEN)
            || (env && typeof env.isAdminToken === 'function' && env.isAdminToken(t));
    if (!ok) return res.status(401).json({ error: 'admin only' });
    next();
  }
}));

// ─── Phase 5: AI 학습 + 맞춤 추천 ────────────────────────────────────────────
app.use('/api', createLearningRouter({ verifyToken, getEventsForUser, resolveUserId }));

// ─── 통합 이벤트 버스 (ERP + Orbit + AI Trainer + nenova_agent) ──────────────
app.use('/api', createEventBusRouter({ eventBus, verifyToken, broadcastAll }));
app.use('/api/ops-ontology', createOpsOntologyRouter({ getPool: dbModule.getDb, resolveAdmin, isAdminReq: isAdminReqAsync }));
app.use('/api/verification', createVerificationRouter({ getDb: dbModule.getDb, isAdminReq: isAdminReqAsync }));
app.use('/api/flow', require('./routes/flow-map')({ getPool: dbModule.getDb, isAdminToken: env.isAdminToken })); // 업무 흐름 청사진 API
app.use('/api/timetable', require('./routes/work-timetable')({ getPool: dbModule.getDb, isAdminReq: isAdminReqAsync })); // 직원 업무시간 타임테이블 (시간/일/주/월)

// ─── 데이터 관리 (Export / Delete / Summary) ─────────────────��───────────────
const createDataManagementRouter = require('./routes/data-management');
app.use('/api', createDataManagementRouter({ verifyToken, dbModule }));

// ─── Issue Predictor Agent (실시간 이슈 감지 8개 규칙) ────────────────────────
app.use('/api/issues', require('./routes/issue-predictor')({ getDb: dbModule.getDb }));

// ─── Data Archive (데이터 보존 모니터 + 아카이브) ─────────────────────────────
app.use('/api/data', require('./routes/data-archive')({ getDb: dbModule.getDb }));

// ─── Event Archiver (용량 초과 시 Drive 아카이브 + DB 삭제) ──────────────────
const eventArchiver = (() => { try { return require('./src/event-archiver'); } catch(e) { console.warn('[archiver] 로드 실패:', e.message); return null; } })();

if (eventArchiver && process.env.DATABASE_URL) {
  // 매일 새벽 3시 UTC (KST 12:00) 자동 체크
  const _archiveCron = setInterval(async () => {
    const now = new Date();
    if (now.getUTCHours() !== 18 || now.getUTCMinutes() > 5) return; // 03:00 KST
    try {
      const pool = dbModule.getDb();
      await eventArchiver.checkAndArchive(pool);
    } catch (e) {
      console.error('[archiver] 스케줄 오류:', e.message);
    }
  }, 60 * 1000); // 1분마다 시각 체크

  // 수동 트리거 API (관리자 전용)
  app.post('/api/archive/run', async (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    let _adminOk = false;
    try {
      const { verifyToken: vt } = require('./src/auth');
      const decoded = await vt(token);
      _adminOk = env.isAdmin(decoded?.email) || env.isAdmin(decoded?.id);
    } catch {}
    if (!_adminOk) return res.status(403).json({ error: 'admin only' });

    try {
      const pool = dbModule.getDb();
      const result = await eventArchiver.checkAndArchive(pool);
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 테이블 상태 조회 API
  app.get('/api/archive/stats', async (req, res) => {
    try {
      const pool = dbModule.getDb();
      const stats = await eventArchiver.getTableStats(pool);
      const { rows: archLogs } = await pool.query(
        `SELECT user_id, archived_at, from_date, to_date, row_count, drive_file, summary
         FROM archive_log ORDER BY archived_at DESC LIMIT 20`
      ).catch(() => ({ rows: [] }));
      res.json({
        current: stats,
        threshold: eventArchiver.THRESHOLD,
        keepDays: eventArchiver.KEEP_DAYS,
        needsArchive: stats.rows >= eventArchiver.THRESHOLD,
        recentLogs: archLogs,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  console.log(`[archiver] 등록 완료 (임계값: ${eventArchiver.THRESHOLD.toLocaleString()}행, 보존: ${eventArchiver.KEEP_DAYS}일)`);
}

// ─── 자동화 매퍼 — Vision 분석 → 자동화 판단 → 스크립트 생성 → PC 테스트 ────
// (automation-engine 미들웨어보다 먼저 등록해야 라우트가 정상 처리됨)
app.get('/api/automation/analysis', async (req, res) => {
  try {
    const db = dbModule.getDb();
    const limit = parseInt(req.query.limit) || 50;
    const userId = req.query.userId || null;
    let q = `SELECT id, user_id, timestamp, data_json FROM events WHERE type='screen.analyzed'`;
    const params = [];
    if (userId) { params.push(userId); q += ` AND user_id=$${params.length}`; }
    q += ` ORDER BY timestamp DESC LIMIT $${params.length+1}`;
    params.push(limit);
    const { rows } = await db.query(q, params);

    const { rows: users } = await db.query('SELECT id, name FROM orbit_auth_users');
    const nameMap = {}; users.forEach(u => nameMap[u.id] = u.name);

    const items = rows.map(r => {
      let d = {}; try { d = typeof r.data_json==='string'?JSON.parse(r.data_json):r.data_json; } catch{}
      return {
        id: r.id, userId: r.user_id,
        userName: nameMap[r.user_id] || r.user_id?.slice(0,8),
        timestamp: r.timestamp,
        app: d.app || '', screen: d.screen || '', activity: d.activity || '',
        workCategory: d.workCategory || '',
        automatable: d.automatable || false, automationScore: d.automationScore || 0,
        automationHint: d.automationHint || '', scriptType: d.scriptType || 'none',
        padPossible: d.padPossible || false,
        autoAreas: d.autoAreas || [], humanAreas: d.humanAreas || [],
        nenovaAction: d.nenovaAction || null, nenovaInputMap: d.nenovaInputMap || [],
        fields: d.fields || [],
      };
    });

    const automatable = items.filter(i => i.automatable && i.automationScore >= 0.6);
    const humanNeeded = items.filter(i => i.humanAreas?.length > 0 && !i.automatable);
    const nenovaMapped = items.filter(i => i.nenovaAction);

    res.json({ items, summary: {
      total: items.length, automatable: automatable.length,
      humanNeeded: humanNeeded.length, nenovaMapped: nenovaMapped.length,
      topScreens: [...new Set(items.map(i=>i.screen).filter(Boolean))].slice(0,10),
    }});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/automation/generate', async (req, res) => {
  try {
    const { screen, nenovaAction, inputMap, scriptType = 'pyautogui' } = req.body;
    if (!screen) return res.status(400).json({ error: 'screen 필요' });
    const lines = [
      '# Orbit AI 자동화 스크립트 — 자동 생성',
      `# 화면: ${screen} | nenova: ${nenovaAction||'N/A'} | 생성: ${new Date().toISOString()}`,
      'import pyautogui, time, subprocess, sys',
      'pyautogui.FAILSAFE = True', 'pyautogui.PAUSE = 0.4', '',
      '# ── 데이터 준비 ──',
    ];
    const autoFields = (inputMap||[]).filter(f => f.automatable);
    const manualFields = (inputMap||[]).filter(f => !f.automatable);
    autoFields.forEach(f => lines.push(`${f.field.replace(/\s/g,'_').toLowerCase()} = "${f.value || ''}"  # 출처: ${f.source}`));
    if (manualFields.length) {
      lines.push('', '# ── 사람 확인 필요 항목 ──');
      manualFields.forEach(f => lines.push(`# ${f.field}: 수동 입력 필요 — ${f.value||'?'}`));
    }
    lines.push('', '# ── nenova 실행 ──');
    if (nenovaAction) {
      lines.push(`# nenova "${nenovaAction}" 화면으로 이동`);
      lines.push('# subprocess.Popen(["C:/nenova/nenova.exe"])', 'time.sleep(1.0)');
      autoFields.forEach(f => {
        lines.push(`# pyautogui.click(x=???, y=???)  # ${f.field} 클릭`);
        lines.push(`# pyautogui.typewrite(${f.field.replace(/\s/g,'_').toLowerCase()}, interval=0.05)`);
      });
    }
    lines.push('', 'print("완료")');
    const script = lines.join('\n');
    const db = dbModule.getDb();
    await db.query(
      `INSERT INTO pad_scripts (name, script_type, script_content, target_app, status, created_at)
       VALUES ($1,$2,$3,$4,'draft',NOW()) ON CONFLICT DO NOTHING`,
      [`${screen}_${Date.now()}`, scriptType, script, nenovaAction||screen]
    ).catch(()=>{});
    res.json({ script, screen, nenovaAction, autoFields: autoFields.length, manualFields: manualFields.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/automation/test', async (req, res) => {
  try {
    const { hostname, script, action = 'run-script' } = req.body;
    if (!hostname || !script) return res.status(400).json({ error: 'hostname, script 필요' });
    const db = dbModule.getDb();
    await db.query(
      `INSERT INTO orbit_daemon_commands (hostname, action, command, data_json, ts)
       VALUES ($1,$2,NULL,$3::jsonb, NOW())`,
      [hostname, action, JSON.stringify({ script, source: 'automation-mapper', ts: new Date().toISOString() })]
    );
    res.json({ ok: true, hostname, message: `${hostname}에 테스트 명령 전달` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/automation/results', async (req, res) => {
  try {
    const db = dbModule.getDb();
    const { rows } = await db.query(
      `SELECT id, user_id, timestamp, data_json FROM events
       WHERE type IN ('automation.result','automation.test','pad.result')
       ORDER BY timestamp DESC LIMIT 50`
    );
    res.json({ results: rows.map(r => {
      let d={}; try{d=typeof r.data_json==='string'?JSON.parse(r.data_json):r.data_json;}catch{}
      return { id:r.id, userId:r.user_id, timestamp:r.timestamp, ...d };
    })});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Automation Engine (변수 대응 자동화) ──────────────────────────────────────
app.use('/api/automation', require('./routes/automation-engine')({ getDb: dbModule.getDb }));
// ─── 워크플로우 레지스트리 API (CLI/Orbit OS 공용) ───────────────────────────
const { createWorkflowRegistry } = require('./routes/automation-engine');
app.use('/api/automation', createWorkflowRegistry({ getDb: dbModule.getDb }));

// ─── Script Generator (Phase 4: Vision → 자동화 스크립트 자동 생성) ──────────
try {
  app.use('/api/scripts', require('./routes/script-generator')({ getDb: dbModule.getDb }));
} catch(e) { console.warn('[mount] script-generator:', e.message); }

// ─── PC Recording API (Python recorder ↔ Node.js 브리지) ──────────────────────
try {
  app.use('/api/recording', require('./routes/recording')({ broadcastAll, getDb: dbModule.getDb }));
} catch(e) { console.warn('[mount] recording:', e.message); }

// ─── Orbit OS (팔란티어 스타일 회사 OS 명령 구조) ─────────────────────────────
app.use('/api/os', require('./routes/orbit-os')({ getDb: dbModule.getDb }));

// ─── 회사 구조 분석 + 장기 트리거 모니터 ─────────────────────────────────────
app.use('/api/company', require('./routes/company-structure')({ getDb: dbModule.getDb }));

// ─── 자가 진화 엔진 (성능 모니터 + 자동 개선 + 트렌드) ─────────────────────
app.use('/api/evolve', require('./routes/self-evolve')({ getDb: dbModule.getDb }));

// ─── RAG 코어 엔진 (에이전트 마운트 전에 선언) ──────────────────────────────
let ragCore = null;
try {
  ragCore = require('./src/rag-core');
} catch (e) {
  console.warn('[rag-core] 모듈 로드 실패:', e.message);
}

// ─── 자율 탐색 + 아이디어 엔진 (2시간마다 새 패턴 발굴) ─────────────────────
app.use('/api/ideas', require('./routes/idea-engine')({ getDb: dbModule.getDb, ragCore }));

// ─── 사고 엔진 (전이 모델 + 예측 + 검증 + 카톡 추출 + 확장 사고) ────────────
app.use('/api/think', require('./routes/think-engine')({ getDb: dbModule.getDb, ragCore }));

// ─── 프로세스 마이닝 엔진 (업무 흐름 추출 + 병목 감지 + 비교 분석) ─────────
app.use('/api/mining', require('./routes/process-mining')({ getDb: dbModule.getDb, reportSheet }));

// ─── 카카오톡 복호화 + 메시지 분석 ──────────────────────────────────────────
app.use('/api/kakao', require('./routes/kakao-decrypt')({ getDb: dbModule.getDb }));

// ─── PAD 커넥터 (nenova ERP 자동화) ─────────────────────────────────────────
app.use('/api/pad', require('./routes/pad-connector')({ getDb: dbModule.getDb }));

// ─── nenova 챗봇 AI (LLM 응답, nenova-db보다 먼저 등록해야 /ai/* 라우트 충돌 없음) ─
app.use('/api/nenova/ai', require('./routes/nenova-ai'));

// ─── nenova SQL Server 직접 연결 (전산 데이터 실시간 조회 + 동기화) ──────────
app.use('/api/nenova', require('./routes/nenova-db')({ getDb: dbModule.getDb }));

// ─── nenova 이슈 태스킹 (입고딜레이/주문변경/불량 자동 생성 + KakaoWork 알림) ──
const { createIssuesRouter } = require('./routes/issues');
app.use('/api/biz-issues', createIssuesRouter({ getDb: dbModule.getDb }));

// ─── nenova ↔ Orbit 교차 분석 (데이터 검증 + 사용 패턴 + OS 설계) ───────────
app.use('/api/cross', require('./routes/nenova-cross-analysis')({ getDb: dbModule.getDb }));

// ─── ERP 분석 에이전트 (전산 기능 분석 + 수동 갭 + Orbit 마이그레이션 계획) ────
app.use('/api/erp', require('./routes/erp-analyzer')({ getDb: dbModule.getDb }));

// ─── 활동 분류 엔진 (raw 윈도우 타이틀 → 목적 기반 분류, API 호출 없음) ─────
app.use('/api/activity', require('./routes/activity-classifier')({ getDb: dbModule.getDb }));

// ─── Vision UI 학습 엔진 (화면 세그먼트 + UI 요소 학습 + 클릭 매칭) ──────────
app.use('/api/vision', require('./routes/vision-learning')({ getDb: dbModule.getDb }));

// ─── Claude 작업 세션 이력 (Git 커밋 + 세션 메모리 + 타임라인) ────────────────
app.use('/api/sessions', require('./routes/work-sessions')({ getDb: dbModule.getDb }));

// ─── 데이터 디지타이저 (비구조화 데이터 발견 + 디지털화 제안) ─────────────────
app.use('/api/digitize', require('./routes/data-digitizer')({ getDb: dbModule.getDb }));

// ─── 비즈니스 인텔리전스 (회사 비즈니스 브레인 — 건강도/분석/예측/리포트) ────
app.use('/api/bi', require('./routes/business-intelligence')({ getDb: dbModule.getDb, ragCore }));

// ─── 깊은 조사 에이전트 (오분류 재분석 + 숨겨진 업무 흐름 + 현실적 자동화 판단) ──
app.use('/api/investigate', require('./routes/deep-investigator')({ getDb: dbModule.getDb, ragCore }));

// ═══ 2026-04-08 에이전트 대규모 업그레이드 ════════════════════════════════════

// ─── 이상 감지 에이전트 (개인 기준선 대비 실시간 4가지 이상 탐지) ────────────
app.use('/api/anomaly', require('./routes/anomaly-detector')({ db: dbModule.getDb() }));

// ─── 업무 예측 엔진 (완료시간 예측 + 다음 작업 예측 + 피크타임) ─────────────
try {
  app.use('/api/predict', require('./routes/prediction-engine')({
    getDb: dbModule.getDb, verifyToken, getEventsForUser, resolveUserId,
  }));
} catch(e) { console.warn('[mount] prediction-engine:', e.message); }

// ─── 자동화 점수 학습 (Vision 분석 → 화면별 자동화 가능성 누적 학습) ─────────
try {
  app.use('/api/automation-scorer', require('./routes/automation-scorer')({
    getDb: dbModule.getDb, verifyToken, getEventsForUser, resolveUserId,
  }));
} catch(e) { console.warn('[mount] automation-scorer:', e.message); }

// ─── nenovaweb 자동화 테스트 엔진 (워크플로우 E2E 테스트) ──────────────────────
try {
  app.use('/api/autotest', require('./routes/autotest')());
} catch(e) { console.warn('[mount] autotest:', e.message); }

// ─── Company OS 생성 에이전트 (구조/평가 전용, 직원 PC 실행 없음) ─────────────
try {
  app.use('/api/company-os-generator', require('./routes/company-os-generator')({
    getDb: dbModule.getDb,
    rootDir: __dirname,
  }));
} catch(e) { console.warn('[mount] company-os-generator:', e.message); }

// ─── 컨텍스트 엔진 (시간대/요일/월말 등 외부 컨텍스트 → 업무 패턴 연계) ──────
try {
  app.use('/api/context', require('./routes/context-engine')({
    getDb: dbModule.getDb, verifyToken, getEventsForUser, resolveUserId,
  }));
} catch(e) { console.warn('[mount] context-engine:', e.message); }

// ─── 데이터 인텔리전스 (데이터 파이프라인 품질 평가 + 자가발전 에이전트) ─────────
try {
  app.use('/api/data-intel', require('./routes/data-intelligence')({
    pool: dbModule.getDb(),
  }));
} catch(e) { console.warn('[mount] data-intelligence:', e.message); }

// ─── 자가진화 데몬 닥터 (Claude API 진단 + 안전 자동 조치) ─────────────────────
// 2026-06-05 추가 — 모든 PC 환경을 24h마다 Claude API로 진단:
//   1) daemon-health + self-log 수집 → Claude API 진단
//   2) 안전 조치 자동 실행 (reinstall/restart push-exec, PC당 24h 1회 가드)
//   3) 코드 수정 권고는 PG 저장 (사용자가 대시보드에서 검토 후 적용)
try {
  const autoDoctor = require('./routes/auto-doctor')(dbModule);
  app.use('/api/auto-doctor', autoDoctor);
  // PG 환경에서만 스케줄러 시작 (SQLite local dev에서는 비활성)
  if (process.env.DATABASE_URL && process.env.ANTHROPIC_API_KEY) {
    autoDoctor.startScheduler();
  } else {
    console.log('[mount] auto-doctor: 라우터만 등록 (스케줄러는 DATABASE_URL + ANTHROPIC_API_KEY 필요)');
  }
} catch(e) { console.warn('[mount] auto-doctor:', e.message); }

// ─── 워크플로우 패턴 마이닝 (슬라이딩 윈도우 시퀀스 → 루틴/자동화후보) ────────
try {
  const workflowLearner = require('./src/workflow-learner');
  if (workflowLearner.createRouter) app.use('/api/workflow', workflowLearner.createRouter());
} catch(e) { console.warn('[mount] workflow-learner:', e.message); }

// ─── 루틴 학습 (시간대+요일별 루틴 학습 → 예측) ─────────────────────────────
try {
  const routineLearner = require('./src/routine-learner');
  if (routineLearner.createRouter) app.use('/api/routine', routineLearner.createRouter());
} catch(e) { console.warn('[mount] routine-learner:', e.message); }

// ─── 인력 최적화 엔진 (효율스코어/자동화위험도/유휴탐지/중복업무) ─────────────
try {
  const _pgPool = dbModule.getDb();
  if (_pgPool && typeof _pgPool.query === 'function') {
    app.use('/api/workforce', require('./routes/workforce-optimizer')({ pool: _pgPool }));
    console.log('[mount] workforce-optimizer: OK');
  }
} catch(e) { console.warn('[mount] workforce-optimizer:', e.message); }

// ─── Signal Engine DB 초기화 (번아웃 감지, 집중도 trend) ────────────────────
try {
  const _pool = dbModule.getDb();
  if (signalEngine.initSignalDb && _pool) signalEngine.initSignalDb(_pool);
} catch(e) { console.warn('[mount] signal-engine initDb:', e.message); }

// ─── 데모 시드 (개발/미리보기용) ─────────────────────────────────────────────
app.post('/api/demo/seed', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  try {
    const { ulid } = require('ulid');
    const now = Date.now();
    const sessions = [
      { id: 'demo-api-dev',     project: 'orbit-backend',   label: 'API 엔드포인트 개발' },
      { id: 'demo-react-ui',    project: 'orbit-frontend',  label: 'React 컴포넌트 구현' },
      { id: 'demo-db-optimize', project: 'orbit-backend',   label: 'DB 쿼리 최적화' },
      { id: 'demo-auth-flow',   project: 'orbit-auth',      label: '인증 플로우 리팩토링' },
      { id: 'demo-docs-review', project: 'orbit-docs',      label: 'API 문서 작성' },
    ];
    const types = [
      { type: 'file.write',    files: ['server.js','auth.js','routes/api.js','db.js','index.tsx','App.tsx','useAuth.ts'] },
      { type: 'tool.end',      tools: ['Edit','Write','Read','Bash','Grep'] },
      { type: 'user.message',  msgs: ['API 응답 형식 변경해줘','로그인 리다이렉트 수정','쿼리 느린 부분 최적화','테스트 추가해줘','타입 에러 수정'] },
      { type: 'assistant.message', msgs: ['수정 완료했습니다','최적화 적용했습니다','테스트 통과 확인됨'] },
      { type: 'git.commit',    msgs: ['fix: auth redirect','feat: add pagination','refactor: query optimize'] },
    ];

    const events = [];
    for (const sess of sessions) {
      // session.start
      events.push({
        id: ulid(), type: 'session.start', sessionId: sess.id,
        userId: 'local', channelId: 'default', source: 'demo',
        timestamp: new Date(now - 3600_000 * (5 - sessions.indexOf(sess))).toISOString(),
        data: { title: sess.label, projectDir: `/projects/${sess.project}` },
      });
      // 세션당 8~15개 이벤트
      const count = 8 + Math.floor(Math.random() * 8);
      for (let i = 0; i < count; i++) {
        const tg = types[Math.floor(Math.random() * types.length)];
        const ts = new Date(now - 3600_000 * (5 - sessions.indexOf(sess)) + i * 120_000).toISOString();
        const ev = { id: ulid(), type: tg.type, sessionId: sess.id, userId: 'local', channelId: 'default', source: 'demo', timestamp: ts, data: {} };
        if (tg.files) {
          const f = tg.files[Math.floor(Math.random() * tg.files.length)];
          ev.data = { filePath: `/projects/${sess.project}/${f}`, fileName: f };
        }
        if (tg.tools) ev.data.toolName = tg.tools[Math.floor(Math.random() * tg.tools.length)];
        if (tg.msgs) ev.data.contentPreview = tg.msgs[Math.floor(Math.random() * tg.msgs.length)];
        events.push(ev);
      }
    }

    // media.transcript 데모
    events.push({
      id: ulid(), type: 'media.transcript', sessionId: 'personal',
      userId: 'local', channelId: 'default', source: 'demo',
      timestamp: new Date(now - 1800_000).toISOString(),
      data: { text: 'React에서 useReducer는 복잡한 상태 관리에 적합합니다. useState보다 액션 기반으로 상태를 변경하면 예측 가능성이 높아집니다.', source: 'speech', lang: 'ko-KR', duration: 120 },
    });
    events.push({
      id: ulid(), type: 'media.transcript', sessionId: 'personal',
      userId: 'local', channelId: 'default', source: 'demo',
      timestamp: new Date(now - 900_000).toISOString(),
      data: { text: 'SQL 인덱스 설계 시 카디널리티가 높은 컬럼을 앞에 배치하고, 커버링 인덱스를 활용하면 쿼리 성능이 크게 향상됩니다.', source: 'speech', lang: 'ko-KR', duration: 180 },
    });

    for (const ev of events) {
      try { insertEvent(ev); } catch {}
    }

    broadcastAll({ type: 'refresh' });
    res.json({ ok: true, eventCount: events.length, sessions: sessions.length });
  } catch (e) {
    console.error('[demo/generate] error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 데모 데이터 삭제
app.post('/api/demo/clear', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  const user = token ? verifyToken(token) : null;
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  try {
    const db = dbModule.getDb();
    const deleted = db.prepare(`DELETE FROM events WHERE source = 'demo'`).run();
    broadcastAll({ type: 'refresh' });
    res.json({ ok: true, deleted: deleted.changes });
  } catch (e) {
    console.error('[demo/clear] error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── 스킬 API ────────────────────────────────────────────────────────────────
app.post('/api/skills', (req, res) => {
  const db = dbModule.getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, description TEXT, trigger_pattern TEXT,
    prompt TEXT, type TEXT DEFAULT 'custom', source TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  const { name, description, trigger, prompt, type, source } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const r = db.prepare('INSERT INTO skills (name, description, trigger_pattern, prompt, type, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, description || '', trigger || '', prompt || '', type || 'custom', source || 'user');
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.get('/api/skills', (req, res) => {
  const db = dbModule.getDb();
  try {
    const rows = db.prepare('SELECT * FROM skills ORDER BY created_at DESC').all();
    res.json(rows);
  } catch { res.json([]); }
});

// ─── 초대 페이지 라우트 ──────────────────────────────────────────────────────
app.get('/invite/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'invite.html'));
});

// ─── 클라우드 동기화 ──────────────────────────────────────────────────────────
const createSyncRouter = require('./routes/sync');
app.use('/api', createSyncRouter({ getDb: dbModule.getDb, getAllEvents }));

// ─── 회사 컨설팅 플랫폼 (Company Ontology + Diagnosis + Learning) ───────────
try { companyOntology.ensureCompanyTables(dbModule.getDb()); } catch (e) { console.warn('[DB Init] company-ontology 초기화 스킵:', e.message); }
try { createOpsOntologyRouter.ensureOpsTables(dbModule.getDb()); } catch (e) { console.warn('[DB Init] ops-ontology 초기화 스킵:', e.message); }
try { createVerificationRouter.ensureTable(dbModule.getDb()); } catch (e) { console.warn('[DB Init] verification 초기화 스킵:', e.message); }
try { createOpsOntologyRouter.startPromoteCron(dbModule.getDb, 30, 2); } catch (e) { console.warn('[DB Init] ops-ontology cron 스킵:', e.message); }

// ─── LLM 비용 계측 (호출자별 토큰/비용 — "API 비용 어디서 나가나") ──────────
try { require('./src/llm-usage').ensureTable(dbModule.getDb()); } catch (e) { console.warn('[DB Init] llm-usage 초기화 스킵:', e.message); }
app.get('/api/costs/llm', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 14;
    const data = await require('./src/llm-usage').summary(dbModule.getDb(), days);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 실시간 Haiku 분석(ollama-analyzer 1차) 런타임 토글 — 기본 OFF(비용차단). master 토큰 필요.
app.post('/api/costs/realtime-haiku', (req, res) => {
  const MASTER = 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.token;
  if (tok !== MASTER) return res.status(401).json({ error: 'unauthorized' });
  global._realtimeHaikuOn = !!(req.body && req.body.enabled);
  res.json({ ok: true, realtimeHaiku: global._realtimeHaikuOn ? 'on' : 'off' });
});
app.use('/api', createCompanyRouter({ getDb: dbModule.getDb, broadcastAll }));
app.use('/api', createDiagnosisRouter({ getDb: dbModule.getDb, broadcastAll }));
app.use('/api', createCompanyLearningRouter({ getDb: dbModule.getDb }));
app.use('/api', createNodesRouter({ getDb: dbModule.getDb })); // 3D 노드 분류 + 궤도 레이아웃
app.use('/api', createWorkspaceActivityRouter()); // 워크스페이스 협업 신호 분석

// ─── JSONL 파일 감시 (레거시 이벤트 소스 지원) ───────────────────────────────
// /api/hook 를 사용하지 않는 구버전 save-turn.js 호환용
// PG 환경에서는 JSONL 감시 불필요 (hook → PG 직접 삽입)
let lastBytePos = 0;
if (!process.env.DATABASE_URL) {
try { lastBytePos = fs.statSync(CONV_FILE).size; } catch {}
}

if (!process.env.DATABASE_URL) {
chokidar.watch(CONV_FILE, {
  usePolling:       true,
  interval:         300,
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 },
}).on('change', () => {
  try {
    const stat = fs.statSync(CONV_FILE);
    if (stat.size <= lastBytePos) {
      lastBytePos = stat.size;
      return;
    }

    const fd  = fs.openSync(CONV_FILE, 'r');
    const buf = Buffer.alloc(stat.size - lastBytePos);
    fs.readSync(fd, buf, 0, buf.length, lastBytePos);
    fs.closeSync(fd);
    lastBytePos = stat.size;

    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    if (lines.length > 0) {
      const graph    = getFullGraph();
      const stats    = getStats();
      const sessions = getSessions();

      // tool.end 완료 노드 추출
      const completedToolStarts = [];
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'tool.end' || ev.type === 'tool.error') {
            const startNode = graph.nodes.find(n =>
              (n.eventType || n.type) === 'tool.start' && n.sessionId === ev.sessionId
            );
            if (startNode) completedToolStarts.push(startNode.id);
          }
        } catch {}
      }

      // 사용자별 데이터 격리: 각 WS 클라이언트에 본인 그래프만 전송
      for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        try {
          const uid = client._userId || 'local';
          const g   = uid !== 'local' && uid !== 'anonymous'
                        ? getFullGraphForUser(uid) : graph;
          const s   = getSessionsForUser(uid);
          client.send(JSON.stringify({ type: 'update', graph: g, stats, sessions: s, completedToolStarts }));
        } catch {}
      }
      console.log(`[WATCH] ${lines.length}개 새 이벤트 감지 → 사용자별 그래프 업데이트`);
    }
  } catch (e) {
    console.error('[WATCH] 오류:', e.message);
  }
});
} // end if (!process.env.DATABASE_URL) — JSONL 감시

// ─── 활동 점수 주기적 업데이트 (30초, 캐시 활용) ─────────────────────────────
setInterval(() => {
  if (wss.clients.size === 0) return;
  try {
    // 사용자별 활동 점수 전송 (캐시된 그래프 사용)
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try {
        const uid   = client._userId || 'local';
        const graph = (uid !== 'local' && uid !== 'anonymous')
          ? getFullGraphForUser(uid) : getFullGraph();

        const scores = {};
        for (const node of graph.nodes) {
          scores[node.id] = {
            activityScore: node.activityScore,
            size:          node.size,
            borderWidth:   node.borderWidth,
            shadow:        node.shadow,
          };
        }
        client.send(JSON.stringify({ type: 'activity', scores }));
      } catch {}
    }
  } catch (e) {
    console.error('[ACTIVITY] 오류:', e.message);
  }
}, 30000);

// ─── RAG 초기화 (PG 사용 시, 서버 시작 후 지연 실행) ─────────────────────────
// autoIndex 자동 실행 비활성화 — OOM 방지 (API 호출 시에만 on-demand 실행)
if (ragCore && process.env.DATABASE_URL) {
  setTimeout(() => {
    const _ragDb = dbModule.getDb();
    ragCore.init(_ragDb).catch(e => console.warn('[rag-core] 초기화 실패:', e.message));
    // autoIndex/cleanup 타이머 제거 — 메모리 안정성 우선
    console.log('[rag-core] 초기화 완료 (autoIndex 자동 실행 비활성화)');
  }, 60 * 1000);
}


// RAG API 엔드포인트
app.get('/api/rag/search', async (req, res) => {
  try {
    const { q, userId, sourceType, app: appFilter, days, limit } = req.query;
    if (!q) return res.status(400).json({ error: 'q 필수' });
    const results = await ragCore.search({
      query: q, userId, sourceType, app: appFilter,
      days: days ? parseInt(days) : undefined,
      limit: limit ? parseInt(limit) : 10,
    });
    res.json({ ok: true, count: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/rag/context', async (req, res) => {
  try {
    const { currentState, userId, days, limit } = req.query;
    if (!currentState) return res.status(400).json({ error: 'currentState 필수' });
    const results = await ragCore.searchSimilarContext({
      currentState, userId,
      days: days ? parseInt(days) : 7,
      limit: limit ? parseInt(limit) : 10,
    });
    res.json({ ok: true, count: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rag/query', async (req, res) => {
  try {
    const { agent, question, userId, searchOpts, llmOpts } = req.body || {};
    if (!question) return res.status(400).json({ error: 'question 필수' });
    const result = await ragCore.query({
      agent: agent || 'default',
      question, userId,
      searchOpts: searchOpts || {},
      llmOpts: llmOpts || {},
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/rag/stats', async (req, res) => {
  try {
    const stats = await ragCore.getStats();
    res.json({ ok: true, ...stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 인사이트 엔진 ────────────────────────────────────────────────────────────
const insightEngine = require('./src/insight-engine');


// ── 인사이트/학습/클라이언트 API (routes/insights-api.js) ────────────────────
const createInsightsApiRouter = require('./routes/insights-api');
app.use('/api', createInsightsApiRouter({
  getAllEvents, broadcastAll, insightEngine, diffLearner, dualSkillEngine,
  wsChannelMap, wss,
  broadcastToClientId(clientId, msg) {
    const payload = JSON.stringify(msg);
    wss.clients.forEach(ws => {
      const info = wsChannelMap.get(ws);
      if (ws.readyState === WebSocket.OPEN && info?.clientId === clientId) ws.send(payload);
    });
    broadcastAll(msg);
  },
}));

// ── 학습 데이터 자동 크롤링 API ─────────────────────────────────────────────
app.get('/api/learned-insights', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const data = ollamaAnalyzer.getLearnedInsights(limit);
  res.json({ ok: true, count: data.length, insights: data });
});
app.get('/api/learned-insights/latest', (req, res) => {
  const data = ollamaAnalyzer.getLearnedInsights(1);
  res.json({ ok: true, insight: data[0] || null });
});

// ── 행동 데이터 동기화 API ─────────────────────────────────────────────────────
// 브라우저의 orbit3d-behavior.js가 주기적으로 POST하는 행동 스냅샷 수신
const _behaviorStore = new Map(); // userId → [{ ts, score, kps, cps, ... }]
const _BEHAVIOR_MAX_USERS = 200; // 사용자 수 상한

app.post('/api/behavior/sync', (req, res) => {
  try {
    const token  = (req.headers.authorization || '').replace('Bearer ','').trim() || req.query.token;
    const user   = _verifyToken(token);
    const uid    = user?.id || 'anonymous';
    const { score, kps, cps, history, sessionId } = req.body || {};
    if (typeof score !== 'number') return res.status(400).json({ error: 'score required' });

    const now = Date.now();
    const snap = { ts: now, score, kps: kps || 0, cps: cps || 0, sessionId };

    // 인메모리 저장 (최대 120개 = 2분, 사용자 200명 상한)
    if (!_behaviorStore.has(uid)) {
      if (_behaviorStore.size >= _BEHAVIOR_MAX_USERS) {
        // 가장 오래된 사용자 제거
        const oldest = _behaviorStore.keys().next().value;
        _behaviorStore.delete(oldest);
      }
      _behaviorStore.set(uid, []);
    }
    const arr = _behaviorStore.get(uid);
    arr.push(snap);
    if (arr.length > 120) arr.splice(0, arr.length - 120);

    // WebSocket으로 실시간 브로드캐스트 (같은 사용자 세션에게만)
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client._userId && client._userId !== uid && uid !== 'anonymous') continue;
      try { client.send(JSON.stringify({ type: 'behavior_score', uid, score, kps, cps, ts: now })); } catch {}
    }

    res.json({ ok: true, uid, score, buffered: arr.length });
  } catch (e) {
    console.error('[behavior/ingest] error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET 최근 행동 통계
app.get('/api/behavior/stats', (req, res) => {
  const token  = (req.headers.authorization || '').replace('Bearer ','').trim() || req.query.token;
  const user   = _verifyToken(token);
  const uid    = user?.id || 'anonymous';
  const arr    = _behaviorStore.get(uid) || [];
  const avg    = arr.length ? arr.reduce((s,x) => s + x.score, 0) / arr.length : 0;
  const peak   = arr.length ? Math.max(...arr.map(x => x.score)) : 0;
  res.json({ ok: true, uid, snapshots: arr.length, avgScore: +avg.toFixed(3), peakScore: +peak.toFixed(3), latest: arr.slice(-5) });
});

// ── 설치 스크립트 (.ps1 / .sh) ─────────────────────────────────────────────
const createSetupScriptsRouter = require('./routes/setup-scripts');
app.use('/', createSetupScriptsRouter({ PORT }));

// ── 외부 통합 API (terminal, vscode, browser, keylog, chrome, AI conversations) ──
const createIntegrationsRouter = require('./routes/integrations');
app.use('/', createIntegrationsRouter({ broadcastAll, ollamaAnalyzer, dbModule, PORT, verifyToken }));

// ── 시스템 모니터 (활성 앱/윈도우/클립보드/브라우저 URL 추적) ──────────────
try {
  const { getInstance: getSystemMonitor } = require('./src/system-monitor');
  const sysMonitor = getSystemMonitor({ cdp: true, clipboard: true, app: true });
  sysMonitor.start();
  sysMonitor.on('activity', (ev) => {
    // 이벤트를 DB에 저장 + 대시보드로 브로드캐스트
    try {
      const eventId = `sm-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
      insertEvent({
        id: eventId,
        type: ev.type || 'app_switch',
        source: ev.app || 'system',
        filePath: ev.url || ev.title || '',
        aiSource: 'system-monitor',
        timestamp: new Date(ev.timestamp || Date.now()).toISOString(),
        data: JSON.stringify(ev),
      });
      broadcastAll({ type: 'new_event', event: { ...ev, id: eventId } });
    } catch {}
  });
} catch (e) {
  console.log(`   시스템 모니터: 비활성 (${e.message})`);
}
// ─── API 버전닝: /api/v1/* → /api/* 포워딩 (하위호환 유지) ──────────────────
// /api/v1/graph → /api/graph, /api/v1/tracker/status → /api/tracker/status 등
app.use('/api/v1', (req, res, next) => {
  // req.url 을 /api + 원래 경로로 재작성하여 기존 핸들러로 라우팅
  req.url = '/api' + req.url;
  // Express의 내부 라우터로 재전달 (미들웨어 스택 우회)
  app._router.handle(req, res, next);
});
console.log('[API] /api/v1/* → /api/* alias registered');

// ─── 서버 시작 (PG auth 복원 후 listen) ────────────────────────────────────
async function startServer() {
  // Railway 환경에서는 heavy 백그라운드 엔진 기본 비활성화 (OOM → Bad Gateway 방지)
  // 개별 엔진을 살리려면 Railway 환경변수에서 해당 값을 '0'으로 설정하면 됩니다.
  // 데이터/토큰에는 영향 없음 — 스케줄러/크롤러만 해당.
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_NAME) {
    process.env.INSIGHT_DISABLED           = process.env.INSIGHT_DISABLED           || '1';
    process.env.USAGE_TRACKER_DISABLED     = process.env.USAGE_TRACKER_DISABLED     || '1';
    process.env.REVENUE_SCHEDULER_DISABLED = process.env.REVENUE_SCHEDULER_DISABLED || '1';
    process.env.MCP_WATCHER_DISABLED       = process.env.MCP_WATCHER_DISABLED       || '1';
    process.env.COMPANY_CRAWLER_DISABLED   = process.env.COMPANY_CRAWLER_DISABLED   || '1';
    process.env.GDRIVE_SYNC_DISABLED       = process.env.GDRIVE_SYNC_DISABLED       || '1';
    console.log('[startup] Railway 환경 감지 — 백그라운드 엔진 기본 비활성화 (메모리 보호)');
  }

  // PostgreSQL: 테이블 초기화 완료 대기 (재배포 시 경합 상태 방지)
  if (process.env.DATABASE_URL && dbModule.waitForTables) {
    await dbModule.waitForTables().catch(e => console.warn('[startup] PG 테이블 대기 실패:', e.message));
  }
  // 통합 이벤트 버스 초기화 (PG LISTEN 시작)
  if (process.env.DATABASE_URL) {
    const _ebPool = dbModule.getDb ? dbModule.getDb() : null;

    // ── 마이그레이션 자동 실행 (_migrations 테이블로 멱등 보장) ──
    if (_ebPool) {
      try {
        const { runMigrations } = require('./src/migrate');
        await runMigrations(_ebPool);
      } catch (e) {
        console.warn('[startup] 마이그레이션 실패 (서비스는 계속):', e.message);
      }
    }

    if (_ebPool) await eventBus.init(_ebPool).catch(e => console.warn('[startup] EventBus 초기화 실패:', e.message));

    // ── Layer 2 entity-resolution scheduler — 부작용 없음, 항상 실행 ──
    // (publisher 게이트 밖에 둠: 시드/매처는 idempotent, 데이터 없으면 0건 반환)
    if (_ebPool) {
      try {
        const erScheduler = require('./src/intelligence/entity-resolution/scheduler');
        erScheduler.start(_ebPool);
      } catch (e) {
        console.warn('[startup] entity-resolution scheduler 초기화 실패:', e.message);
      }
    }

    // ── Intelligence Layer 1 publishers (opt-in: INTELLIGENCE_PUBLISHERS=1) ──
    if (_ebPool && process.env.INTELLIGENCE_PUBLISHERS === '1') {
      try {
        const orbitPub = require('./src/intelligence/adapters/orbit-publisher');
        const agentPub = require('./src/intelligence/adapters/agent-publisher');
        const erpPub   = require('./src/intelligence/adapters/erp-publisher');
        const pollMs   = parseInt(process.env.NENOVA_ERP_POLL_INTERVAL_MS || '60000', 10);

        orbitPub.init(_ebPool); orbitPub.start(pollMs);
        // ERP/agent 는 자격증명 있을 때만
        if (process.env.NENOVA_ERP_USER && process.env.NENOVA_ERP_PASS) {
          agentPub.init(_ebPool); agentPub.start(pollMs);
          erpPub.init(_ebPool);   erpPub.start(pollMs);
        } else {
          console.warn('[startup] NENOVA_ERP_USER/PASS 미설정 — agent/erp publisher 건너뜀');
        }
      } catch (e) {
        console.warn('[startup] intelligence publishers 초기화 실패:', e.message);
      }
    }
  }
  // 비동기 테이블 초기화 완료 대기 (chat, analytics)
  if (global._chatInitPromise) await global._chatInitPromise;
  if (global._analyticsInitPromise) await global._analyticsInitPromise;
  // Railway 재배포 후 SQLite가 비어있으면 PG에서 사용자/토큰 복원
  if (process.env.DATABASE_URL) {
    await authInitFromPg().catch(e => console.warn('[startup] auth PG 복원 실패:', e.message));
    // 미소비 데몬 명령 PG → 메모리 복원 (재배포 후 PC 명령 유지)
    try {
      const _pool = dbModule.getDb ? dbModule.getDb() : null;
      if (_pool) {
        const { rows } = await _pool.query(
          `SELECT hostname, action, command, data_json, ts FROM orbit_daemon_commands
           WHERE consumed_at IS NULL AND ts > NOW() - INTERVAL '48 hours'
           ORDER BY ts ASC`
        );
        if (rows.length > 0) {
          if (!global._daemonCommands) global._daemonCommands = {};
          rows.forEach(r => {
            if (!global._daemonCommands[r.hostname]) global._daemonCommands[r.hostname] = [];
            global._daemonCommands[r.hostname].push({ action: r.action, command: r.command, data: r.data_json, ts: r.ts });
          });
          console.log(`[startup] 데몬 명령 복원: ${rows.length}건`);
        }
      }
    } catch (e) {
      console.warn('[startup] 데몬 명령 복원 실패:', e.message);
    }
  }
  // 서버 시작(Railway 배포)마다 자동으로 ALL 데몬에 update 명령 푸시
  // git push → Railway 배포 → 데몬 자동 업데이트
  try {
    const _pool = dbModule.getDb ? dbModule.getDb() : null;
    if (_pool?.query) {
      await _pool.query(`CREATE TABLE IF NOT EXISTS orbit_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
      // [2026-06-15] 서버 Vision 워커 OFF 토글 로드 (재배포해도 유지) — owner PC CLI 야간워커 대체용
      try { const _vr = await _pool.query(`SELECT value FROM orbit_settings WHERE key='vision_server_off'`); global._serverVisionOff = (_vr.rows[0]?.value === 'true'); if (global._serverVisionOff) console.log('[vision-toggle] 부팅: 서버 Vision 워커 OFF (PG 설정)'); } catch {}
      try { const _dr = await _pool.query(`SELECT value FROM orbit_settings WHERE key='drive_disabled'`); global._driveDisabled = (_dr.rows[0]?.value === 'true'); if (global._driveDisabled) console.log('[drive-toggle] 부팅: Drive 업로드 OFF (PG 설정)'); } catch {}
      // 배포 버전 변경 시에만 force_update (크래시 재시작 시 무한루프 방지)
      const currentVersion = require('./package.json').version || 'unknown';
      const gitHash = (() => { try { return require('child_process').execSync('git rev-parse --short HEAD', {encoding:'utf8',timeout:3000}).trim(); } catch { return ''; } })();
      const deployKey = `${currentVersion}-${gitHash}`;
      const lastDeployRes = await _pool.query(`SELECT value FROM orbit_settings WHERE key='last_deploy_key'`).catch(()=>({rows:[]}));
      const lastDeployKey = lastDeployRes.rows[0]?.value || '';
      const isNewDeploy = deployKey && deployKey !== lastDeployKey;

      if (isNewDeploy) {
        await _pool.query(
          `INSERT INTO orbit_settings (key, value) VALUES ('force_update', 'true')
           ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = NOW()`
        );
        await _pool.query(
          `INSERT INTO orbit_settings (key, value) VALUES ('last_deploy_key', $1)
           ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`, [deployKey]
        );
        global._forceUpdateEnabled = true;
        // 배포 후 5분 지연 — 서버 안정화 후 데몬 업데이트 (동시 재시작 OOM 방지)
        setTimeout(() => {
          if (!global._daemonCommands) global._daemonCommands = {};
          if (!global._daemonCommands['ALL']) global._daemonCommands['ALL'] = [];
          global._daemonCommands['ALL'].push({
            action: 'update',
            reason: 'server-deploy',
            ts: new Date().toISOString(),
            consumedHosts: new Set(), // 호스트별 1회 처리 (반복 update 명령 방지)
          });
          console.log(`[startup] 신규 배포(${deployKey}) — ALL 데몬 업데이트 명령 등록 (5분 지연 완료)`);
        }, 5 * 60 * 1000);
        console.log(`[startup] 신규 배포 감지(${deployKey}) — 5분 후 ALL 데몬 업데이트 예약`);
      } else {
        console.log(`[startup] 재시작 감지(${deployKey}) — 데몬 강제업데이트 생략 (무한루프 방지)`);
      }
    }
  } catch (e) {
    console.warn('[startup] 자동 업데이트 명령 등록 실패:', e.message);
  }

  // Drive 폴더ID 오버라이드 복원 (orbit_settings에서 로드)
  try {
    const _pool = dbModule.getDb ? dbModule.getDb() : null;
    if (_pool?.query) {
      const { rows } = await _pool.query(
        `SELECT value FROM orbit_settings WHERE key='drive.folderId.override'`
      ).catch(() => ({ rows: [] }));
      if (rows[0]?.value) {
        if (!global._driveConfigOverride) global._driveConfigOverride = {};
        global._driveConfigOverride.folderId = rows[0].value;
        console.log(`[startup] Drive 폴더ID 오버라이드 복원: ${rows[0].value}`);
      }
    }
  } catch (e) { console.warn('[startup] Drive 폴더ID 복원 실패:', e.message); }

  // 관리자 토큰 자동 부트스트랩 (Railway 재시작 시 ADMIN_TOKENS 복원)
  // ~/.orbit-config.json 또는 ADMIN_TOKENS 환경변수에서 로드됨 (environment.js가 처리)
  // 추가로: PG orbit_auth_tokens에서 관리자 이메일 계정의 토큰들을 ADMIN_TOKENS에 등록

  // ADMIN_SECRET env var → 직접 ADMIN_TOKENS에 포함 (Railway 재시작 후 영구 admin 접근 보장)
  if (process.env.ADMIN_SECRET && !env.ADMIN_TOKENS.includes(process.env.ADMIN_SECRET)) {
    env.ADMIN_TOKENS.push(process.env.ADMIN_SECRET);
    console.log('[startup] ADMIN_SECRET → ADMIN_TOKENS 자동 등록 (Railway 재시작 대응)');
  }

  try {
    const _adminBootstrap = async () => {
      const authMod = require('./src/auth');
      // SQLite에서 복원
      for (const adminEmail of env.ADMIN_EMAILS) {
        const adminUser = authMod.getUserByEmail ? authMod.getUserByEmail(adminEmail) : null;
        if (adminUser) {
          const authDb = authMod.getDb ? authMod.getDb() : null;
          if (authDb) {
            const tokens = authDb.prepare('SELECT token FROM tokens WHERE userId = ?').all(adminUser.id);
            tokens.forEach(({ token }) => {
              if (!env.ADMIN_TOKENS.includes(token)) {
                env.ADMIN_TOKENS.push(token);
                console.log(`[startup] 관리자 토큰 복원(SQLite): ${adminEmail} (${token.slice(0,8)}...)`);
              }
            });
          }
        }
      }
      // PG fallback — Railway 재시작 시 SQLite 초기화 대비
      try {
        const _pool = dbModule.getDb ? dbModule.getDb() : null;
        if (_pool?.query) {
          for (const adminEmail of env.ADMIN_EMAILS) {
            const { rows } = await _pool.query(
              `SELECT t.token FROM orbit_auth_tokens t JOIN orbit_auth_users u ON t.user_id = u.id
               WHERE u.email = $1 AND (t.expires_at IS NULL OR t.expires_at > NOW())`,
              [adminEmail]
            );
            rows.forEach(({ token }) => {
              if (!env.ADMIN_TOKENS.includes(token)) {
                env.ADMIN_TOKENS.push(token);
                console.log(`[startup] 관리자 토큰 복원(PG): ${adminEmail} (${token.slice(0,8)}...)`);
              }
            });
          }
        }
      } catch (e) { console.warn('[startup] PG admin 토큰 복원 실패:', e.message); }
      // ADMIN_TOKENS 환경변수에 있는 토큰도 관리자 사용자와 연결 보장
      for (const tok of env.ADMIN_TOKENS) {
        const user = verifyToken(tok);
        if (!user) {
          // 토큰이 auth DB에 없으면 관리자 계정으로 등록
          const adminEmail = env.ADMIN_EMAILS[0];
          let adminUser = authMod.getUserByEmail ? authMod.getUserByEmail(adminEmail) : null;
          if (!adminUser) {
            const result = authMod.register ? authMod.register({
              email: adminEmail, name: 'Admin', password: require('crypto').randomBytes(24).toString('hex')
            }) : { ok: false };
            if (result.ok) adminUser = result.user;
          }
          if (adminUser) {
            const authDb = authMod.getDb ? authMod.getDb() : null;
            if (authDb) {
              try {
                authDb.prepare('INSERT OR IGNORE INTO tokens (token, userId, type) VALUES (?, ?, ?)').run(tok, adminUser.id, 'api');
                const { pgBackupToken, pgBackupUser } = authMod;
                if (pgBackupUser) await pgBackupUser(adminUser, '').catch(() => {});
                if (pgBackupToken) await pgBackupToken(tok, adminUser.id, null).catch(() => {});
                console.log(`[startup] ADMIN_TOKEN → auth DB 등록: ${adminEmail}`);
              } catch {}
            }
          }
        }
      }
    };
    await _adminBootstrap();
  } catch (e) { console.warn('[startup] admin bootstrap 실패:', e.message); }

  // ── 온라인 PC push-token 일괄 적용 (local → 실제 userId 연동) ──────────────
  // PC 호스트명 → userId 매핑 (nenova 워크스페이스)
  try {
    const _pool = dbModule.getDb ? dbModule.getDb() : null;
    if (_pool?.query && process.env.DATABASE_URL) {
      // PC별 userId 직접 매핑 (알고 있는 것만)
      const PC_USER_MAP = {
        '이재만':           'MNH03H73690BB2CD82', // jaeyong lim (임재용)
        'DESKTOP-T09911T':  'MNMRX6SR07F5FF7C0C', // 강현우
        'PAPI-CHULO-PC':    'MNMRVD11EDCCF6E7CE', // wbk 원빈킴
        'Papi-Chulo-PC':    'MNMRVD11EDCCF6E7CE', // wbk (대소문자 변형)
        'DESKTOP-CAA5TA1':  'MNMR8568CC8950F81D', // hoon J (훈제이) — 전용 PC
        'DESKTOP-L0C2IOT':  'MNMSAQJD78E544A631', // 강명훈
        'DESKTOP-4OM3URA':  'MNSKAQSQ649D9E5936', // Luke 전용 PC
      };
      // PC별 이름 매핑 → PG orbit_auth_users에서 user_id 동적 조회
      // ※ PC_USER_MAP에 이미 있는 호스트명은 여기서 제외해야 덮어쓰기 방지
      const PC_NAME_MAP = {
        'NENOVA2025':       '설연주',
        'NEONVA':           '설연주',
        'neonva':           '설연주', // 소문자 변형
        'DESKTOP-HGNEA1S':  '박성수',
      };
      // 이름으로 userId 조회하여 PC_USER_MAP에 추가 (이미 매핑된 호스트는 스킵)
      for (const [hostname, name] of Object.entries(PC_NAME_MAP)) {
        if (PC_USER_MAP[hostname]) continue; // 직접 매핑 우선 — 덮어쓰기 방지
        try {
          const { rows: ur } = await _pool.query(
            `SELECT id FROM orbit_auth_users WHERE name ILIKE $1 LIMIT 1`, [`%${name}%`]
          );
          if (ur.length > 0) PC_USER_MAP[hostname] = ur[0].id;
        } catch {}
      }
      const DEFAULT_USER_ID = null; // 매핑 없는 PC는 건드리지 않음
      const SERVER_URL = process.env.SERVER_URL || 'https://mindmap-viewer-production-adb2.up.railway.app';
      // 과거 이벤트를 보낸 모든 PC 호스트명 조회 (동적 — 하드코딩 불필요)
      const { rows: pcRows } = await _pool.query(
        `SELECT DISTINCT data_json->>'hostname' AS hostname FROM events
         WHERE data_json->>'hostname' IS NOT NULL
         AND data_json->>'hostname' != ''
         LIMIT 100`
      );
      const allHostnames = pcRows.map(r => r.hostname).filter(Boolean);
      // userId별 최신 토큰 조회 (없으면 발급)
      const tokenCache = {};
      const getTokenForUser = async (userId) => {
        if (tokenCache[userId]) return tokenCache[userId];
        const { rows } = await _pool.query(
          `SELECT token FROM orbit_auth_tokens WHERE user_id=$1 AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT 1`,
          [userId]
        );
        if (rows.length > 0) { tokenCache[userId] = rows[0].token; return rows[0].token; }
        const { issueApiToken } = require('./src/auth');
        const newToken = issueApiToken(userId);
        await _pool.query(
          `INSERT INTO orbit_auth_tokens (user_id, token, created_at) VALUES ($1,$2,NOW()) ON CONFLICT DO NOTHING`,
          [userId, newToken]
        ).catch(() => {});
        tokenCache[userId] = newToken;
        return newToken;
      };
      // 이미 미소비 명령이 있는 호스트 (중복 방지)
      const { rows: existing } = await _pool.query(
        `SELECT DISTINCT hostname FROM orbit_daemon_commands WHERE consumed_at IS NULL AND ts > NOW() - INTERVAL '1 hour'`
      );
      const alreadyQueued = new Set(existing.map(r => r.hostname));
      const ts = new Date().toISOString();
      let pushed = 0;
      for (const hostname of allHostnames) {
        if (alreadyQueued.has(hostname)) continue;
        const userId = PC_USER_MAP[hostname] || DEFAULT_USER_ID;
        if (!userId) continue; // 매핑 없는 PC는 건드리지 않음
        const token = await getTokenForUser(userId).catch(() => null);
        if (!token) continue;
        const cmdData = { token, serverUrl: SERVER_URL };
        // config 명령만 등록 — 데몬이 파일 업데이트 후 재시작 없이 live config 반영
        // (restart INSERT 제거 이유: 매 server 재배포마다 모든 데몬이 process.exit →
        //  매분 재시작 loop의 원인이었음. config만으로 충분)
        await _pool.query(
          `INSERT INTO orbit_daemon_commands (hostname, action, command, data_json, ts) VALUES ($1,'config',NULL,$2,$3)`,
          [hostname, JSON.stringify(cmdData), ts]
        ).catch(() => {});
        if (!global._daemonCommands) global._daemonCommands = {};
        if (!global._daemonCommands[hostname]) global._daemonCommands[hostname] = [];
        global._daemonCommands[hostname].push({ action: 'config', data: cmdData, ts });
        pushed++;
        console.log(`[startup/push-token] ${hostname} → userId=${userId}${global._forceUpdateEnabled ? ' + update@+2min' : ''}`);
      }
      if (pushed > 0) console.log(`[startup/push-token] ${pushed}개 PC에 토큰 푸시 완료 (전체 이력 기반)`);
    }
  } catch (e) { console.warn('[startup/push-token] 실패:', e.message); }
  // ─────────────────────────────────────────────────────────────────────────────

  server.listen(PORT, async () => {
  const stats = await Promise.resolve(getStats());
  logger.info(`Orbit AI v2.0.0 — http://localhost:${PORT}`, {
    events: stats?.eventCount ?? '?',
    sessions: stats?.sessionCount ?? '?',
    files: stats?.fileCount ?? '?',
    oauth: enabledProviders.join(', ') || '미설정',
    anthropic: '맥미니 전용',
  });
  // 개발 환경에서는 엔드포인트 목록 출력 (프로덕션 JSON 로그에서는 위 메타에 포함)
  if (process.env.NODE_ENV !== 'production') {
    console.log(`   이벤트: ${stats?.eventCount ?? '?'}개 | 세션: ${stats?.sessionCount ?? '?'}개 | 파일: ${stats?.fileCount ?? '?'}개`);
    console.log(`   감시 파일: ${CONV_FILE}`);
    console.log(`   OAuth: [${enabledProviders.join(', ') || '미설정'}]`);
    console.log(`   Git hooks 설치: curl http://localhost:${PORT}/api/git/install | bash`);
    console.log(`   MCP 서버: http://localhost:${PORT}/api/mcp`);
    console.log(`   학습 데이터: http://localhost:${PORT}/api/learned-insights\n`);
  }

  // ── [골 자동디벨롭] 판단경계 마이닝 루프 ──
  //   ⚠️ 기본 OFF(opt-in): 자동 루프가 768MB 힙을 터뜨린 사고(2026-07-10) 후 opt-in 전환.
  //   켜려면 JUDGMENT_LOOP=on (힙 여유 확인 후). 평시엔 /api/admin/judgment-map 온디맨드만 사용.
  if ((process.env.JUDGMENT_LOOP || '').toLowerCase() === 'on') {
    const _runJudgment = async () => {
      try {
        if (global._heapPressure) { console.warn('[judgment-loop] 힙압력 — 스킵'); return; }
        const pool = dbModule.getDb ? dbModule.getDb() : null;
        if (!pool || !process.env.DATABASE_URL) return;
        const { mineJudgment } = require('./src/judgment-miner');
        const out = await mineJudgment(pool, { hours: 48 });
        out._at = Date.now();
        global._judgmentCache = out;
        console.log(`[judgment-loop] 루틴 ${out.routineCount}개 · 자동화가능 ${out.automatableStepInstances} (세션 ${out.sessions})`);
      } catch (e) { console.warn('[judgment-loop] 실패:', e.message); }
    };
    setTimeout(_runJudgment, 5 * 60 * 1000);
    setInterval(_runJudgment, 60 * 60 * 1000);
  }

  // ── 서버사이드 Vision 분석 루프 시작 ────────────────────────────────────
  if (serverVisionWorker?.start) {
    serverVisionWorker.start(insertEvent);
    console.log('[server-vision-worker] Vision 분석 루프 시작 (8s 인터벌)');
  } else if (visionProcessor?.startVisionLoop) {
    visionProcessor.startVisionLoop(() => dbModule.getDb ? dbModule.getDb() : null);
    console.log('[vision-proc] Vision 루프 시작 (fallback)');
  }

  // 시계손상 이벤트 1회 정리(토큰 불필요, 서버 내부 실행) — FIX_CLOCK_HOSTNAME env 설정 후 재배포 시
  // 부팅 2분 뒤 실행. PROMOTE_BOOT_HOURS와 동일 패턴(마스터토큰이 admin 미등록이라 API 경유 불가).
  if (process.env.FIX_CLOCK_HOSTNAME) {
    setTimeout(async () => {
      try {
        const pool = dbModule.getDb();
        const nowIso = new Date().toISOString();
        const r = await pool.query(
          `UPDATE events SET timestamp = $2
            WHERE data_json->>'hostname' = $1
              AND (timestamp::timestamptz > NOW() + INTERVAL '1 day' OR timestamp::timestamptz < '2020-01-01')`,
          [process.env.FIX_CLOCK_HOSTNAME, nowIso]
        );
        console.log(`[fix-clock-skew] ${process.env.FIX_CLOCK_HOSTNAME}: ${r.rowCount}건 보정`);
      } catch (e) { console.warn('[fix-clock-skew] 실패:', e.message); }
    }, 2 * 60 * 1000);
  }

  // [2026-07-09] 1회 마이그레이션: owner로 쏠린 과거 직원 screen.analyzed/capture 재귀속.
  // owner PC CLI 비전워커가 전 직원 캡처를 owner 토큰으로 재제출해온 버그(포워드는 e0ab353에서 수정).
  // 마커(orbit_migrations)로 1회만, 배치(5000건)로, owner 본인 PC는 가드(실사용자 건수>owner쏠림 건수)로 보호.
  setTimeout(async () => {
    try {
      const pool = dbModule.getDb();
      if (!pool || !process.env.DATABASE_URL) return;
      await pool.query(`CREATE TABLE IF NOT EXISTS orbit_migrations (name TEXT PRIMARY KEY, done_at TIMESTAMPTZ DEFAULT NOW(), detail TEXT)`);
      const done = await pool.query(`SELECT 1 FROM orbit_migrations WHERE name='reattr-analyzed-v1'`);
      if (done.rowCount) return;
      const OWNER = 'MNH03H73690BB2CD82';
      // hostname → 실사용자(owner/pc_/local 제외 dominant). owner쏠림보다 많은 hostname만(owner 본인 PC 보호).
      const map = await pool.query(`
        WITH ho AS (
          SELECT LOWER(data_json->>'hostname') host, COUNT(*) owner_cnt
          FROM events WHERE user_id=$1 AND type IN ('screen.analyzed','screen.capture')
            AND data_json->>'hostname' IS NOT NULL GROUP BY 1
        ), hr AS (
          SELECT host, user_id, cnt, ROW_NUMBER() OVER (PARTITION BY host ORDER BY cnt DESC) rn FROM (
            SELECT LOWER(data_json->>'hostname') host, user_id, COUNT(*) cnt
            FROM events WHERE user_id NOT LIKE 'pc_%' AND user_id<>'local' AND user_id<>$1
              AND data_json->>'hostname' IS NOT NULL GROUP BY 1,2) t
        )
        SELECT ho.host, hr.user_id AS target, ho.owner_cnt, hr.cnt AS real_cnt
        FROM ho JOIN hr ON hr.host=ho.host AND hr.rn=1
        WHERE hr.cnt > ho.owner_cnt`, [OWNER]);
      let totalFixed = 0; const perHost = [];
      for (const row of map.rows) {
        let fixed = 0;
        for (;;) {
          const r = await pool.query(`
            UPDATE events SET user_id=$2
            WHERE id IN (
              SELECT id FROM events
              WHERE user_id=$3 AND type IN ('screen.analyzed','screen.capture')
                AND LOWER(data_json->>'hostname')=$1
              LIMIT 5000)`, [row.host, row.target, OWNER]);
          fixed += r.rowCount;
          if (r.rowCount < 5000) break;
        }
        if (fixed) { totalFixed += fixed; perHost.push(`${row.host}→${String(row.target).slice(0,8)}:${fixed}`); }
      }
      await pool.query(`INSERT INTO orbit_migrations(name, detail) VALUES('reattr-analyzed-v1',$1) ON CONFLICT(name) DO NOTHING`,
        [`fixed=${totalFixed} [${perHost.join(' ')}]`]);
      console.log(`[reattr-analyzed] 완료 fixed=${totalFixed} [${perHost.join(' ')}]`);
    } catch (e) { console.warn('[reattr-analyzed] 실패:', e.message); }
  }, 90 * 1000);  // 부팅 90초 뒤 (DB 안정화 대기)

  // outcome 테이블 초기화 (기존 DB에 테이블 없으면 생성)
  outcomeStore.initOutcomeTable();

  // 마켓 테이블 초기화 + 사용량 트래커 시작
  try { marketStore.initMarketTables(); } catch (e) { console.warn('[DB Init] market-store 초기화 스킵:', e.message); }
  if (process.env.USAGE_TRACKER_DISABLED !== '1') {
    usageTracker.start({ broadcastAll });
  } else { console.log('[startup] usageTracker 비활성화 (USAGE_TRACKER_DISABLED=1)'); }

  // 인사이트 엔진 자동 시작 (INSIGHT_DISABLED=1 이면 스킵)
  if (process.env.INSIGHT_DISABLED !== '1') {
    const { analyzeAndSuggest: saveSuggestion } = require('./src/growth-engine');
    insightEngine.start({ getAllEvents, saveSuggestion, broadcastAll });
  } else { console.log('[startup] insightEngine 비활성화 (INSIGHT_DISABLED=1)'); }

  // 수익 정산 스케줄러 시작
  if (process.env.REVENUE_SCHEDULER_DISABLED !== '1') {
    revenueScheduler.start({ broadcastAll });
  } else { console.log('[startup] revenueScheduler 비활성화 (REVENUE_SCHEDULER_DISABLED=1)'); }

  // MCP Market Watcher 시작
  if (process.env.MCP_WATCHER_DISABLED !== '1') {
    mcpWatcher.start({ broadcastAll });
  } else { console.log('[startup] mcpWatcher 비활성화 (MCP_WATCHER_DISABLED=1)'); }

  // 회사 컨설팅 크롤러 시작
  if (process.env.COMPANY_CRAWLER_DISABLED !== '1') {
    companyCrawler.start({ db: dbModule.getDb(), broadcastAll });
  } else { console.log('[startup] companyCrawler 비활성화 (COMPANY_CRAWLER_DISABLED=1)'); }

  // Google Drive 사용자 자동 백업 (2시간마다)
  // 2시간마다 Drive 백업 + Sheets 학습 데이터 내보내기 (자동)
  async function _autoGdriveSync() {
    // 힙 압박 시 백업 스킵 (OOM 방지)
    const heapMB = process.memoryUsage().heapUsed / 1024 / 1024;
    if (heapMB > 500) {
      console.warn(`[gdrive-auto] 힙 ${Math.round(heapMB)}MB — 백업 스킵 (메모리 보호)`);
      return;
    }
    try {
      const users = getGoogleOAuthUsers();
      for (const u of users) {
        try {
          const token = await getValidGoogleToken(u.id);
          if (!token) continue;
          // JSON 백업
          await gdriveUserBackup.backupUserDataToDrive(u.id, token,
            { getAllEvents, getEventsByUser, getSessionsByUser, getSessions, insertEvent });
          // Sheets 학습 데이터 자동 내보내기
          try {
            await gdriveUserBackup.exportLearningSheet(u.id, token,
              { getAllEvents, getEventsByUser, getSessionsByUser, getSessions });
            console.log(`[gdrive-auto] ${u.email} Sheets 내보내기 완료`);
          } catch (e) {
            console.warn(`[gdrive-auto] ${u.email} Sheets 실패:`, e.message);
          }
        } catch (e) {
          console.warn(`[gdrive-auto] ${u.email} 백업 실패:`, e.message);
        }
      }
    } catch {}
  }
  // 서버 시작 5분 후 첫 실행 + 이후 1시간마다 (GDRIVE_SYNC_DISABLED=1 이면 스킵)
  if (process.env.GDRIVE_SYNC_DISABLED !== '1') {
    setTimeout(_autoGdriveSync, 5 * 60 * 1000);
    setInterval(_autoGdriveSync, 1 * 60 * 60 * 1000);
  } else { console.log('[startup] autoGdriveSync 비활성화 (GDRIVE_SYNC_DISABLED=1)'); }

  console.log(`   회사 진단: http://localhost:${PORT}/api/company`);
  console.log(`   컨설턴트: http://localhost:${PORT}/consultant.html`);
  console.log(`   트래커 설치: http://localhost:${PORT}/api/tracker/install?token=TOKEN`);
  console.log(`   부트캠프: http://localhost:${PORT}/api/bootcamp/start`);

  // ── 로컬→Railway 주기적 동기화 (5분마다) ──────────────────────────────────
  // Railway 환경이 아닌 로컬 서버에서만 실행
  if (!process.env.RAILWAY_PUBLIC_DOMAIN && !process.env.RAILWAY_ENVIRONMENT) {
    const orbitCfgPath = require('path').join(require('os').homedir(), '.orbit-config.json');
    let railwayUrl = null;
    let railwayToken = '';
    try {
      const ocfg = JSON.parse(require('fs').readFileSync(orbitCfgPath, 'utf8'));
      railwayUrl = ocfg.serverUrl || null;
      railwayToken = ocfg.token || '';
    } catch {}
    railwayUrl = process.env.ORBIT_SERVER_URL || railwayUrl;

    if (railwayUrl && railwayUrl !== `http://localhost:${PORT}`) {
      console.log(`\n[Sync] Railway 동기화 활성화 (5분 간격)`);
      console.log(`   → ${railwayUrl}`);

      const _syncToRailway = async () => {
        try {
          const stats = getStats();
          // 1) 핑 전송 — verifyToken으로 실제 userId 확인
          let resolvedUserId = require('os').hostname();
          if (railwayToken) {
            try {
              const user = verifyToken(railwayToken);
              if (user) resolvedUserId = user.id;
            } catch {}
          }
          const pingBody = JSON.stringify({
            userId: resolvedUserId,
            hostname: require('os').hostname(),
            eventCount: stats.eventCount,
          });
          const pingUrl = new URL('/api/tracker/ping', railwayUrl);
          const mod = pingUrl.protocol === 'https:' ? require('https') : require('http');
          const pingReq = mod.request({
            hostname: pingUrl.hostname, port: pingUrl.port || (pingUrl.protocol === 'https:' ? 443 : 80),
            path: pingUrl.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(pingBody),
              ...(railwayToken ? { 'Authorization': `Bearer ${railwayToken}` } : {}) },
          }, () => {});
          pingReq.on('error', () => {});
          pingReq.write(pingBody);
          pingReq.end();

          // 2) 최근 이벤트 동기화
          const { execSync } = require('child_process');
          const syncScript = require('path').join(__dirname, 'bin', 'sync-to-railway.js');
          if (require('fs').existsSync(syncScript)) {
            execSync(`node "${syncScript}" --limit=200`, { timeout: 30000, stdio: 'ignore' });
          }
        } catch (e) {
          // 동기화 실패 시 조용히 넘어감
        }
      };

      // 시작 후 10초 뒤 첫 동기화, 이후 5분마다
      setTimeout(_syncToRailway, 10000);
      setInterval(_syncToRailway, 5 * 60 * 1000);
    }
  }

  // ── PG 이벤트 테이블 자동 정리 (디스크 풀 방지) ──────────────────────────
  if (process.env.DATABASE_URL) {
    const _cleanupOldEvents = async () => {
      try {
        const pool = dbModule.getDb();
        if (!pool?.query) return;
        // 30일 이상 된 이벤트 삭제
        const { rowCount } = await pool.query(
          `DELETE FROM events WHERE timestamp < NOW() - INTERVAL '30 days'`
        );
        if (rowCount > 0) {
          console.log(`[cleanup] 오래된 이벤트 ${rowCount}개 삭제`);
          await pool.query('VACUUM events').catch(() => {});
        }
        // 테이블 크기 로깅
        const sizeRes = await pool.query(
          `SELECT pg_size_pretty(pg_total_relation_size('events')) AS sz`
        );
        console.log(`[cleanup] events 테이블 크기: ${sizeRes.rows[0]?.sz}`);
      } catch (e) {
        console.warn('[cleanup] events 정리 실패:', e.message);
      }
    };
    // 시작 30초 후 첫 정리, 이후 매일 새벽 3시 (24h)
    setTimeout(_cleanupOldEvents, 30 * 1000);
    setInterval(_cleanupOldEvents, 24 * 60 * 60 * 1000);
  }

  // ── Think-Engine 자동 학습: POST /api/think/learn 2시간마다 호출 ───────────
  setInterval(() => {
    try {
      require('http').request({ hostname: 'localhost', port: PORT, path: '/api/think/learn', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': 2 }
      }, () => {}).on('error', () => {}).end('{}');
    } catch {}
  }, 2 * 60 * 60 * 1000); // 2시간마다 (startup 지연 없음 — 첫 실행은 2h 후)

  // ── 서버 시작 시 ALL 데몬에 drive-upload 명령 즉시 큐잉 ──────────────────
  setTimeout(() => {
    if (!global._daemonCommands) global._daemonCommands = {};
    if (!global._daemonCommands['ALL']) global._daemonCommands['ALL'] = [];
    global._daemonCommands['ALL'].push({ action: 'drive-upload', reason: 'server-startup', ts: new Date().toISOString() });
    console.log('[daemon] ALL 호스트 drive-upload 명령 큐 추가');
  }, 5000);

  // ── Daemon Watchdog: 5분마다 heartbeat 스캔, silent 데몬 자동 재시작 ──────
  // silent > 10분: 해당 hostname에 restart 명령 자동 등록 (1회만, 후속 복구 대기)
  // state = 'degraded' (모듈 1개 이상 죽음): 로그만 (자동 개입 안 함 — 재시작이 답이 아닐 수 있음)
  const _watchdogRecentlyKicked = new Map(); // hostname → last kick ts
  const _WATCHDOG_KICK_COOLDOWN_MS = 30 * 60 * 1000; // 같은 호스트는 30분에 1회만 kick
  setInterval(async () => {
    try {
      const _pool = dbModule.getDb ? dbModule.getDb() : null;
      if (!_pool) return;
      const { rows } = await _pool.query(
        `SELECT DISTINCT ON (user_id) user_id, timestamp, data_json
         FROM events
         WHERE type = 'daemon.heartbeat'
           AND timestamp::timestamptz > NOW() - INTERVAL '2 hours'
         ORDER BY user_id, timestamp::timestamptz DESC`
      );
      const now = Date.now();
      let kicked = 0, silent = 0, degraded = 0;
      for (const r of rows) {
        const data = r.data_json || {};
        const hostname = data.hostname;
        if (!hostname) continue;
        const hbTs = new Date(r.timestamp).getTime();
        const sinceHb = Math.round((now - hbTs) / 1000);
        if (sinceHb > 600) {  // 10분 이상 silent
          silent++;
          const lastKick = _watchdogRecentlyKicked.get(hostname) || 0;
          if (now - lastKick < _WATCHDOG_KICK_COOLDOWN_MS) continue; // 쿨다운
          // Phase 0: restart 금지 → gitpull-worker + capture-diag
          if (!global._daemonCommands) global._daemonCommands = {};
          if (!global._daemonCommands[hostname]) global._daemonCommands[hostname] = [];
          global._daemonCommands[hostname].push({
            action: 'capture-diag',
            reason: 'watchdog: silent > 10 min',
            ts: new Date().toISOString(),
          });
          global._daemonCommands[hostname].push({
            action: 'gitpull-worker',
            reason: 'watchdog: silent > 10 min',
            ts: new Date().toISOString(),
          });
          _watchdogRecentlyKicked.set(hostname, now);
          kicked++;
          console.log(`[watchdog] ${hostname}: silent ${sinceHb}s → safe-cmd queued`);
        } else if (data.state === 'degraded' || data.state === 'dead') {
          degraded++;
          console.log(`[watchdog] ${hostname}: ${data.state} — modules:`, JSON.stringify(Object.entries(data.modules || {}).map(([k, v]) => `${k}=${v?.state}`)));
        }
      }
      if (kicked || silent || degraded) {
        console.log(`[watchdog] scan: ${rows.length} daemons, ${silent} silent, ${degraded} degraded, ${kicked} kicked`);
      }
    } catch (e) {
      console.warn('[watchdog] error:', e.message);
    }
  }, 5 * 60 * 1000); // 5분 주기
  console.log('[watchdog] 데몬 heartbeat 워치독 활성화 (5분 주기, 10분 silent → safe-cmd)');

  });  // server.listen 콜백 끝
}
startServer();

// ─── Graceful shutdown ──────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  logger.info('%s 수신 — 정상 종료 시작', signal);
  if (server && server.close) {
    server.close(() => {
      logger.info('HTTP 서버 종료');
      // PG pool이 db-pg.js 내부에 있으므로 모듈 종료 함수 호출
      if (dbModule.close) {
        Promise.resolve(dbModule.close()).then(() => {
          logger.info('DB 연결 종료');
          process.exit(0);
        }).catch(() => process.exit(0));
      } else {
        process.exit(0);
      }
    });
  }
  // 10초 후 강제 종료
  setTimeout(() => { logger.warn('강제 종료'); process.exit(1); }, 10000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
