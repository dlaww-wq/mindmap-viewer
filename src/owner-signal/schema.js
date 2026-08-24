'use strict';
/**
 * src/owner-signal/schema.js — Owner Twin 테이블 보장 (owner_signal / owner_belief / owner_belief_hit)
 *
 * 이 저장소 관례상 새 테이블은 migrations 파일과 런타임 ensure 양쪽에 있어야 한다
 * (migrations/0012_ops_relation.sql:4 참조). 다만 DDL 을 두 벌 손으로 유지하면 갈라진다 —
 * 실제로 0012 에서 workspace_id DEFAULT 가 갈려 0013 ALTER 로 뒷수습한 전례가 있다.
 * 그래서 여기서는 DDL 을 다시 쓰지 않고 migrations/0015_owner_twin.sql 을 읽어 실행한다.
 *
 * 호출 시점: 부팅이 아니라 **실제 writer 진입 시 lazy 호출**.
 *   - 부팅 시 동기 try/catch 로 async 함수를 부르는 기존 배선(server.js:8861)은 SQLite 모드에서
 *     unhandled rejection 이 되고, db-pg 초기화 체인의 runMigrations 와 동시에 같은 테이블에
 *     CREATE TABLE IF NOT EXISTS 를 던져 pg_type duplicate key 를 낼 수 있다.
 *   - 아직 writer 가 없으므로 이 모듈은 호출되지 않는다(휴면). P1 에서 writer 와 함께 배선한다.
 *
 * 사용:
 *   const { ensureOwnerTwinTables } = require('./src/owner-signal/schema');
 *   await ensureOwnerTwinTables(pool);   // 멱등
 */
const fs = require('fs');
const path = require('path');

const SQL_PATH = path.join(__dirname, '..', '..', 'migrations', '0015_owner_twin.sql');

let _done = null;

/**
 * @param {import('pg').Pool|null} pool  PostgreSQL pool. null 이거나 .query 가 없으면 no-op.
 * @returns {Promise<boolean>} 실제로 DDL 을 실행했으면 true
 */
async function ensureOwnerTwinTables(pool) {
  if (!pool || typeof pool.query !== 'function') return false;   // SQLite 모드에서는 아무것도 하지 않는다
  if (_done) return _done;                                        // 프로세스당 1회
  _done = (async () => {
    const sql = fs.readFileSync(SQL_PATH, 'utf8');
    await pool.query(sql);
    return true;
  })().catch(e => {
    _done = null;                                                 // 실패하면 다음 진입에서 다시 시도
    throw e;
  });
  return _done;
}

module.exports = { ensureOwnerTwinTables, SQL_PATH };
