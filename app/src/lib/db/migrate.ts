// app/src/lib/db/migrate.ts
//
// ───────────────── ⚠️ 改本文件之前先读这一段 ⚠️ ─────────────────
// **本迁移框架没有事务。** runMigrations() 的 53 个 db.exec() 是一串裸调用，
// 中途失败不回滚——2026-08-26 实测：人为中断，库里留下 22/38 张表，重跑既不前进也不后退。
// 现在之所以能安全滚更，是因为迁移**全是纯加法**、靠 IF NOT EXISTS 与 addColumnIfMissing
// 能重跑自愈：**安全是「改动足够简单」给的，不是框架给的。**
//
//   ✅ 新增表：照下面的现有写法 `CREATE TABLE IF NOT EXISTS` 直接加，不用问谁。
//   ✅ 新增列：**走 `addColumnIfMissing(db, 表, 列, DDL)`**，不用问谁；但**不要裸 `db.exec`
//      写 `ALTER TABLE ... ADD COLUMN`**——SQLite 的 ADD COLUMN **没有 IF NOT EXISTS**
//      （写了报 `near "EXISTS": syntax error`），裸写的那条第二次跑就报
//      `duplicate column name`，runMigrations 抛错 ⇒ **应用直接起不来**。
//      addColumnIfMissing 先 PRAGMA table_info 判断列在不在、不在才加，所以可重跑。
//   ⛔ 改列类型、数据回填、拆表、加 NOT NULL 无默认值，以及任何不能靠 IF NOT EXISTS
//      幂等的改动：**先找数据表管理（WS1）**，等事务化改造（外层 db.transaction() +
//      PRAGMA user_version + 每步版本守卫）落地再动手。在那之前，这类迁移一旦中断，
//      留下的就是一个重跑也修不好的生产库——只能人肉修，且修的是线上真实用户的案件档案。
//
// 这不是一句劝告：上面这条**由 __tests__/migrate-idempotency-guard.test.ts 机检**，
// 违规写法会让 npm test 当场变红，并报出行号、原文与拦它的理由。
// ─────────────────────────────────────────────────────────────
//
// lawer 数据层第一阶段：全量表结构。一律 CREATE TABLE / INDEX IF NOT EXISTS，
// 建表段之后是「存量迁移区」（见文件末尾）：已上线的库补列走 addColumnIfMissing，
// 不回填、不改数据——本文件反复执行必须幂等且无副作用。
// 通用约定：id 一律 INTEGER PRIMARY KEY AUTOINCREMENT；created_at TEXT DEFAULT (datetime('now'))；
// 布尔用 INTEGER 0/1；金额单位「分」（*_fen）；外键全部显式 REFERENCES（client 恒开 foreign_keys=ON）。
import type Database from 'better-sqlite3';

import { seedModelRates } from './modelRates';

