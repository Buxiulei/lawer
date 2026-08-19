// app/src/lib/db/migrate.ts
//
// lawer 数据层第一阶段：全量表结构。一律 CREATE TABLE / INDEX IF NOT EXISTS，
// 建表段之后是「存量迁移区」（见文件末尾）：已上线的库补列走 addColumnIfMissing，
// 不回填、不改数据——本文件反复执行必须幂等且无副作用。
// 通用约定：id 一律 INTEGER PRIMARY KEY AUTOINCREMENT；created_at TEXT DEFAULT (datetime('now'))；
// 布尔用 INTEGER 0/1；金额单位「分」（*_fen）；外键全部显式 REFERENCES（client 恒开 foreign_keys=ON）。
import type Database from 'better-sqlite3';

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
  db.exec(`
    CREATE TABLE IF NOT EXISTS deadlines (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id              INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      kind                 TEXT NOT NULL,                   -- 仲裁时效|起诉15日|上诉15日|举证期限|开庭|申请执行2年|自定义
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

  // 文书草稿：version 随每次改稿递增（同 kind 多版并存，用户可回看上一版措辞）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS drafts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id    INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,                             -- 异议函|被迫解除通知|仲裁申请书|证据清单|答辩状|上诉状|谈判话术|其他
      title      TEXT NOT NULL,
      content    TEXT,
      version    INTEGER NOT NULL DEFAULT 1,
      status     TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

  // ───────────────── 存量迁移区 ─────────────────
  // 上面的建表段只对新库生效（IF NOT EXISTS 不改已存在的表），已上线的库补列一律走这里。
  // 只加列、不回填、不改语义：老行的新列取 NULL / DDL 默认值，读侧必须容得下这个缺省。

  // threads.intake_stage：问诊状态机进度落痕。值集当前 A|B|C|D|done（D 档=特殊保护已问过），
  // 由 lib/agent 就近维护并提供写入口——本列**不加 DB 级 CHECK**：状态机是推导式（不存游标，
  // 本列只是补充落痕），SQLite 改 CHECK 要重建表，为其锁枚举得不偿失（manager 2026-08-19 裁决）。
  // NULL = 非问诊线程，或问诊线程尚未进入状态机。
  // WS2 此前借 timeline_events.kind='系统动作' 落痕记录进度，本列落地后切换到本列。
  addColumnIfMissing(db, 'threads', 'intake_stage', 'TEXT');
}
