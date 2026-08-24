-- 0015_owner_twin.sql
-- Owner Twin Layer: 사장님 본인에게서 나온 신호(owner_signal)와
-- 거기서 추론된 원칙(owner_belief). OWNER_TWIN_SPEC.md §1 참조.
--
-- 설계 근거
--  · 기존 orbit_entity_golden / ops_relation 의 규약(출처·신뢰도·근거)을 그대로 물려받는다.
--  · outcome + edit_distance = 사용자 수정에서 선호를 역추론하는 신호 (PRELUDE/CIPHER, NeurIPS 2024).
--  · valid_from / valid_to = 선호는 변한다. 시간 유효구간을 1급으로 둔다.
--  · status 는 candidate → active 로 사람 승인 없이 넘어가지 않는다(approved_by 필수).
--
-- 이 마이그레이션은 순수 추가(additive)다. 기존 테이블을 변경하거나 데이터를 건드리지 않는다.
--
-- ⚠ 이 파일을 mindmap-viewer/migrations/ 로 옮기는 순간 다음 서버 부팅·재배포에서 자동 적용된다
--   (server.js:9202 / src/db-pg.js:32, 배포 파이프라인에 별도 migrate 단계 없음). 사람 승인 전까지 저장소 밖에 둔다.
-- ⚠ 런타임 ensure 는 이 파일을 읽어 실행한다 — DDL 두 벌을 손으로 유지하지 않는다.
--   (0012에서 workspace_id DEFAULT가 갈려 0013 ALTER로 뒷수습한 전례)

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) owner_signal — 나에게서 나온 모든 신호의 단일 표준
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS owner_signal (
  id            TEXT PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL,
  source        TEXT NOT NULL,                  -- 'claude' | 'kakao' | 'orbit' | 'erp'
  channel       TEXT,                           -- 세션id / 채팅방 / 호스트명
  kind          TEXT NOT NULL,                  -- instruction | correction | decision | preference
                                                -- | prohibition | question | approval | rejection | context
  subject       TEXT,                           -- belief 의 소환 범위(scope) 기준이 된다
  text_raw      TEXT NOT NULL,                  -- 원문 불변
  text_norm     TEXT,
  context_ref   TEXT,                           -- 무엇에 대한 반응인가 (없으면 선호 추론 불가)
  outcome       TEXT NOT NULL DEFAULT 'unknown',-- accepted | edited | reverted | abandoned | unknown
  edit_distance INT,                            -- 내가 고친 양 (측정 불가하면 NULL, 추정 금지)
  latency_sec   INT,
  confidence    NUMERIC(4,3) NOT NULL DEFAULT 0.5,
  evidence      JSONB NOT NULL DEFAULT '{}',
  workspace_id  TEXT NOT NULL DEFAULT 'WS-NENOVA-2026',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT owner_signal_kind_chk CHECK (kind IN
    ('instruction','correction','decision','preference','prohibition','question','approval','rejection','context')),
  CONSTRAINT owner_signal_outcome_chk CHECK (outcome IN
    ('accepted','edited','reverted','abandoned','unknown'))
);

CREATE INDEX IF NOT EXISTS idx_osig_ts        ON owner_signal(ts DESC);
CREATE INDEX IF NOT EXISTS idx_osig_kind      ON owner_signal(kind);
CREATE INDEX IF NOT EXISTS idx_osig_subject   ON owner_signal(subject);
CREATE INDEX IF NOT EXISTS idx_osig_source    ON owner_signal(source);
CREATE INDEX IF NOT EXISTS idx_osig_outcome   ON owner_signal(outcome);
CREATE INDEX IF NOT EXISTS idx_osig_workspace ON owner_signal(workspace_id);
CREATE INDEX IF NOT EXISTS idx_osig_ev_gin    ON owner_signal USING GIN (evidence);

-- 선호 추론에 실제로 쓸 수 있는 신호만 빠르게 뽑기 위한 부분 인덱스
CREATE INDEX IF NOT EXISTS idx_osig_learnable ON owner_signal(subject, ts DESC)
  WHERE outcome <> 'unknown' AND kind <> 'context';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) owner_belief — 추론된 원칙 (= 기계가 갱신하는 헌법)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS owner_belief (
  id               TEXT PRIMARY KEY,
  statement        TEXT NOT NULL,                 -- 한 줄 원칙
  scope            TEXT NOT NULL,                 -- 소환 트리거(정규식 또는 subject 키)
  polarity         TEXT NOT NULL DEFAULT 'pursue',-- pursue | avoid
  strength         NUMERIC(4,3) NOT NULL DEFAULT 0.5,
  support_count    INT NOT NULL DEFAULT 0,
  contradict_count INT NOT NULL DEFAULT 0,
  confidence       NUMERIC(4,3) NOT NULL DEFAULT 0.34,  -- 1근거=0.34 / 2=0.67 / 3+=1.0
  valid_from       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to         TIMESTAMPTZ,                   -- 폐기해도 행은 남긴다(왜 폐기됐는지가 다음 재료)
  derived_from     JSONB NOT NULL DEFAULT '[]',   -- owner_signal id 목록
  status           TEXT NOT NULL DEFAULT 'candidate',
  approved_by      TEXT,                          -- 사람 승인자. 없으면 active 가 될 수 없다.
  hit_count        INT NOT NULL DEFAULT 0,        -- 실제 소환 횟수 (0이면 scope 오류 또는 불필요)
  last_hit_at      TIMESTAMPTZ,
  workspace_id     TEXT NOT NULL DEFAULT 'WS-NENOVA-2026',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT owner_belief_polarity_chk CHECK (polarity IN ('pursue','avoid')),
  CONSTRAINT owner_belief_status_chk   CHECK (status IN ('candidate','active','retired')),
  -- 자동 승격 금지: active 는 승인자가 있어야만 성립한다.
  CONSTRAINT owner_belief_approval_chk CHECK (status <> 'active' OR approved_by IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_obel_status ON owner_belief(status);
CREATE INDEX IF NOT EXISTS idx_obel_scope  ON owner_belief(scope);
CREATE INDEX IF NOT EXISTS idx_obel_active ON owner_belief(scope)
  WHERE status = 'active' AND valid_to IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) 소환 로그 — belief 가 실제로 쓰였는지 측정한다(사멸률 지표의 근거)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS owner_belief_hit (
  id          BIGSERIAL PRIMARY KEY,
  belief_id   TEXT REFERENCES owner_belief(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  context     TEXT,                              -- 어떤 지시에 소환됐나(앞 120자)
  helped      BOOLEAN,                           -- 이후 마찰이 없었는가 (사후 채움)
  signal_id   TEXT                               -- 그 지시에 대응하는 owner_signal
);
CREATE INDEX IF NOT EXISTS idx_obhit_belief ON owner_belief_hit(belief_id, ts DESC);