/** SQLite ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS；用 PRAGMA table_info 判断后跳过。 */
function addColumnIfMissing(db: Database.Database, table: string, col: string, ddl: string): void {
  type ColRow = { name: string };
  const exists = (db.prepare(`PRAGMA table_info(${table})`).all() as ColRow[]).some((r) => r.name === col);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

export function runMigrations(db: Database.Database): void {
  // ───────────────── 用户与实名 ─────────────────
  // 敏感字段只以密文列落库（lib/crypto 铁律）：phone_enc / real_name_enc / id_card_enc 无明文对应列。
  // 手机号需等值查询（登录/OTP），密文不可检索 → 另存 phone_hash（带密钥 HMAC）作唯一查询键。
  // phone/email 均可为空（两种注册路径任一即可成号），故唯一约束用部分索引仅约束非空值。
  // auth_status 是实名闸门：签发文书、证据出证等强身份动作要求 '已实名'。
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_enc          TEXT,
      phone_hash         TEXT,
      email              TEXT,
      email_verified_at  TEXT,
      phone_verified_at  TEXT,
      real_name_enc      TEXT,
      id_card_enc        TEXT,
      auth_status        TEXT NOT NULL DEFAULT '未认证',   -- 未认证 | 待审 | 已实名
      notify_verbose     INTEGER NOT NULL DEFAULT 0,       -- 通知详细模式：0=中性文案（防他人代收泄露案情），1=用户明确开启后带案件细节
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone_hash
      ON users (phone_hash) WHERE phone_hash IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email
      ON users (email) WHERE email IS NOT NULL;
  `);

  // 短信 OTP。铁律：本表不存手机明文，只存 phone_hash（与 users.phone_hash 同一算法，可直接对齐）。
  // used/attempts 防重放与暴力枚举；查码按 (phone_hash, id DESC) 取最近一条。
  db.exec(`
    CREATE TABLE IF NOT EXISTS sms_codes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_hash TEXT NOT NULL,
      code       TEXT NOT NULL,
      purpose    TEXT NOT NULL DEFAULT 'login',
      expires_at TEXT NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0,
      attempts   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sms_codes_phone ON sms_codes (phone_hash, id DESC);
  `);

  // 邮箱 OTP。邮箱非敏感字段（users.email 亦为明文），故直存；限流字段语义同 sms_codes。
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_codes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT NOT NULL,
      code       TEXT NOT NULL,
      purpose    TEXT NOT NULL DEFAULT 'verify',
      expires_at TEXT NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0,
      attempts   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes (email, id DESC);
  `);

  // 发码的 IP 维度限流流水（OTP 三条限流里的第三条，判定与常量见 lib/auth/ip-quota.ts）。
  // 一次发码一行，判定 = COUNT(该 ip 24h 内的行)。**必须落库，不能是进程内 Map**：
  // 进程内计数重启即清零、多实例之间互不可见，那等于限流在最需要它的时候（被刷爆、
  // 服务频繁重启）恰好失效；而这张表还要在未来多副本部署下继续是同一份真值。
  //
  // 不存 user_id / phone_hash：本表只回答「这个出口 IP 最近发了多少次」，
  // 多存一列就是把手机号与 IP 关联落盘，限流不需要，隐私上也不该留。
  // 无 id 列（本表不遵循「id 一律 AUTOINCREMENT」的通用约定）：没有任何行会被单独引用、
  // 更新或删除，删只按 (ip, created_at) 批量删，rowid 已经够用。
  // 旧行靠写入侧的机会式 GC 清（见 lib/db/ip-quota.ts），不设定时任务——
  // 加一个必须有人盯着才不腐坏的 cron，代价高于顺手多跑一条 DELETE。
  db.exec(`
    CREATE TABLE IF NOT EXISTS ip_quota_events (
      ip         TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ip_quota_events_ip ON ip_quota_events (ip, created_at);
  `);

  // 发码的「≤5 秒防连击闸」流水（判定与常量见 lib/auth/otp.ts 的 SEND_BURST_SECONDS）。
  // ⚠️ 本表依 ADR-003（已接受 A 案）保留。
  // 一次**真正开始发送**一行，判定 = 该 target 5 秒内有没有行。
  //
  // 【为什么不能复用 sms_codes / email_codes 的行】那两张表的行是「用户手上有这串码」的凭据，
  // 通道确认发不出去时必须撤掉（F-204：失败不占 60s 冷却与当日额度）——而防连击要拦的
  // 恰恰就是「上一次发失败、行已经撤掉」之后的那一秒。同一份记录不能既撤又留，所以另开一张：
  // 这张只回答「刚刚是不是已经在发了」，与额度账本无关，因此发失败也照记不退。
  //
  // 【为什么不能是进程内 Map】理由与 ip_quota_events 逐字相同：重启清零、多副本互不可见。
  // target 存 'sms:<phone_hash>' / 'email:<邮箱>'：与两条通道各自的限流键一致（手机号只留哈希，
  // 邮箱本就明文存于 email_codes），一张表管两侧，判据不会只在一侧生效。
  // 无 id 列、旧行靠写入侧机会式 GC 清，两点都同 ip_quota_events。
  db.exec(`
    CREATE TABLE IF NOT EXISTS otp_send_attempts (
      target     TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_otp_send_attempts_target
      ON otp_send_attempts (target, created_at);
  `);

  // 实名核验流水：一次核验一行，只追加（用户改名/换证 = 新一行），users.auth_status 为其物化结论。
  // raw_meta_enc = 三方核验原始报文密文（含姓名身份证，争议时可回溯，故不得明文落库）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS realname_verifications (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id),
      provider     TEXT NOT NULL,                        -- cloudauth | eid | manual
      cert_no      TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      raw_meta_enc TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_realname_verifications_user
      ON realname_verifications (user_id, id);
  `);

  // 开放 API/MCP 凭据：只存 key_hash，明文密钥仅在签发那一刻返回一次。
  // scopes = JSON 数组（授权范围），enabled=0 即吊销（不删行，保留审计）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id),
      name         TEXT NOT NULL,
      key_hash     TEXT NOT NULL UNIQUE,
      scopes       TEXT,                                 -- JSON 数组
      last_used_at TEXT,
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ───────────────── 案件档案（心脏）─────────────────
  // 一个用户可有多个案件（换公司/多主体）。stage 为案件在维权流程上的位置，驱动首页该做什么、
  // 期限怎么算；goal/bottom_line 是用户自述的目标与底线，谈判与文书全程锚定它俩不漂移。
  // 全部 case 子表 ON DELETE CASCADE：删案即连根删档（用户注销/主动销案），不留孤儿证据。
  db.exec(`
    CREATE TABLE IF NOT EXISTS cases (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      title       TEXT NOT NULL,
      stage       TEXT NOT NULL DEFAULT '风声',           -- 风声|约谈中|已收通知|已解除|仲裁准备|已立案|开庭|裁决|一审|二审|执行|结案
      district    TEXT NOT NULL DEFAULT '朝阳',
      goal        TEXT,
      bottom_line TEXT,
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cases_user ON cases (user_id, id);
  `);

  // agent 写入台账：既是**幂等索引**也是**审计**（MCP 设计稿 §4.1 / §5）。
  //
  // 【为什么幂等要有一张独立的表】此前只有 timeline_events 自己带 client_ref 列，
  // 每加一个写工具就得给它那张目标表再加一列 + 一条部分唯一索引——独立写 N 次就会忘 N 次，
  // 而忘掉的形态是「重试一次，档案里多一条」，返回 200、格式完全正常。
  // 这张表把「同案 + 同工具 + 同 client_ref 只算一次」收成**一个入口**（lib/capabilities/idempotent）。
  //
  // target_table / target_id 是**弱引用**（不设外键）：目标可能是任意一张业务表，
  // 而 SQLite 的外键只能指一张。读回来时按 target_table 分派，取不到就是取不到——
  // 不给它编一个存在的目标。
  //
  // key_id 可空：走网页登录态（JWT）的写入没有 key。指向 api_keys(id) 不带级联，
  // 因为吊销 key 走的是 `enabled = 0` 软删（lib/db/api-keys.ts），表里那行不会消失；
  // 真删了行就该拦住——审计记录不能因为吊销一把钥匙而凭空少掉。
  //
  // deduped 记的是**这一次调用**有没有命中既有记录（1 = 命中重放）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_writes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id      INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      key_id       INTEGER REFERENCES api_keys(id),
      tool         TEXT NOT NULL,
      client_ref   TEXT,
      target_table TEXT NOT NULL,
      target_id    INTEGER NOT NULL,
      deduped      INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- 部分唯一索引：只约束带 client_ref 的行。不带 ref 的写入靠各自的自然键去重，
    -- 若这里连 NULL 一起约束，同案同工具的第二次无 ref 写入会被误判成重复。
    CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_writes_client_ref
      ON agent_writes (case_id, tool, client_ref) WHERE client_ref IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_agent_writes_case ON agent_writes (case_id, id);
  `);

  // 公司背调档案：一案可挂多个主体（签约主体 ≠ 用工主体 ≠ 关联公司，仲裁列谁为被申请人由此判定）。
  // sources_json = 每条结论的来源出处（企查口径可变，须可溯源）；investigated_at 记调查时点。
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_profiles (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id         INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      name            TEXT NOT NULL,
      uscc            TEXT,
      role            TEXT NOT NULL DEFAULT '签约主体',    -- 签约主体 | 用工主体 | 关联
      reg_capital     TEXT,
      legal_rep       TEXT,
      risk_notes      TEXT,
      sources_json    TEXT,
      investigated_at TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_company_profiles_case ON company_profiles (case_id);
  `);

  // 案件时间线：只追加不修改。事实记错了用一条新事件修正，绝不改旧行——
  // 时间线是仲裁陈述与举证的骨架，可改即等于可篡改，庭上无法自证。
  // evidence_ids_json = 支撑该事件的证据 id 数组（弱引用，证据删除不牵动时间线）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS timeline_events (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id           INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      happened_at       TEXT NOT NULL,
      kind              TEXT NOT NULL,                    -- 公司动作 | 我方动作 | 系统动作 | 期限
      title             TEXT NOT NULL,
      detail            TEXT,
      evidence_ids_json TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_events_case
      ON timeline_events (case_id, happened_at);
  `);

  // 物理文件登记：按 sha256 去重（同一份文件多处引用只存一份），落盘一律加密（enc_path 指密文文件）。
  // 无 case_id/user_id：文件是内容寻址的裸资源，归属由引用它的 evidence/company_docs/attestations 决定。
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      sha256     TEXT NOT NULL UNIQUE,
      size       INTEGER NOT NULL,
      mime       TEXT,
      enc_path   TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 证据条目：一条证据 = 一个文件 + 一份证明目的。prove_purpose（证明什么）与 original_medium
  // （原件形态：微信/邮件/纸质/录音…）是证据清单必填项，仲裁质证按此逐条对答。
  // user_id 冗余（案件属主同步）供归属校验；status 随固化/出证推进。
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id         INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      file_id         INTEGER NOT NULL REFERENCES files(id),
      name            TEXT NOT NULL,
      category        TEXT NOT NULL DEFAULT '其他',        -- 合同|工资|社保|考勤|沟通记录|公司文件|录音|其他
      prove_purpose   TEXT,
      original_medium TEXT,
      status          TEXT NOT NULL DEFAULT '已上传',       -- 已上传 | 已固化 | 已出证
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_case ON evidence (case_id, id);
  `);

  // 存证订单：只追加不修改（钱和证据零妥协）。order_no 唯一 = 幂等键，重复下单不重复扣费。
  // tsa_* 为可信时间戳应答的原样留存（tst_b64 是唯一可对外校验的凭据，务必原文保存不加工）；
  // user_realname_snapshot_enc 冻结出证时点的实名信息密文——用户日后改名不改已出的证书。
  // evidence_id ON DELETE SET NULL：证据可删、证不消失，且不挡删案（cases→evidence 级联时本表断链留存）。
  // 存证记录自含（sha256 + order_no + 实名快照 + TSA 应答），断链后 /verify/:no 校验不受影响。
  db.exec(`
    CREATE TABLE IF NOT EXISTS attestations (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      evidence_id                 INTEGER REFERENCES evidence(id) ON DELETE SET NULL,
      order_no                    TEXT NOT NULL UNIQUE,
      user_realname_snapshot_enc  TEXT,
      sha256                      TEXT NOT NULL,
      tsa_tst_b64                 TEXT,
      tsa_gen_time                TEXT,
      tsa_serial                  TEXT,
      tsa_url                     TEXT,
      cert_pdf_file_id            INTEGER REFERENCES files(id),
      status                      TEXT NOT NULL DEFAULT 'pending',
      created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_attestations_evidence ON attestations (evidence_id);
  `);

  // 公司发来的文件解读：OCR 文本 + 风险点 + 「签不签」结论。advice 是给用户的一句话决断
  // （签|不签|改签|待定），advice_detail 讲清代价与替代方案——用户拿到解除通知的那一刻只想知道这个。
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_docs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id        INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      file_id        INTEGER NOT NULL REFERENCES files(id),
      ocr_text       TEXT,
      doc_type       TEXT,                                 -- 解除通知|协商协议|调岗通知|PIP|警告|其他
      risk_flags_json TEXT,
      advice         TEXT,                                 -- 签 | 不签 | 改签 | 待定
      advice_detail  TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_company_docs_case ON company_docs (case_id, id);
  `);

  // 合同/文件审查记录：一次 AI 审查落一行（company_docs 是被审文件，本表是审查产物的头）。
  // 与 company_docs 分表而非并列加列：同一份文件可被反复审（换模型/规则库更新后重跑），
  // 每次审查各自成行才留得住历史结论；summary 是这次审查的整体判断，逐条问题在 review_findings。
  // case_id 冗余（可经 company_docs 推出）：报告页按案件列全部审查记录，是热路径，免一次 JOIN。
  db.exec(`
    CREATE TABLE IF NOT EXISTS contract_reviews (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      company_doc_id  INTEGER NOT NULL REFERENCES company_docs(id) ON DELETE CASCADE,
      case_id         INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      contract_type   TEXT,
      model           TEXT,
      reviewed_at     TEXT,
      summary         TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_contract_reviews_case ON contract_reviews (case_id);
  `);

  // 逐条审查发现：一条问题条款一行，坑分三级（must 大坑必修 / strong 中坑强烈修 / suggest 小坑建议修）。
  // severity/status 只在注释里锁枚举、不加 CHECK（沿 intake_stage 裁决：SQLite 改 CHECK 要重建表）。
  // status 是**用户侧**的谈判进度：只有用户/agent 工具可改，审查管线重跑一律新写 contract_reviews
  // 而不回写本列——用户标了「已提出」的条目不得被下一次自动审查抹回「待处理」。
  // rule_id 可空：命中规则库时回指规则 id（knowledge 的 review-rules 域），纯 LLM 发现的坑留 NULL。
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_findings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id       INTEGER NOT NULL REFERENCES contract_reviews(id) ON DELETE CASCADE,
      clause_ref      TEXT,
      severity        TEXT NOT NULL,                        -- must | strong | suggest
      issue           TEXT,
      basis           TEXT,
      suggestion      TEXT,
      negotiation_tip TEXT,
      status          TEXT NOT NULL DEFAULT '待处理',        -- 待处理 | 已提出 | 已修改 | 接受风险
      rule_id         TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_review_findings_review
      ON review_findings (review_id, severity);
  `);

  // 请求项（仲裁申请书的「请求事项」逐条）：kind 为诉求类型，amount_fen 为金额（分），
  // calc_json 存算式与输入（工资基数/工龄/上限…）以便当庭复算，basis 存法条依据。
  db.exec(`
    CREATE TABLE IF NOT EXISTS claims (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id    INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,                            -- 2N|N|N+1|欠薪|年假|加班费|双倍工资|年终奖|竞业补偿|其他
      amount_fen INTEGER NOT NULL DEFAULT 0,
      calc_json  TEXT,
      basis      TEXT,
      status     TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_claims_case ON claims (case_id);
  `);

  // 待办事项：陪跑给出的下一步动作清单。source_message_id 回指产生该待办的那条对话消息，
  // 便于用户追问「这条为什么要做」。表按 (case_id, status) 取未完成项，是首页热路径。
  // source_message_id ON DELETE SET NULL：删案时 threads→messages 与 action_items 两路级联
  // 顺序不保证，messages 先删不得让尚存的 action_items 触发 FK 报错（级联顺序陷阱）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS action_items (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id           INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      title             TEXT NOT NULL,
      detail            TEXT,
      due_at            TEXT,
      priority          INTEGER NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT '待办',        -- 待办 | 完成 | 放弃
      source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_action_items_case ON action_items (case_id, status);
  `);

  // 法定期限：错过即权利灭失，本表是整个产品最不能出错的地方。
  // derived_from 记推算依据（如「解除日 2026-08-01 + 1 年」），用户可自查系统算得对不对；
  // notified_stages_json 记已发过哪几档提醒（30/7/3/1 天…），防重复轰炸也防漏提醒。
  // resolved_at = 退出态：期限被履行/作废（如 15 日内已起诉）即置时间戳停止提醒，NULL=生效中。
  // idx_deadlines_due 只盖生效中的期限——提醒 cron 的热路径按到期时间全表扫，已处理行不进索引。
  //
  // **惰性语义：due_at 过期不翻任何字段**——库侧不设触发器、不设定时任务。「已到期」是**读时判定**
  //（due_at <= datetime('now') AND resolved_at IS NULL），不是某个字段会变成某个值。
  // 所以「due_at 已过 且 resolved_at IS NULL」是**用户还没行动时的正常状态**，不是提醒系统故障；
  // 把它当故障会造出一整族假告警，而这张表的假告警成本特别高——用户要么被假警吓到，
  // 要么对真警脱敏，而这里的真警是「错过即权利灭失」。
  // 提醒**是否真的发出去了**看 notify_log（逐条），**提醒任务这一轮有没有跑起来**看 job_runs（运行粒度）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS deadlines (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id              INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      kind                 TEXT NOT NULL,                   -- 仲裁时效|起诉15日|上诉15日|举证期限|开庭|申请执行2年|答辩期|自定义
      due_at               TEXT NOT NULL,
      derived_from         TEXT,
      notified_stages_json TEXT,
      resolved_at          TEXT,                            -- NULL=生效中；非空=已履行/作废，停止提醒
      created_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_deadlines_case ON deadlines (case_id, due_at);
    CREATE INDEX IF NOT EXISTS idx_deadlines_due ON deadlines (due_at) WHERE resolved_at IS NULL;
  `);

  // 对话会话：一案多线程，mode 决定人格与工具集（问诊 / 陪跑 / 文书 / 录音分析）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id    INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      mode       TEXT NOT NULL,                             -- 问诊 | 陪跑 | 文书 | 录音分析
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 对话消息：user 行 content 恒有（问句）；assistant 行 content 由模型完成后回写，
  // NULL = 生成中/中断——这是断线恢复的判定位（无 content 即重连续跑，非空即回放）。
  // **终态失败**不留在 NULL 上：它回填三段式失败文案 + failed_code（见存量迁移区），
  // 否则刷新后这一轮连同"没答上"这件事一起消失。
  // tokens_json 记本轮用量明细，供 token_usage 计费对账。
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id   INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role        TEXT NOT NULL,
      content     TEXT,
      model       TEXT,
      tokens_json TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id, id);
  `);

  // 情绪记录：裁员维权是长期消耗战，本表按时间看用户状态走向。
  // referred_nbdpsy=1 表示已转介心理咨询（严重档兜底动作，只转介不诊断）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS emotion_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id         INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      level           TEXT NOT NULL,                        -- 平稳 | 低落 | 焦虑 | 严重
      note            TEXT,
      referred_nbdpsy INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_emotion_log_case ON emotion_log (case_id, id);
  `);

  // 品牌推荐台账 + 频控闸门（spec D14）：本站是 NBDpsy 体系的分支，会在案件关键节点与情绪场景
  // 主动推荐心理咨询。这张表管的就是「推了几次、谁说过不要」。五条产品语义，改本表前先读完：
  //
  // 1) 只追加不修改：推了落一行 offered、用户拒绝落一行 declined、用户去咨询了落一行 accepted，
  //    永不 UPDATE 旧行。这张表将来可能要用来证明「我们没有反复骚扰用户」——它本身就是那份证据，
  //    改写过的台账不成其为证据。
  // 2) 拒绝全局永久生效：declined 按 user_id 查，跨案件、跨场景、**不设 TTL**。一个明确说过
  //    「不需要」的人，若三个月后又被问一次，他会读出「这个系统在等我改变主意」——那比第一次
  //    推销伤害更大。所以没有过期时间，也不按案件重置。
  // 3) 五个可推位点各一次：四个案件节点（收到裁员通知 / 立案后 / 开庭前 / 拿到结果后）与情绪场景
  //    并列为 scene，各只推一次。情绪场景是状态不是时点、会反复触发，不设限就等于反复推。
  //    幂等靠 uq_referral_offer_scene（只约束 offered 态；declined/accepted 可多行）——同
  //    notify_log 只约束 sent 的范式。索引键取 COALESCE(case_id, 0) 而非 case_id 裸列：
  //    SQLite 唯一索引视 NULL 互不相等，裸列版在 case_id 为空时根本挡不住重复。
  //    **0 是安全哨兵**：case_id 指向 AUTOINCREMENT 主键，真实值恒 ≥1，不可能与哨兵撞。
  //    为什么不靠「调用方记得传 caseId」：情绪场景恰恰是最可能不挂案件的那个位点，
  //    而它正是「状态不是时点、会反复触发」这条要防的重点；把约定变成约束的成本只是一个
  //    COALESCE，漏传的代价却是用户被反复推——规范的可执行性取决于遵守它的成本。
  // 4) case_id 绝不 CASCADE：随案级联删会让用户销案后「拒绝记录消失、又被推一遍」。
  //    **拒绝记录必须比案件活得久**，故可空 + ON DELETE SET NULL。
  // 5) 「拒绝」约束的是我们**主动推**的动作，不约束用户自己来找：页脚/关于页常驻入口对所有人
  //    始终可见；declined 之后 agent 不再主动提，但**用户主动问「你们有心理咨询吗」时照常正常
  //    回答并给入口，这不算违反频控**；用户主动咨询后成交记 accepted，不算「频控被绕过」。
  //    **拒绝的是被推销，不是拒绝服务**——若把它实现成「拒绝过的人连问都问不到」，
  //    就从克制变成了赌气。
  //
  // 另注：D15 危机轮禁令（识别到自杀念头/严重心理危机的轮次只给免费热线、不得出现任何付费信息）
  // 是**当轮即时判定**，不落本表，由 lib/agent 层判——本表管的是跨轮次的频控，别把危机轮塞进来。
  db.exec(`
    CREATE TABLE IF NOT EXISTS referral_offers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      case_id    INTEGER REFERENCES cases(id) ON DELETE SET NULL,
      scene      TEXT NOT NULL,                             -- 收到裁员通知 | 立案后 | 开庭前 | 拿到结果后 | 情绪场景
      outcome    TEXT NOT NULL,                             -- offered | declined | accepted
      thread_id  INTEGER REFERENCES threads(id) ON DELETE SET NULL,  -- 回指发生推荐的那轮对话，便于审计「当时怎么说的」
      note       TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_offer_scene
      ON referral_offers (user_id, COALESCE(case_id, 0), scene)
      WHERE outcome = 'offered';
    CREATE INDEX IF NOT EXISTS idx_referral_offers_user ON referral_offers (user_id, id DESC);
  `);

  // 分享链接：把档案给亲友/工会/律师看的免登录入口。token 唯一即访问凭据，
  // 必须有 expires_at（不设永久链），revoked_at 非空即提前失效（撤销不删行，保留审计）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS share_links (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id    INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      token      TEXT NOT NULL UNIQUE,
      scope      TEXT NOT NULL DEFAULT '档案只读',           -- 档案只读 | 单文件下载
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 文书草稿：version 随每次改稿递增（同 kind 同 title 多版并存，用户可回看上一版措辞）。
  // send_consequences = 发出后果说明（对外文书必填，charter 红线 5）。正文里那段固定尾注是
  // 给用户看的渲染结果，这一列是给读接口用的结构化原文——只留尾注的话，draft_get 想单独把
  // 「发出后会怎样」取出来就只能去正文里做字符串切割，而尾注措辞是会改的。
  // based_on = 这一稿是在哪一稿基础上改的（弱引用，被引的旧稿删了不牵动本行）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS drafts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id           INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      kind              TEXT NOT NULL,                      -- 异议函|被迫解除通知|仲裁申请书|证据清单|答辩状|上诉状|谈判话术|其他
      title             TEXT NOT NULL,
      content           TEXT,
      send_consequences TEXT,
      based_on          INTEGER,
      version           INTEGER NOT NULL DEFAULT 1,
      status            TEXT NOT NULL DEFAULT 'draft',
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_case ON drafts (case_id, id);
  `);

  // ───────────────── 公道值计费（钱的地基）─────────────────
  // 三铁律：
  //   ① 账本唯一事实源 —— gongdao_ledger 是余额的唯一真相，任何加减必先落一条流水；
  //   ② 物化余额 —— gongdao.balance 只是流水的物化缓存，对不上时以流水重算为准；
  //   ③ 幂等 —— 全部写入走 uq_gongdao_ledger_ref 部分唯一索引 + INSERT OR IGNORE + changes 守卫，
  //      同一 (type, ref_id) 绝不双记；ref_id 为 NULL 表示本条不参与去重（允许多行）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS gongdao (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      balance INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS gongdao_ledger (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      delta      INTEGER NOT NULL,
      type       TEXT NOT NULL,        -- 会员额度|充值|兑换|消耗|注册赠送|管理员调整|失败核销|退款
      ref_id     TEXT,                 -- 幂等键（订单号/兑换码…）；NULL=不去重
      feature    TEXT,                 -- 消耗类记来源功能（问诊|文书|录音|存证…），其余 NULL
      meta_json  TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_gongdao_ledger_ref
      ON gongdao_ledger (type, ref_id)
      WHERE ref_id IS NOT NULL;
    -- 公道值预检热路径：按 feature 取最近消耗流水估本次开销（部分索引仅覆盖消耗类）。
    CREATE INDEX IF NOT EXISTS idx_gongdao_ledger_feature
      ON gongdao_ledger (feature, id DESC)
      WHERE type = '消耗';
    -- 「我的」页热路径：listGongdaoLedger 每次访问打两条 WHERE user_id=? —— 流水分页
    -- （ORDER BY id DESC LIMIT）与账本合计 SUM(delta)。本表只追加不删，是全库增长最快的一张；
    -- 无索引时这两条都是全表 SCAN，代价随**全站**流水总量线性涨，人越多越慢直至拖垮。
    -- 建成 (user_id, id DESC) 后二者都降为 SEARCH，代价只随**该用户自己**的行数走。
    -- 排序键写进索引（而不是只索引 user_id）是为了让分页那条直接沿索引倒序取前 N 行，
    -- 免掉 ORDER BY 的临时 B 树。**不是**部分索引：合计要覆盖全部 type，漏一行余额就对不上。
    CREATE INDEX IF NOT EXISTS idx_gongdao_ledger_user
      ON gongdao_ledger (user_id, id DESC);
  `);

  // 会员：expires_at 为准判在期与否。order_no 部分唯一索引保证同一支付订单不重复开通
  // （赠送/后台开通无订单号，故允许多 NULL）。plan 枚举为草案，待 M3 核定。
  db.exec(`
    CREATE TABLE IF NOT EXISTS memberships (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      plan       TEXT NOT NULL,                             -- entry | standard | pro（草案，待 M3 核定）
      order_no   TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_memberships_order
      ON memberships (order_no) WHERE order_no IS NOT NULL;
  `);

  // 售卖档位。种子数据不在本文件（SKU 语义归 billing 的 ensureBillingSkus），此处只建结构。
  db.exec(`
    CREATE TABLE IF NOT EXISTS skus (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name      TEXT NOT NULL,
      gongdao   INTEGER NOT NULL,
      price_fen INTEGER NOT NULL,
      enabled   INTEGER NOT NULL DEFAULT 1
    );
  `);

  // 支付订单：order_no 唯一即幂等键，回调重放不重复入账（入账动作另受 ledger 幂等索引二次保护）。
  // gongdao 列冻结下单时点的档位面值（SKU 日后调价不影响历史订单）；credited_at 非空即已入账。
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no    TEXT NOT NULL UNIQUE,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      sku_id      INTEGER NOT NULL REFERENCES skus(id),
      amount_fen  INTEGER NOT NULL,
      gongdao     INTEGER NOT NULL,
      channel     TEXT NOT NULL DEFAULT 'alipay',
      status      TEXT NOT NULL DEFAULT 'pending',
      pay_url     TEXT,
      trade_no    TEXT,                                     -- 渠道交易号（支付宝/微信通用）
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      expired_at  TEXT,
      credited_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id, id DESC);
  `);

  // 兑换码：一码一次，redeemed_by/redeemed_at 非空即已用（不删行，保留发放与核销审计）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS redemption_codes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      code          TEXT NOT NULL UNIQUE,
      gongdao_value INTEGER NOT NULL,
      enabled       INTEGER NOT NULL DEFAULT 1,
      redeemed_by   INTEGER REFERENCES users(id),
      redeemed_at   TEXT,
      expires_at    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 模型用量流水（成本侧真相，与 gongdao_ledger 消耗行按 ref_id 对账）。
  // 按 model_rates 的四档分桶计量：prompt / completion / cache_read / cache_write 各自费率不同，
  // 混算会系统性偏差——缓存读只要输入价的 0.1×，缓存写反而要 1.25×，两者并成一列必错。
  // cost_li 为精确成本，单位 0.001 公道值（厘），避免整数取整层层吃掉小额消耗。
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id            INTEGER NOT NULL REFERENCES users(id),
      feature            TEXT NOT NULL,
      -- 双串语义，两个都要留，别合并：
      -- model     = priced 计费键，与 model_rates.model 对齐，锁 dated 版本名/变体串
      --             （如 qwen-vl-ocr-2025-11-20、qwen-plus:think）——决定这行扣多少钱。
      -- api_model = 厂商响应回显的实际模型串。调用侧只能用别名发请求（厂商 API 不收 dated 串：
      --             DeepSeek 返 400、Qwen 返 403），故「按什么价记账」与「实际跑了哪个快照」
      --             是两件事。厂商把别名重指向新快照时，api_model 会变而 model 不变，
      --             对账脚本据此告警计费口径漂移。可空：历史行与无回显的调用留 NULL。
      model              TEXT NOT NULL,
      api_model          TEXT,
      prompt_tokens      INTEGER NOT NULL DEFAULT 0,
      completion_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,          -- 命中缓存的输入 token（与 prompt_tokens 不相交）
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,          -- 写入缓存的 token（比标准输入更贵）
      embed_tokens       INTEGER NOT NULL DEFAULT 0,
      cost_li            INTEGER NOT NULL DEFAULT 0,          -- 0.001 公道值（厘）
      ref_id             TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_user ON token_usage (user_id, created_at);
  `);

  // 模型费率表：只追加不修改，改价 = 写一条更晚 effective_at 的新行，取最新生效那条计价。
  // 保留历史行才能对旧账单按当时费率复算（改价不得回溯篡改已发生的消费）。
  // 档位变体编码进 model 字符串（如 qwen-plus:think / gpt-5.6-terra:long / deepseek-...:offpeak），
  // 不另设条件列——变体→API 参数的映射归 lib/llm 路由层，账本只认这个字符串、不解释它。
  // meta_json 记本行的定价出处（源 URL、官方原价、币种、汇率、核定日），改价争议时可原地追溯。
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_rates (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      model             TEXT NOT NULL,
      token_kind        TEXT NOT NULL CHECK (token_kind IN ('in','out','cache_read','cache_write')),
      gongdao_per_token REAL NOT NULL,
      effective_at      TEXT NOT NULL DEFAULT (datetime('now')),
      meta_json         TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_model_rates
      ON model_rates (model, token_kind, effective_at);
    CREATE INDEX IF NOT EXISTS idx_model_rates_lookup
      ON model_rates (model, token_kind, effective_at DESC);
  `);

  // ───────────────── 公司档案（报价计费 + 采集管线共用的三张表）─────────────────
  //
  // 【合并说明】pricing_config / entitlements / company_dossiers 三张表由计费侧（工单 B）与
  // 采集管线侧（工单 A）**各自独立写过一稿 DDL**，本处是合并后的**唯一**定义，两侧的列与索引取并集。
  // 之所以必须合成一处：建表走 `CREATE TABLE IF NOT EXISTS`，同名表写两遍时**后一遍整条静默跳过**
  // ——先执行的那份 DDL 赢，另一份要的列（如采集侧的 graph_refreshed_at）根本不存在，
  // 而迁移本身不报错，只在运行期以 `no such column` 现形。这是本次合并里最危险的一处，
  // 由 __tests__/migrate.test.ts 的列存在性断言与两侧各自的行为测试共同钉住。
  //
  // pricing_config：**服务定额与阈值的事实源**（读入口只有 lib/billing/pricing-config.ts 的 readPrice）。
  // 为什么另起一张表、不塞进 skus：fulfillment.resolveSkuKind 按 name 判定 SKU 语义，未知 name 一律
  // 兜底为「散充」按 amount_fen×100 入账。往 skus 里塞一行「档案·主体体检」，用户经下单路径碰到它
  // 就会被当成充值订单履约——**收了钱当充值入账，服务不交付**。
  // value_int **不加 CHECK(value_int >= 0)**：非法值的报错要发生在**读**的时候（readPrice 抛出
  // 三段式错误，指名哪个键、实际值多少、怎么改），而不是在写的时候被库拒掉。库侧拒写只会让运维
  // 拿到一句 SQLite 约束错误，看不出是哪个键、也不知道删行即回落兜底值。两处都拦反而更糟：
  // 已经写进去的历史坏行永远读不出错误原因。
  //
  // entitlements：会员赠送的一次性服务额度券（当前唯一一种 kind='dossier_core'＝买会员送核心四项一次）。
  // 为什么另起一张表、不给 memberships 加一列 credit：memberships 是每单一行、续期叠加，
  // 在其上加 credit 列，「续期两次送几次」就成了隐式规则，且那一列没有自己的幂等键——
  // 支付回调重放会不会多送一次，取决于谁先写的那条 UPDATE。
  // **uq_entitlements_source 是发券的幂等键**（source_ref = order_no）：grantEntitlement 走
  // INSERT OR IGNORE，全靠它把重放挡成 changes=0。索引是部分的（WHERE source_ref IS NOT NULL），
  // 因为 SQLite 的 NULL 互不相等：无来源的手工券（source_ref 为空）不该被这条唯一性约束绑在一起。
  // 核销与作废都不删行：券的一生（发/用/废）留在同一行上，「这单为什么没扣钱」才查得到。
  //
  // company_dossiers：**公司维度的平台资产**，company_key 唯一、跨案件跨账号共享——
  // 与 company_profiles（案件私有的背调档）是两回事，别合表：
  //   company_profiles.case_id     = 「这家公司在本案里扮演什么」（签约/用工/关联），各案可不同；
  //   company_dossiers.company_key = 「这家公司客观是什么」，跨案共享、按 TTL 复用。
  // 两者的连接靠 company_profiles.dossier_id（多对一，见文件末尾补列区）。
  // company_key 由 lib/company/normalize.ts **唯一产出**（uscc 优先，缺则归一化名称），
  // uq_company_dossiers_key 即缓存命中的判据；归一化只有一个入口这条由
  // lib/company/__tests__/normalize.test.ts 的结构守卫机检——写第二处归一化会当场红。
  // paid_by / paid_ref / charge_ref 只盖第一位付款人（lib/company/dossier-billing.stampPayment 的
  // `WHERE paid_by IS NULL` 守卫）：同一条档案会被多人先后付费，而这三列只有一份；
  // 后来者的凭据在各自的 gongdao_ledger 流水与 entitlements.consumed_ref 里，不会丢。
  // 这三列必须留痕：paid_by='membership_credit' + paid_ref=entitlement.id 是「这单为什么没扣钱」
  // 的**唯一**可查凭据——没有它，一笔没进账本的交付在事后无从解释。
  // graph_refreshed_at / litigation_refreshed_at 是采集侧的 TTL 判据（lib/company/dossier.ts），
  // 计费侧不读不写；两侧共用一张表，列取并集。
  // status 值集：queued（已扣费待跑）| graph_done（谱系块已交付）| awaiting_relay（等外勤开窗取证）
  //           | stats_ready（统计已出）| done（全档完成）| litigation_expired（超 SLA，文书块已退款）。
  // 只在注释里锁枚举、不加 CHECK（沿 intake_stage 裁决：SQLite 改 CHECK 要重建表），
  // 且**值域归采集管线（工单 A）**：计费侧只读不写它，建档时取 DDL 默认 'queued'。
  // ordered_by_user_id 走 ON DELETE SET NULL：用户注销要能删干净，而档案是平台资产不该跟着消失。
  db.exec(`
    CREATE TABLE IF NOT EXISTS pricing_config (
      key        TEXT PRIMARY KEY,                        -- 见 lib/billing/pricing-config.ts 的 PRICE_FALLBACK
      value_int  INTEGER NOT NULL,                        -- 公道值 / 天数 / 篇数，均为非负整数（合法性由 readPrice 判，见上）
      note       TEXT,                                    -- 这次改价的出处与理由，给对账的人看
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS entitlements (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind         TEXT NOT NULL,                         -- dossier_core（值域见 lib/billing/entitlements.ts）
      source_ref   TEXT,                                  -- 发券来源，会员单即 orders.order_no；NULL=手工发放，不参与幂等
      granted_at   TEXT NOT NULL DEFAULT (datetime('now')),
      consumed_at  TEXT,                                  -- NULL=未核销
      consumed_ref TEXT,                                  -- 核销去向，如 dossier-12
      revoked_at   TEXT                                   -- NULL=未作废（订单退款只作废未核销的）
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_entitlements_source
      ON entitlements (kind, source_ref) WHERE source_ref IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_entitlements_unconsumed
      ON entitlements (user_id, kind, id) WHERE consumed_at IS NULL AND revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_entitlements_user
      ON entitlements (user_id, kind, consumed_at);

    CREATE TABLE IF NOT EXISTS company_dossiers (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      company_key             TEXT NOT NULL,                   -- 唯一键，生成入口只有 lib/company/normalize
      name                    TEXT NOT NULL,
      uscc                    TEXT,
      status                  TEXT NOT NULL DEFAULT 'queued',
      paid_by                 TEXT,                            -- gongdao | membership_credit，只盖第一位付款人
      paid_ref                TEXT,                            -- 券付=entitlements.id；钱付=扣费幂等键前缀
      charge_ref              TEXT,                            -- 扣费幂等键前缀 dossier-<id>-u<uid>，退款按它原路退
      graph_refreshed_at      TEXT,                            -- 采集侧 TTL 判据（lib/company/dossier.ts）
      litigation_refreshed_at TEXT,                            -- 同上
      ordered_by_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_company_dossiers_key
      ON company_dossiers (company_key);
    CREATE INDEX IF NOT EXISTS idx_company_dossiers_status
      ON company_dossiers (status, id);
  `);

  // ───────────────── 公司动态监控 ─────────────────
  // 盯梢被监控主体：一案可盯多个主体（签约/用工/关联各自可能先跑路），风声阶段就该开盯——
  // 简易注销、减资公告是公司跑路前兆，等到裁决生效再发现主体没了，赢了官司也拿不到钱。
  // company_profile_id 可空：手输一个公司名就能开盯，不必先建背调档（用户往往只知道名字）。
  // status='paused' 是软停（保留历史事件与检查日志），停盯不删行。
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_watches (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id            INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      company_profile_id INTEGER REFERENCES company_profiles(id) ON DELETE SET NULL,
      name               TEXT NOT NULL,
      uscc               TEXT,
      status             TEXT NOT NULL DEFAULT 'active',    -- active | paused
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_company_watches_case ON company_watches (case_id);
  `);

  // 告警事件：只追加不修改。告警一旦发出即成事实（用户可能已据此行动），误报也留痕，
  // 修正靠补一条新事件而非改旧行——同 timeline_events 的理由，可改即等于可篡改。
  // severity='urgent'（简易注销公告/注销清算备案）即时三通道通知，'info' 进日报合并。
  // notified_at 为空表示尚未送达，通知侧回填；source_url 记来源出处（合规要求可溯源）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_watch_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      watch_id    INTEGER NOT NULL REFERENCES company_watches(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,                            -- 简易注销公告|注销清算备案|状态变更|股权变更|法代变更|减资公告|拉取失败
      severity    TEXT NOT NULL,                            -- urgent | info
      detail      TEXT,
      source_url  TEXT,
      detected_at TEXT NOT NULL,
      notified_at TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_company_watch_events_watch
      ON company_watch_events (watch_id, id DESC);
  `);

  // 检查日志：每次轮询落一行，事件 diff 靠 state_hash 与上一次比对得出。
  // ok=0 即本次拉取失败也要留行——静默失效（源站改版/限频封禁）是最危险的失败模式，
  // 没有失败留痕就无从判断「没有事件」是真没事还是根本没拉到。
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_watch_checks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      watch_id   INTEGER NOT NULL REFERENCES company_watches(id) ON DELETE CASCADE,
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      source     TEXT NOT NULL,
      state_hash TEXT,
      ok         INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_company_watch_checks_watch
      ON company_watch_checks (watch_id, id DESC);
  `);

  // 关联主体关系边（companywatch v2）：仲裁列谁当被申请人、往哪追加财产线索，靠这张图。
  // 边挂在案件下（同一家公司在不同案件里的关联判断可以不同，各案自建各案的图）。
  // 两端都 ON DELETE CASCADE：边随任一端点消亡——端点没了，这条关系无从谈起，留着即悬空脏边。
  // relation/confidence 只在注释里锁枚举、不加 CHECK：关系类型随数据源扩展（同前 intake_stage 裁决，
  // SQLite 改 CHECK 要重建表），值集由 lib 侧把关；confidence 记的是自动发现的可信度，
  // 「同地址」这类弱信号默认低置信，用户勾选入监控前得看得见这个分档。
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_relations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id         INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      from_profile_id INTEGER NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
      to_profile_id   INTEGER NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
      relation        TEXT NOT NULL,                            -- 股权母子|对外投资|分支机构|同法定代表人|同实际控制人|发薪链|同地址|其他
      evidence_url    TEXT,
      confidence      TEXT NOT NULL DEFAULT '中',                -- 高 | 中 | 低
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_company_relations_case ON company_relations (case_id);
  `);

  // 涉诉记录（companywatch v2）：判断这家公司「爱不爱赖账」与有无劳动争议前科。
  // uq_company_litigation 防重录——同一判决被反复抓取（每日轮询、多源交叉）只落一行，
  // 写入侧一律 INSERT OR IGNORE 消费本约束，据 changes 判定是不是新增。
  // is_labor=1 即劳动争议案由，agent 优先精读（应诉风格/赔付先例/代理律所）；
  // 裁判文书公开率 2021 起持续下降，故 doc_url 可空——只有案号没有全文的涉诉条目照样入档补缺口。
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_litigation (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      company_profile_id INTEGER NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
      case_no            TEXT NOT NULL,
      court              TEXT,
      judged_at          TEXT,
      cause              TEXT,
      is_labor           INTEGER NOT NULL DEFAULT 0,
      role               TEXT,                                  -- 被告 | 原告 | 被执行 | 第三人
      doc_url            TEXT,
      summary            TEXT,
      source             TEXT,
      fetched_at         TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_company_litigation
      ON company_litigation (company_profile_id, case_no);
    CREATE INDEX IF NOT EXISTS idx_company_litigation_lookup
      ON company_litigation (company_profile_id, is_labor, judged_at DESC);
  `);

  // ───────────────── 公司档案下挂表（背调产品化）─────────────────
  // company_dossiers 本体建在上面「报价计费 + 采集管线共用的三张表」那一段（合并后的唯一定义，
  // 列取两侧并集）；本段只建挂在它下面的三张表：分块进度、统计快照、套路归纳。
  // 连接到案件维度靠 company_profiles.dossier_id（多对一，见文件末尾补列区）。

  // 分块交付的**逐项**留痕：job_runs 答「这一轮有没有发生」，本表答「你的档案到哪一步了」。
  // 两个粒度互补不替代——进度态 API 只读本表，读 job_runs 答不出单个档案的进度。
  // 三态与 job_runs 同一套，靠 finished_at 分：
  //   无行                      → 这一块从来没排过
  //   有行、finished_at IS NULL → 在跑，或跑到一半崩了
  //   有行、finished_at 非空    → 有结论，status 说明是哪种结论
  // status 取 running | ok | failed | skipped：**skipped 必须与 ok 分开**——
  // 「没有全文可喂、所以没调模型」和「归纳跑完了」在用户眼里是两件事，
  // 合成一个 ok 就等于把「这块其实是空的」藏进一个绿灯里。
  // 故本表用 status 而不是 job_runs 那个 ok 整数：三值容不下第四种结论。
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_dossier_blocks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      dossier_id  INTEGER NOT NULL REFERENCES company_dossiers(id) ON DELETE CASCADE,
      block       TEXT NOT NULL,                        -- graph | litigation | stats | patterns
      status      TEXT NOT NULL DEFAULT 'running',      -- running | ok | failed | skipped
      started_at  TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      error_text  TEXT,                                 -- 失败原因原文，禁止只写「失败」
      note        TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_company_dossier_blocks
      ON company_dossier_blocks (dossier_id, block);
  `);

  // 统计快照：一档一行，每次文书增量入库后重算覆盖。
  //
  // **三个分母各存各的，禁止只留一个 docs_total**：docs_total 含「仅列表项」（有案号没全文），
  // 用它当比率分母会把一个未知偏差方向的幸存者样本包装成一个百分数。
  // 比率的唯一合法分母是 docs_outcome_decided（结果可判定的篇数），门槛不足时**整块不出数字**
  // ——这条在 lib/company/stats.ts 里执行，本表只负责把三个数都存下来供事后复核。
  //
  // **四段时长各存各的 n 与中位数，库里没有也不许有「平均时长」那一格**：
  // 仲裁受理→裁决 / 一审立案→判决 / 二审立案→判决 / 判决生效→执行立案 是四种不同的等待，
  // 合成一个数只会得到一个谁也没经历过的时长。一段样本不足不牵连其它段。
  // 中位数用 REAL：偶数样本取中间两个的均值，取整会在小样本上系统性偏移。
  //
  // as_of = MAX(fetched_at)，即采集截止日；coverage_note 是**必渲染的结构化字段**，
  // 不是可折叠脚注——把覆盖度声明降级成小字，等于让用户替我们承担诚实税。
  // dropped_patterns 是模型编造率的唯一体温计：静默丢弃会把编造藏起来，必须计数可查。
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_dossier_stats (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      dossier_id           INTEGER NOT NULL REFERENCES company_dossiers(id) ON DELETE CASCADE,
      docs_total           INTEGER NOT NULL DEFAULT 0,   -- 全部入档行数（含仅列表项）
      docs_fulltext        INTEGER NOT NULL DEFAULT 0,   -- has_fulltext=1 的行数
      docs_outcome_decided INTEGER NOT NULL DEFAULT 0,   -- 结果可判定的行数（比率的唯一合法分母）
      worker_favorable_n   INTEGER NOT NULL DEFAULT 0,   -- 其中劳动者全部或部分获支持的篇数
      applicant_labor_n    INTEGER NOT NULL DEFAULT 0,   -- 劳动者提起的件数（程序位置，与胜负不是一回事）
      applicant_employer_n INTEGER NOT NULL DEFAULT 0,   -- 单位提起的件数
      arb_n                INTEGER NOT NULL DEFAULT 0,
      arb_median_days      REAL,
      trial1_n             INTEGER NOT NULL DEFAULT 0,
      trial1_median_days   REAL,
      trial2_n             INTEGER NOT NULL DEFAULT 0,
      trial2_median_days   REAL,
      exec_n               INTEGER NOT NULL DEFAULT 0,
      exec_median_days     REAL,
      as_of                TEXT,                          -- = MAX(fetched_at)，采集截止日
      coverage_note        TEXT,
      dropped_patterns     INTEGER NOT NULL DEFAULT 0,
      computed_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_company_dossier_stats
      ON company_dossier_stats (dossier_id);
  `);

  // LLM 归纳出的「这家公司的套路」。**每条必须带逐条证据**（evidence_json 为
  // [{case_no, quote}] 数组），且 quote 必须是该案号原文的逐字子串——
  // 校验在 lib/company/patterns.ts 里用 SQL 存在性查询 + indexOf 做，**不是在 prompt 里求模型自觉**。
  // 证据被清空的 pattern 整条丢弃、计入 company_dossier_stats.dropped_patterns，绝不落库。
  // 故本表没有「无证据的套路」这种行：读侧不必再判空，UI 层的双保险防的是别处写进来的脏行。
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_patterns (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      dossier_id    INTEGER NOT NULL REFERENCES company_dossiers(id) ON DELETE CASCADE,
      pattern       TEXT NOT NULL,
      evidence_json TEXT NOT NULL,                        -- [{case_no, quote}]，空数组不许落库
      model         TEXT,                                 -- 归纳所用模型的计费键
      generated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_company_patterns_dossier
      ON company_patterns (dossier_id, id);
  `);

  // 免费前置探测（§2.3）的两张表。
  //
  // company_probe_cache：一家公司一行、全站共享的探测载荷（四个数字 + 工商状态 + 主体命中）。
  // **fetched_at 是我们这份拷贝的入缓存时刻，不是数据的 as_of**（as_of 存在 payload_json 里）：
  // TTL(24h) 管的是「多久不再去采集侧重拉」，命中即 0 成本复用。payload_json 是采集侧产出的
  // 客观计数，**零 LLM**——写点唯一在 lib/company/probe.ts 的 upsertProbeCache，且先体检再落库
  // （非负整数、层层子集、as_of 必填），脏载荷进不了这张全站共享的缓存。
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_probe_cache (
      company_key  TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      fetched_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // company_probe_events：探测限流的**逐次留痕**（登录后每用户每日 dossier.probe_free_per_day 次）。
  // 一行 = 一次真采集（占 1 配额）；**缓存命中不落行**（命中 0 成本、不限次、不占配额）。
  // 按 (user_id, 日历日) 计数，配额耗尽即降级为「仅缓存命中」并如实告知（不报错、不返回空）。
  // 与 ip_quota_events 同构：只追加、按写入侧机会式 GC，不设定时任务（加个必须有人盯的 cron
  // 代价高于顺手多跑一条 DELETE）。company_key 一并留痕，便于事后查「谁在白嫖哪家公司」。
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_probe_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      company_key TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_company_probe_events_user
      ON company_probe_events (user_id, created_at);
  `);

  // ───────────────── 通知 ─────────────────
  // 发送台账 + 幂等闸门：uq_notify_sent 保证同一业务键（scene, biz_key）每通道最多一条 status='sent'，
  // 失败/跳过行不受约束可重复落行（重试留痕）。
  // 部分索引只盖 sent，故「短信成功」不会挡住「邮件失败后重试」——NBDpsy 教训：
  // 一条通道成功绝不得掩盖另一条通道的失败，每通道各自独立判定。
  // detail 必须写失败原因原文（三方返回的错误码与文案），禁止只写「发送失败」——写了等于没写。
  db.exec(`
    CREATE TABLE IF NOT EXISTS notify_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      scene      TEXT NOT NULL,
      biz_key    TEXT NOT NULL,
      channel    TEXT NOT NULL,                             -- sms | email | wechat_oa
      status     TEXT NOT NULL,                             -- sent | failed | skipped
      detail     TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_notify_sent
      ON notify_log (scene, biz_key, channel)
      WHERE status = 'sent';
  `);

  // ───────────────── 任务运行 ─────────────────
  // 运行粒度的留痕：本表答「这一轮有没有发生」，notify_log / company_watch_checks 那类逐项表
  // 答「这一项怎么样」——两个粒度互补，谁也顶不了谁。定时任务的进程压根没起来时，逐项表一行都不落，
  // 而「今天零行」与「今天没有配置任何监控」在逐项表里长得一模一样。
  //
  // **开跑时就插行，跑完再 UPDATE 回填；不许只在跑完时插。** 只在结束时插行的话，崩掉的那次
  // 不留任何痕迹——而「崩了」和「根本没跑」正是这张表存在的全部理由。三态就是靠这个顺序分出来的：
  //   没有行                    → 这个任务从来没跑起来过
  //   有行、finished_at IS NULL → 跑起来了但没跑完（进程被杀 / 崩了 / 还在跑）
  //   有行、finished_at 非空    → 跑完了，ok 与 error_text 说明结果
  // ok / finished_at 因此可空：它们是「跑完」才有的结论，插行那一刻还不知道，不许拿默认值先占着。
  // 写入口在 lib/db/job-runs.ts（startRun / finishRun），跑批侧不要自己拼 INSERT。
  //
  // **items_failed 与 error_text 是两回事，不许混成一格：**
  //   items_failed=3, ok=1    → 这轮跑通了，其中 3 项各自失败（那 3 条的原因去 notify_log 逐条查）
  //   ok=0, error_text 非空   → 整轮炸了（库连不上、配置缺失），items_* 可能是半截数
  // 混成一格，「发了 100 封失败 3 封」与「一封没发成、整个任务崩了」就读起来一样——
  // 那正是本表要解决的那类问题，别在它自己身上再犯一次。分工同理：**逐项的失败原因在 notify_log
  //（逐项粒度），本表只记这一轮的总账与整轮致命错误（运行粒度）**，两张表不重复。
  // error_text 必须写原文，禁止只写「失败」——同 notify_log.detail 那条规矩。
  //
  // items_* 的零值都有信息，别当缺省读：
  //   examined=0, ok=0, failed=0 → 跑了，本轮没有到期的期限（正常）
  //   examined=5, ok=0, failed=5 → 跑了，五条全发失败（异常）
  // 两者都不是「没跑」，超期未跑的判据一个都不该报——但读表的人必须一眼分得开，note 就是干这个的。
  // job_name 只在注释里锁枚举、不加 CHECK（沿 intake_stage 裁决：SQLite 改 CHECK 要重建表）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_runs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      job_name       TEXT NOT NULL,                         -- 值域见 lib/db/job-runs.ts 的 JobName
      started_at     TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at    TEXT,                                  -- NULL=未跑完（崩了 / 被杀 / 还在跑）
      ok             INTEGER,                               -- NULL=未跑完；1=整轮跑通；0=整轮失败
      items_examined INTEGER,                               -- 本轮检查了几项（期限提醒＝扫了几条期限）
      items_ok       INTEGER,                               -- 其中成功几项（＝真发出去几封）
      items_failed   INTEGER,                               -- 其中失败几项（＝发失败几封），与 ok=0 不是一回事
      error_text     TEXT,                                  -- **整轮**致命错误原文，禁止只写「失败」
      note           TEXT                                   -- 人话摘要，给读表的人看
    );
    CREATE INDEX IF NOT EXISTS idx_job_runs_name ON job_runs (job_name, id DESC);
  `);

  // ───────────────── 管理后台审计 ─────────────────
  // 后台每一次**变更**落一行（调会员、发公道值）。只追加，永不 UPDATE、永不 DELETE——
  // 一张能被后台自己改的审计表，等于没有审计表。
  //
  // 【为什么它与账本/会员行同时存在，不是重复】
  //   gongdao_ledger 答「钱变了多少」，memberships 答「会员期到哪天」，
  //   两者都只留下 order_no / ref_id 里那一小截 `admin-<uid>-<ts>` 操作痕。
  //   本表答的是**另一个问题**：谁、在什么时候、对谁、做了什么、当时填的备注是什么。
  //   没有本表，「误发了 5 万公道值」只能从一条 ref_id 反推操作者，且**读不出他当时的理由**；
  //   而后台的全部风险恰恰在「操作者是人、人会手滑也会有私心」。
  //
  // 【detail_json 必须写清后果，不许只写动作名】
  //   发值写 {delta, note, ref_id, applied}；调会员写 {plan, days, order_no, downgraded, expires_at}。
  //   只记 action='grant_gongdao' 而不记金额，与不记一样——事后没人能判断这一笔对不对。
  //   applied=false（撞幂等、被拒）也落行：**「试过但没生效」与「没试过」必须分得开**，
  //   否则重放攻击与手滑重复点击在审计里长得一模一样。
  //
  // action 值域在 lib/admin/audit.ts 的 ADMIN_ACTION 锁死，不加 DB 级 CHECK
  //（沿 intake_stage / milestone 裁决：SQLite 改 CHECK 要重建表，本迁移框架无事务）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_uid INTEGER NOT NULL REFERENCES users(id),
      action       TEXT NOT NULL,                            -- 值域见 lib/admin/audit.ts 的 ADMIN_ACTION
      target_uid   INTEGER NOT NULL REFERENCES users(id),
      detail_json  TEXT,                                     -- 本次变更的后果与备注，禁止只写动作名
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit (target_uid, id DESC);
  `);

  // ───────────────── 服务报价与内容提取任务 ─────────────────
  // 报价→确认→扣费的统一台账（设计稿 §4.2）。今日 lib/company/dossier-billing 那套三段式
  // 只服务公司档案；耗算力的内容提取（OCR / 录音转写 / 视频提取 / 来文解读 / 证据简报）
  // 共用本表，读写函数在 lib/billing/service-quotes.ts。
  //
  // 【为什么报价要落库，而不是签一个自证的 token】报价里写的价必须与确认时扣的价是同一个数：
  // 中途有人改了 pricing_config，token 里那个数就成了「用户看到的价」与「实际扣的价」的分歧点，
  // 而两边都不会报错。落一行、确认时按 id 取回，价就只有一处。
  //
  // 【confirmed_at 是幂等键，不是状态标记】确认走 `UPDATE ... WHERE id=? AND confirmed_at IS NULL`
  // 抢占：抢输的那次 changes=0，直接判重放、不再扣第二笔（同 entitlements 核销那条判据的写法）。
  // order_ref 记这一单的扣费幂等键（svc-<报价id>-u<用户id>），退款按它原路退。
  // amount 是**确认时应扣**的公道值；券抵扣的单 amount 照记原价、entitlement_id 非空，
  // 「为什么没扣钱」两处都查得到（同 dossier 那条：只留一处事后分不清送的还是漏扣的）。
  // service 值域只在注释与 lib/billing/service-quotes.ts 锁，不加 DB 级 CHECK（沿 intake_stage 裁决）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_quotes (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      case_id        INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      service        TEXT NOT NULL,                          -- ocr|asr|video|doc_review|brief|dossier|watch，值域见 lib/billing/service-quotes.ts
      payload_json   TEXT,                                   -- 计价入参原样留存（单位数量、证据 id 等），对账时要能复算这个价
      amount         INTEGER NOT NULL,                       -- 应扣公道值（非负整数）；券抵扣时照记原价
      entitlement_id INTEGER REFERENCES entitlements(id),    -- 非空=这单由会员券抵掉，没走公道值
      expires_at     TEXT NOT NULL,                          -- 过了这个点确认一律 QUOTE_EXPIRED，须重新报价
      confirmed_at   TEXT,                                   -- NULL=未确认（未扣费）；非空=已确认，二次确认判重放
      order_ref      TEXT,                                   -- 扣费幂等键 svc-<报价id>-u<用户id>，退款按它原路退
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_service_quotes_user ON service_quotes (user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_service_quotes_case ON service_quotes (case_id, id DESC);
  `);

  // 内容提取任务队列（设计稿 §5 extraction_jobs）。全站第一张**逐条排队认领**的表：
  // 此前唯一的异步范式是 cron 轮询状态列（company_dossiers.status），分钟到小时级延迟，
  // 而用户提交一段录音之后是等在页面上的。
  //
  // 【租约而不是锁】lease_until = 领取者承诺在这个点之前干完或续租；worker 每 30 秒心跳续租。
  // 进程被 kill / 机器重启，租约到点自然过期，下一轮扫描把它当可领取的重新捞起——
  // **不需要任何「清理僵尸任务」的收尾代码**，那种代码只在崩溃时才跑，也就永远没被跑过。
  // heartbeat_at 与 lease_until 分开记：前者答「它还活着吗」，后者答「谁能来抢」，
  // 合成一列的话「刚续过租」与「租约本来就长」在读侧长得一样。
  //
  // 【attempts 记的是领取次数，不是失败次数】每次领取 +1，超过上限直接置 failed。
  // 记失败次数的话，「跑到一半进程没了」这种既没成功也没写失败的形态永远不计数，
  // 一条毒任务会被无限重领。
  //
  // status 值域 queued|running|done|failed；mode 值域 ocr|asr|video——
  // 两者都只在注释与 lib/jobs/extraction-worker.ts 锁，不加 DB 级 CHECK（沿 intake_stage 裁决）。
  // cost 是这次提取实际扣掉的公道值（0 = 免费或券抵），quote_id 指回是哪一张报价买的。
  db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_jobs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      evidence_id  INTEGER NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
      case_id      INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mode         TEXT NOT NULL,                            -- ocr | asr | video
      status       TEXT NOT NULL DEFAULT 'queued',           -- queued | running | done | failed
      quote_id     INTEGER REFERENCES service_quotes(id),    -- 这次提取是哪张报价买的；NULL=未走计费（内部重跑）
      cost         INTEGER NOT NULL DEFAULT 0,               -- 实扣公道值（券抵/免费为 0）
      lease_until  TEXT,                                     -- 租约到期点；过期即可被重新领取
      heartbeat_at TEXT,                                     -- 最近一次心跳；答「它还活着吗」
      attempts     INTEGER NOT NULL DEFAULT 0,               -- 被领取的次数（不是失败次数），超上限置 failed
      error        TEXT,                                     -- 最近一次失败原文，禁止只写「失败」
      started_at   TEXT,                                     -- 首次被领取的时刻
      finished_at  TEXT,                                     -- 进入 done/failed 的时刻
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_extraction_jobs_claim ON extraction_jobs (status, id);
    CREATE INDEX IF NOT EXISTS idx_extraction_jobs_evidence ON extraction_jobs (evidence_id, id DESC);
  `);

  // 一次性上传地址的 token（设计稿 §2 B evidence_upload_url）。
  //
  // 【为什么要一张表，不能只签个 JWT】token 必须是**一次性**的：签发出去的是一条无鉴权
  // 就能写字节的地址，可重放的话，任何拿到过这条 URL 的人（日志、剪贴板、聊天记录里
  // 都可能留着）都能反复往用户案卷里塞文件。「用过了」是状态，无状态令牌记不住它。
  //
  // 【存哈希不存明文】与 api_keys 同口径：库被读走时，token 明文一条都不该在里面。
  //
  // 【consumed_at 兼作一次性的抢占键】消费那句写成
  //   UPDATE ... SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL
  // 按 changes===1 判定抢到，两个并发 PUT 只有一个能抢到——不靠「先查再写」，
  // 那中间隔着一次 await 读请求体，足够第二个请求把同一个 token 也查成「没用过」。
  //
  // size 是签发时**声明**的字节数（拿来在签发一刻就按 mime 分档拒掉超大的，见 upload-guard），
  // 真正的把关仍在 PUT 收到字节之后；两个数不要求相等，agent 事先不一定数得准。
  // file_id 在字节落库后回填，evidence_id 在 evidence_register 建条目后回填——
  // 两列都为空 = 地址签了但没人传；有 file_id 无 evidence_id = 传了但还没登记。
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_upload_tokens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash  TEXT NOT NULL UNIQUE,                      -- sha256(token 明文)，明文不入库
      case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename    TEXT NOT NULL,                             -- 签发时声明的文件名，登记时可被 name 覆盖
      mime        TEXT,                                      -- 签发时声明的 mime，决定体积档位
      size        INTEGER NOT NULL DEFAULT 0,                -- 签发时声明的字节数（非权威）
      expires_at  TEXT NOT NULL,                             -- 过期点；过期后即使没用过也不再受理
      consumed_at TEXT,                                      -- 抢占键：非空 = 这个 token 已经用掉
      file_id     INTEGER REFERENCES files(id),              -- 字节落库后回填
      evidence_id INTEGER REFERENCES evidence(id) ON DELETE SET NULL, -- 登记后回填
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_upload_tokens_case ON evidence_upload_tokens (case_id, id DESC);
  `);

  // ───────────────── 存量迁移区 ─────────────────
  // 上面的建表段只对新库生效（IF NOT EXISTS 不改已存在的表），已上线的库补列一律走这里。
  // 只加列、不回填、不改语义：老行的新列取 NULL / DDL 默认值，读侧必须容得下这个缺省。

  // threads.intake_stage：问诊状态机进度落痕。值集当前 A|B|C|D|done（D 档=特殊保护已问过），
  // 由 lib/agent 就近维护并提供写入口——本列**不加 DB 级 CHECK**：状态机是推导式（不存游标，
  // 本列只是补充落痕），SQLite 改 CHECK 要重建表，为其锁枚举得不偿失（manager 2026-08-19 裁决）。
  // NULL = 非问诊线程，或问诊线程尚未进入状态机。
  // WS2 此前借 timeline_events.kind='系统动作' 落痕记录进度，本列落地后切换到本列。
  addColumnIfMissing(db, 'threads', 'intake_stage', 'TEXT');

  // timeline_events.milestone：这条事件构成「达成哪个里程碑」（批 6 驾驶舱，
  // 契约见 docs/contracts/case-milestone.md）。取值域是 CASE_MILESTONES，
  // **不是** cases.stage 的词表——里程碑是只追加的既成事实，stage 是可变可回退的当前态，
  // 两者是不同的东西（契约 §二）；早先按「milestone ⊆ stage」写过一稿，第一格「协商」
  // 在 stage 里没有对应值，只能让键说谎，故拆开（契约 §三·附）。
  //
  // 【为什么可空 TEXT，不是 NOT NULL】SQLite 拒绝给已有表加无默认的 NOT NULL 列，
  // 在这个无事务的迁移框架里就是半途炸；而契约上 `milestone?` 本就是可选字段，
  // **可空是语义正确，不是将就**。同 intake_stage，不加 DB 级 CHECK（改 CHECK 要重建表），
  // 值域由 lib/cases 的 confirmMilestone 把关 + 测试钉死；CHECK 并进 WS1 那笔递延。
  addColumnIfMissing(db, 'timeline_events', 'milestone', 'TEXT');

  // timeline_events.client_ref：调用方自带的幂等键（一次业务操作一个 ref）。
  //
  // 【为什么要它】写接口无幂等，agent 重试即双写——生产 case2 实测同一次调岗落成两条
  // 时间线。调用方给同一个 client_ref 重放时，lib/cases 的 addTimelineEvent 先查后写、
  // 命中即回既有行，不再插第二条。**唯一性必须落在库上**：只靠应用层"查完再写"两步，
  // 中间那一瞬没有东西挡得住同 ref 插进来两行。
  //
  // 部分索引只盖 client_ref 非空的行：站内 agent 与网页多数写入不带 ref（走的是
  // 同案+同日+同类+标题规范化的近重复守卫，那条不进库、纯应用层），多行 NULL 不算冲突，
  // 与 uq_users_google_sub 同形。可空 TEXT，存量行一律 NULL，建索引不撞已有数据、可反复重跑。
  addColumnIfMissing(db, 'timeline_events', 'client_ref', 'TEXT');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_timeline_client_ref
      ON timeline_events (case_id, client_ref) WHERE client_ref IS NOT NULL;
  `);

  // cases 的首诊四列：**首诊填的那几个数字要有地方落**。
  //
  // 【为什么非加不可】首诊六步里，入职日期与月工资是 N/2N/N+1 的**计算输入**，
  // 岗位与合同签署次数决定能主张什么。此前 cases 只有 goal/bottom_line 两个自述列，
  // 于是这四项在库里根本没有落脚点——用户填完六步，一个数字都没存下来。
  //
  // 【存输入不存结论】只存 employed_from / monthly_wage_fen 这类**用户给的事实**，
  // 不存「2N=22 万」这类算出来的结论：封顶基数与年限口径会随卡更新，
  // 存下来的结论第二天就可能与现算的对不上，而用户没有任何办法看出哪个是新的。
  //
  // 【为什么可空、不回填】存量案件本来就没填过首诊，拿 0 或 '' 顶上等于把「没填」
  // 伪装成「填了是这个」——月工资 0 会一路算进赔偿金额。读侧一律容得下 NULL。
  // 金额一律存分（全仓口径），日期存 'YYYY-MM-DD'（ADR-002：日期列保持字符串）。
  addColumnIfMissing(db, 'cases', 'employed_from', 'TEXT');
  addColumnIfMissing(db, 'cases', 'monthly_wage_fen', 'INTEGER');
  addColumnIfMissing(db, 'cases', 'position', 'TEXT');
  addColumnIfMissing(db, 'cases', 'contract_count', 'TEXT');

  // users.cert_type：id_card_enc 里那个证件号是什么证（身份证 | 护照）。
  //
  // 【为什么必须显式存，不能靠长度猜】掩码规则依赖证件类型：18 位身份证留头 4 尾 4
  // 只露 8/18；9 位护照按同一规则会露 8/9——**而那个值印在《存证证明》PDF 上，
  // 是一份对外出示的文件**。靠长度猜就是把一个会静默出错的判据放进隐私路径：
  // 猜错不报错，只是发出去的证上多露几位，没有任何人会发现。
  // NULL = 老数据（护照通道之前只有身份证一种），掩码时按最保守规则处理。
  addColumnIfMissing(db, 'users', 'cert_type', 'TEXT');

  // users.google_sub：Google 账号的稳定标识（ID Token 的 `sub` claim）。
  //
  // 【为什么归并键是 sub 不是邮箱】Google 侧邮箱可改（企业版改域名、个人号换地址），
  // sub 在一个 client_id 下对一个 Google 账号终身不变。拿邮箱当主键的话，用户在 Google
  // 那边改了邮箱，回来就是一个陌生人——账号里的案件档案全部失联。邮箱只作**第二顺位**
  // 的归并线索（把 Google 线接到已有的手机线/邮箱线账号上），接上之后就以 sub 为准。
  //
  // NULL = 没绑过 Google（手机线/邮箱线注册的存量账号全是这种），故唯一索引用部分索引，
  // 与 uq_users_phone_hash / uq_users_email 同一形态：多行 NULL 不算冲突。
  // 唯一性必须落在库上而不只靠应用层判断——绑定是「查完再写」两步，
  // 只有唯一索引能保证中间那一瞬没人插队，把同一个 Google 账号绑到两个用户上。
  addColumnIfMissing(db, 'users', 'google_sub', 'TEXT');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_google_sub
      ON users (google_sub) WHERE google_sub IS NOT NULL;
  `);

  // company_watches.tier：三圈监控档位（spec v3）。daily=圈1 直接责任链、weekly=圈2 责任扩展候选、
  // archive=圈3 存档不监控。同 intake_stage，**不加 DB 级 CHECK**（SQLite 改 CHECK 要重建表）。
  // 升级与衰减规则（圈1 出事件→相邻圈2 升每日、30 天无新 urgent 回落、手动钉住）**全在 watcher
  // 应用层**，库侧不设触发器、不设定时任务、不设任何机制——本列只是哑存储，写什么就是什么。
  // 存量行取 DDL 默认 'daily'：老库的盯梢都是按每日跑的，默认值即其现状，不需回填。
  addColumnIfMissing(db, 'company_watches', 'tier', "TEXT NOT NULL DEFAULT 'daily'");

  // company_watches 守望计费四列（spec v3 §2.2 · 守望按 tier 月度扣费）。扣费逻辑全在
  // lib/company/watch-billing，库侧只做哑存储（同 tier，不设 CHECK / 触发器 / 定时任务）。
  //   billing_status：free（尚未计过费）| paid（本月已扣）| arrears（本月余额不足未扣）。
  //     存量行默认 'free' —— 老库的盯梢在 MVP 期免费，'free' 即其现状，不回填、不追缴。
  //   paid_through：最近一次成功扣费覆盖到的月份（YYYYMM）。NULL=从未成功扣过。
  //   arrears_rounds：连续欠费轮数计数器。达上限（3）即 status→paused 且再发一次通知
  //     （绝不静默停盯）。成功扣费即清零。用显式计数列而非从账本推——推导要靠"这月扣没扣"
  //     的历史比对，一旦重跑巡检就会把同一个月重复计进去，把"3 个月"数成"3 次跑"。
  //   billed_month：最近一次**处理过**的月份（YYYYMM，扣费成功或判欠费都算处理）。
  //     它是整轮的幂等闸：同月重复跑巡检时 billed_month===本月即整条跳过，
  //     保证「每个 watch 每月只扣一笔、arrears_rounds 每月只加一次」（gongdaoSettle 的 refId
  //     只挡重复扣款，挡不住 arrears_rounds 重复自增，故另设此列）。
  // 四列均可空 / 带默认，存量行取默认即语义正确，不需要回填（同迁移框架无事务的约束）。
  addColumnIfMissing(db, 'company_watches', 'billing_status', "TEXT NOT NULL DEFAULT 'free'");
  addColumnIfMissing(db, 'company_watches', 'paid_through', 'TEXT');
  addColumnIfMissing(db, 'company_watches', 'arrears_rounds', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'company_watches', 'billed_month', 'TEXT');

  // cases.domain：这个案子属于哪个领域（MCP 设计稿 §13）。领域包挂在 lib/domains/<key>.ts，
  // 阶段枚举、事实卡分节、期限/文书/算钱器种类都从包里取，共用层不再写死某一个领域。
  //
  // NOT NULL DEFAULT：SQLite 的 ADD COLUMN 加**有默认值**的 NOT NULL 列是允许的
  //（存量行当场按默认值补齐），加无默认值的 NOT NULL 才会炸——本条属于前者，可重跑。
  // 默认值就是今天全站唯一在跑的那个领域：存量案件本来就都是它，这不是编出来的值。
  addColumnIfMissing(db, 'cases', 'domain', "TEXT NOT NULL DEFAULT 'labor'");

  // company_profiles.dossier_id：案件维度的主体 → 公司维度的档案（多对一）。
  // 可空：手建的背调档不一定买过档案，且档案是后来才有的东西，老行一律 NULL。
  addColumnIfMissing(db, 'company_profiles', 'dossier_id', 'INTEGER REFERENCES company_dossiers(id)');

  // company_litigation 的九列：外勤取证产物的落库位。**全部可空、全部不回填**——
  // 现有语料里绝大多数行是「仅列表项_未取全文」，这九列对它们本来就没有值，
  // 拿默认值把空缺填成 0/'未知' 就是把「没取到」伪装成「取到了是这个」。
  //
  // has_fulltext 是 §1.3 输入白名单的开关：只有 =1 的行的全文才允许喂给归纳模型，
  // 仅列表项的行**连标题都不喂**（标题足以让模型脑补案情）。默认 0 是保守方向：
  // 取不准时宁可少喂，也不能把没核实的东西喂进去再由模型编出证据来。
  //
  // outcome 只取三值：劳动者全部获支持 | 劳动者部分获支持 | 劳动者未获支持。
  // NULL ≠ 输了，NULL = 判不出来（没全文、或全文里没有可逐字引用的判据）。
  // outcome_basis 存判据的**逐字原文**：没有它，outcome 就是一个没人能复核的断言。
  // applicant_side（劳动者/单位）必须与 outcome 分开看——2022 年那批「用人单位起诉员工」
  // 的案子里，「公司赢了」和「劳动者输了」不是同一件事，不分程序位置的胜诉率是错的数。
  //
  // filed_at/judged_at 只准写文书上**载明**的日期，推断的一律留空（推断出来的时长
  // 会以一个精确的天数呈现，读的人无从分辨它其实是猜的）。
  addColumnIfMissing(db, 'company_litigation', 'has_fulltext', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'company_litigation', 'fulltext_path', 'TEXT');
  addColumnIfMissing(db, 'company_litigation', 'outcome', 'TEXT');
  addColumnIfMissing(db, 'company_litigation', 'outcome_basis', 'TEXT');
  addColumnIfMissing(db, 'company_litigation', 'filed_at', 'TEXT');
  addColumnIfMissing(db, 'company_litigation', 'stage', 'TEXT');
  addColumnIfMissing(db, 'company_litigation', 'applicant_side', 'TEXT');
  addColumnIfMissing(db, 'company_litigation', 'amount_awarded_fen', 'INTEGER');
  addColumnIfMissing(db, 'company_litigation', 'dossier_id', 'INTEGER REFERENCES company_dossiers(id)');

  // redemption_codes 的两列：管理后台批量发码留下的「这批是谁、为什么发的」。
  //
  // 【为什么不是可选的锦上添花】兑换码是**凭空造公道值**的唯一入口——一张码落地就是一笔
  // 无对价的入账。没有这两列，事后只能看到「某年某月某日凭空多了 N 笔 300」，
  // 既查不出是哪次活动发的，也查不出是谁批的；出了滥发只能全表人肉核对。
  // note 存批次备注（如「2026-09 老用户回馈」），created_by 存签发人 uid。
  //
  // 两列都可空且不回填：既有的存量码（含手工 INSERT 的）本来就没有出处，
  // 拿 '未知' / 0 填上等于把「查不到」伪装成「查到了是这个」。读侧一律容得下 NULL。
  addColumnIfMissing(db, 'redemption_codes', 'note', 'TEXT');
  addColumnIfMissing(db, 'redemption_codes', 'created_by', 'INTEGER REFERENCES users(id)');

  // api_keys.client_name：MCP 客户端在 `initialize` 里自报的名字（clientInfo.name）。
  // 此前握手拿到就丢掉，于是页面上只说得出「用户给钥匙起的名」，说不出**到底是哪个助手接进来了**。
  //
  // 可空且不回填：走 REST 的客户端根本不报名字，存量行更是无从得知。读侧退到钥匙名，
  // 并在页面上写明「这是你给钥匙起的名字」——**不编默认值**，否则用户会以为我们认出了他的助手。
  addColumnIfMissing(db, 'api_keys', 'client_name', 'TEXT');

  // api_keys.secret_enc / rotated_at：让用户**回来还能看见自己的密钥明文**。
  //
  // 【为什么推翻「明文只显示一次」】那条铁律的代价全落在用户身上：密钥只在创建响应里出现
  // 一次，关掉那一屏之后设置页的接入话术里就只剩 `<粘贴你生成时保存的密钥>` 占位符——
  // 用户想换台设备接一次，唯一的出路是吊销重建。而这把 key 保护的是他自己的案件档案，
  // 不是别人的钱：他本来就有权看见它。所以改成**加密留存**：secret_enc 存
  // lib/crypto encryptField 的自包含密文（主密钥只在 env LAWER_DATA_KEY，不入库），
  // key_hash 照旧是鉴权用的那一列，两者各司其职、互不替代。
  //
  // 两列都可空且**不回填**：存量密钥的明文我们当年就没留，今天也变不出来。
  // 给 secret_enc 塞任何默认值都是把「找不回了」伪装成「找得回」——读侧据
  // `secret_enc IS NULL` 显示「旧密钥不可查看，请轮换」，那是实话。
  // rotated_at 记最近一次轮换时间，NULL = 从没轮换过（不是「1970 年轮换过」）。
  addColumnIfMissing(db, 'api_keys', 'secret_enc', 'TEXT');
  addColumnIfMissing(db, 'api_keys', 'rotated_at', 'TEXT');

  // messages.failed_code：这一轮**终态失败**的错误码（AGENT_FAILED 等，值集见 lib/errors/user-facing）。
  // NULL = 这不是失败轮（绝大多数行）。
  //
  // 【为什么必须落库】在此之前失败是**纯前端瞬时状态**：模型连不上时页面有一张
  // 「这一轮没能生成回答 / 重试」的卡，一刷新就没了——库里只剩用户自己那句问题
  // 一句挨一句排着，没有任何"没答上"的痕迹，也没有重试入口。对一个在等仲裁的人，
  // 那个形状与"我讲的话被吞了"无法分辨（naive-qa-2 F-203）。
  //
  // 【与 content IS NULL 的分工】content IS NULL 是「生成中」占位（见建表段注释），
  // 是**未定**；本列非空是**已定的失败**，同一行的 content 同时被回填成三段式失败文案，
  // 所以它照常被 listCaseMessages 取出来、照常在页面上占一格。两者不许混用：
  // 把失败也留成 NULL content，就是这条缺陷本身。
  //
  // 可空 TEXT、不回填、无 DB 级 CHECK：同 intake_stage / milestone 的既定裁决
  //（SQLite 加无默认 NOT NULL 列会半途炸，改 CHECK 要重建表，本迁移框架无事务）。
  addColumnIfMissing(db, 'messages', 'failed_code', 'TEXT');

  // 存量库的 drafts 补两列（新建库已在建表段带上）。纯加法、可重跑。
  addColumnIfMissing(db, 'drafts', 'send_consequences', 'TEXT');
  addColumnIfMissing(db, 'drafts', 'based_on', 'INTEGER');

  // 档案维度的去重键。**必须与 uq_company_litigation（案件维度）并存，不能替代它**：
  // 一个档案可以被多个案件的 company_profiles 指向，同一份 JSONL 若先后挂在两个 profile 下导入，
  // 只有案件维度那把唯一键的话两行都能进去，docs_total 当场翻倍——而那个数是比率的分母之一。
  // 部分索引只盖 dossier_id 非空的行：存量行的 dossier_id 全是 NULL（本次新加的列），
  // 建索引时不会撞已有数据，故这条与其它迁移一样可以反复重跑。
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_company_litigation_dossier
      ON company_litigation (dossier_id, case_no) WHERE dossier_id IS NOT NULL;
  `);

  // evidence 的提取结果与证据简报（设计稿 §5）。全部可空、不回填：存量证据没被提取过，
  // 给 extracted_text 塞空串会让「提取出来是空的」（扫描件全黑）与「没提取过」在读侧长得一样。
  //
  // 【为什么 extraction_status 有默认值而其余没有】它是状态机的起点，必须有个确定的初值，
  // 否则每个读点都得自己决定 NULL 算 none 还是算未知——那就是五个读点五种算法。
  // 值域 none|queued|running|done|failed，与 extraction_jobs.status 同名同物（多一档 none=从没排过队）。
  //
  // 【brief_version 从 0 起，不从 1 起】0 = 还没有简报。乐观锁的 base_version 拿 0 去更新，
  // 与「拿着第 1 版去更新第 1 版」是两件事；起点设成 1 会让「从没写过」冒充「写过一版」。
  // brief_updated_by 记 web | agent:<key_id> | system——简报是给后续 agent 看的判断依据，
  // 「这句话是谁写的」必须能查，否则模型自己写的推测过两轮就被当成了用户确认过的事实。
  addColumnIfMissing(db, 'evidence', 'extraction_status', "TEXT NOT NULL DEFAULT 'none'");
  addColumnIfMissing(db, 'evidence', 'extracted_text', 'TEXT');
  addColumnIfMissing(db, 'evidence', 'extracted_meta_json', 'TEXT');
  addColumnIfMissing(db, 'evidence', 'extracted_at', 'TEXT');
  addColumnIfMissing(db, 'evidence', 'brief_json', 'TEXT');
  addColumnIfMissing(db, 'evidence', 'brief_version', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'evidence', 'brief_updated_by', 'TEXT');
  addColumnIfMissing(db, 'evidence', 'brief_updated_at', 'TEXT');

  // extraction_jobs.refunded_at：这条提取任务最终失败后**原路退款的时刻**。
  // NULL = 没退过（还没失败，或这单本来就没扣钱/没找到可退的报价）。
  //
  // 【为什么要一列，不从账本推】退款幂等由 gongdaoRefund 的 refund-<order_ref> 兜底，
  // 但「这条任务退过没有」若靠去账本里找那笔 refund 行来判，就得在 worker 收尾的事务里
  // 反查 ledger——而 worker 手里只有 job 和它的 quote_id。落一列 refunded_at 作**任务维度**
  // 的抢占键（UPDATE ... WHERE id=? AND refunded_at IS NULL，按 changes 判抢到），
  // 「重启回收后再失败」这类把收尾路径又走一遍的形态，第二遍当场 changes=0 直接退出，
  // 既不重复退款、也不重复调券归还。可空、不回填：存量任务没退过款，NULL 即语义正确。
  addColumnIfMissing(db, 'extraction_jobs', 'refunded_at', 'TEXT');

  // ───────────────── 费率种子 ─────────────────
  // C01 核定的模型费率必须**在建表之后立刻播下去**：缺行时 getRatesForModel 会回落
  // DEFAULT_RATES（最便宜的 Flash 档），于是每一笔账都按兜底价少收——而账面看起来完全正常。
  // 2026-08-25 生产冒烟实证：model_rates 0 行。**有 seed 函数不等于 seed 过**，
  // 所以种子挂在迁移路径上（每次开库都走），而不是等谁记得手动跑一次。
  // 幂等由 (model, token_kind, effective_at) 唯一索引 + INSERT OR IGNORE 保证：反复开库行数不变。
  seedModelRates(db);
}
