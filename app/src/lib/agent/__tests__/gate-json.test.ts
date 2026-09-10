// app/src/lib/agent/__tests__/gate-json.test.ts
//
// 【本轮闸信号必须落在这一轮的 assistant 行上】（messages.gate_json）
//
// ─────────────── 这组补的是哪个缺口 ───────────────
// 在此之前 notice 与 gate_report **只走 SSE**：浏览器读完即弃（词表里标静默的连读都不读），
// 服务端 `emit()` 只转发、不落盘、不打日志。于是这些问题在产线上无从回答：
//   · ⑨ 观察期的误标率是多少（切 rewrite 的判据恰恰要这个数）；
//   · 哪几轮的替换率超了预算（超了要去查闸，不是去调提示词）；
//   · 事故级的 CRISIS_PAID_CONTENT_BLOCKED 这个月开过几次火。
// 唯一有这些数的地方是**离线跑批**的归档（scripts/eval/report.ts），而那是我们自己造的
// 样本，不是真实用户那几轮。（frames.ts 里原先那句「走的是运维通道与归档」在仓库里没有
// 对应实现；这一票把注释与实现对齐——落的就是这一列。）
//
// 【本组不管的那一半】刷新之后这些提示行不会回来：notice 是流帧，历史行取的是
// listCaseMessages 那几列。这一列现在只写不读，读侧（离线 SQL 之外）另票。
//
// 【变异臂】
//  · M1 orchestrator 不传 gateJson（回到只写 content/tokens_json） ⇒ 「两个码 + 摘要」红
//  · M2 采集点从 emit 挪到某几处 emit 调用点（漏掉其中一处）      ⇒ 「码齐全」红
//  · M3 finalizeMessage 改成 INSERT 一行新的而不是 UPDATE 这一行   ⇒ 「重放不重复写」红
//  · M4 migrate.ts 去掉 gate_json 那一列                          ⇒ 整组红（建表即失败）
import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from '@/lib/db/migrate';
import * as store from '@/lib/db/agent';

import { runTurn } from '../orchestrator';
import { VALUE_GUARD_MODE } from '../gate-chain';
import type { AgentEvent } from '../events';
import { makeAgentFixture, makeSink, scriptedProvider, fixtureSearcher, FIXTURE_PACK } from './fixtures';

/** 与 gate-chain.test.ts 第五节同款：一张行动卡，免得这一轮因为「没产出卡」而走上补救路 */
const CARD = {
  name: 'action_card',
  args: {
    what: '把解除通知转发到个人邮箱',
    how: '公司邮箱 → 私人邮箱',
    why: '权限随时可能被停',
    due_at: '2026-08-27T18:00:00+08:00',
  },
};

interface GateJson {
  v: number;
  codes: string[];
  gate: { gates: Record<string, { seen: number; fired: number }>; replace_rate: number; leaked: number } | null;
}

/**
 * 跑一轮真编排，回读那一行的 gate_json。
 * 用**真库**（夹具跑的是 runMigrations 建的内存库），因为这条判据问的正是"库里有没有"。
 */
async function turn(text: string) {
  const f = makeAgentFixture();
  const sink = makeSink();
  const result = await runTurn({
    db: f.db,
    caseId: f.caseId,
    userId: f.userId,
    message: '我想知道能拿多少钱。',
    provider: scriptedProvider([{ text, tools: [CARD] }] as never),
    searcher: fixtureSearcher([FIXTURE_PACK]),
    emit: sink.emit,
    now: new Date('2026-08-26T12:00:00Z'),
  });
  if (!('ok' in result) || !result.ok) throw new Error(`本轮未成功：${JSON.stringify(result)}`);
  const row = f.db
    .prepare('SELECT gate_json FROM messages WHERE id = ?')
    .get(result.messageId) as { gate_json: string | null };
  const notices = sink.events.filter((e) => e.event === 'notice') as Extract<AgentEvent, { event: 'notice' }>[];
  return { f, result, row, notices, gate: row.gate_json === null ? null : (JSON.parse(row.gate_json) as GateJson) };
}

describe('一、一轮命中两闸 → 这一行记着两个码与闸链摘要', () => {
  /**
   * 这一句同时踩 ⑥（夹具卡里没有原文的条号）与 ⑨（60 万既不在卡里也不是算出来的）。
   * ⑨ 当前是观察模式（正文不动），**notice 照发**——这正是要落库的那一类信号：
   * 它在用户面完全看不见，不落库就只存在于一条转瞬即逝的 SSE 帧里。
   */
  const TWO_GATES = '依《某某某某法》第四十八条，这一项一般封顶 60 万。';

  it('★两个闸的码都在，闸链摘要也在（去掉落库 → 红）', async () => {
    const { gate } = await turn(TWO_GATES);
    expect(gate, 'gate_json 是空的：这一轮闸干了什么，库里没有').toBeTruthy();
    expect(gate!.codes).toContain('STATUTE_UNVERIFIED');
    expect(gate!.codes).toContain('VALUE_UNSOURCED');
    expect(gate!.gate, '闸链汇总没落盘：替换率与漏网率只能从中文 message 里反推').toBeTruthy();
    expect(typeof gate!.gate!.replace_rate).toBe('number');
    expect(gate!.gate!.gates.statute_guard).toMatchObject({ fired: expect.any(Number) });
  });

  it('落盘的码与这一轮真发出去的 notice 逐条对得上（采集点漏一处 → 红）', async () => {
    const { gate, notices } = await turn(TWO_GATES);
    // PROMPT_CACHE 排在结清之后，按设计不进这一列（见 orchestrator 的 gateCodes 注释）
    const emitted = notices.map((n) => n.data.code).filter((c) => c !== 'PROMPT_CACHE');
    expect(gate!.codes).toEqual(emitted);
  });

  it('⑨ 观察期的读数取得到：value_guard 那一格的 seen/fired 在库里', async () => {
    expect(VALUE_GUARD_MODE, '这条判据钉的是观察期那一臂').toBe('observe');
    const { f, gate } = await turn(TWO_GATES);
    expect(gate!.gate!.gates.value_guard).toMatchObject({ seen: expect.any(Number), fired: expect.any(Number) });
    // migrate.ts 注释里写的那句 SQL 真的跑得通（写在注释里跑不通的 SQL 与没写一样）
    const read = f.db
      .prepare(
        `SELECT SUM(json_extract(gate_json, '$.gate.gates.value_guard.seen'))  AS seen,
                SUM(json_extract(gate_json, '$.gate.gates.value_guard.fired')) AS fired
           FROM messages WHERE role = 'assistant' AND gate_json IS NOT NULL`,
      )
      .get() as { seen: number | null; fired: number | null };
    expect(read.fired).toBeGreaterThan(0);
  });

  /**
   * 【观察期"用户面静默"与"读数"是两件事（2026-09-10 复审 minor）】⑨ 在 observe 下
   * 不给 chip，于是整条提示行不出现——用户面上一个字都看不到。
   * 那正是这一列存在的理由：**看不见的信号必须落库**，否则它只活在一条转瞬即逝的 SSE 帧里，
   * 而切 rewrite 的判据（误标率 < 2%）恰恰要靠这几轮的读数算。
   *
   * 变异臂：把观察期那一支从"不给 suggest"写成"不发 notice" ⇒ 这一条红（码没了、读数也没了）。
   */
  it('⑨ 观察期用户面静默，但这一行照样记着它开过火（把 notice 一起吞掉 → 红）', async () => {
    expect(VALUE_GUARD_MODE, '这条判据钉的是观察期那一臂').toBe('observe');
    const { gate, notices } = await turn(TWO_GATES);
    const n = notices.find((e) => e.data.code === 'VALUE_UNSOURCED');
    expect(n, '⑨ 开了火却没发 notice').toBeTruthy();
    expect(n!.data.suggest, '观察期不该有 chip（有 chip 就会画出一条提示行）').toBeUndefined();
    expect(gate!.codes, '用户面看不见的那一条，库里必须有').toContain('VALUE_UNSOURCED');
    expect(gate!.gate!.gates.value_guard.fired, '开过火的读数不许跟着静默一起消失').toBeGreaterThan(0);
  });

  it('干净轮也落盘（"闸一处都没动"与"这一轮不知道闸干了什么"是两件事）', async () => {
    const { gate } = await turn('先把材料理一理，别急着签字。');
    expect(gate, '干净轮没有这一层 → 统计时这几轮会被整段跳过').toBeTruthy();
    expect(gate!.codes).not.toContain('STATUTE_UNVERIFIED');
    expect(gate!.gate).toBeTruthy();
  });
});

describe('二、重放/续流不重复写', () => {
  /**
   * 结清走的是**按主键 UPDATE 这一行**，不是插一行新的。看门狗对账、断线续跑都会
   * 再走一次这条路——追加式写法的形态是：同一轮在库里攒出两三份闸信号，
   * 而离线统计把它们当成两三轮，替换率的分母凭空变大。
   */
  it('同一条消息结清两次 → 仍是一行，值被替换而不是追加', () => {
    const db = new BetterSqlite3(':memory:');
    runMigrations(db);
    db.prepare("INSERT INTO users (phone_hash, auth_status) VALUES ('h', '已实名')").run();
    db.prepare("INSERT INTO cases (user_id, title, stage) VALUES (1, 't', '已收通知')").run();
    db.prepare("INSERT INTO threads (case_id, mode) VALUES (1, '陪跑')").run();
    const id = Number(
      db.prepare("INSERT INTO messages (thread_id, role) VALUES (1, 'assistant')").run().lastInsertRowid,
    );

    const payload = JSON.stringify({ v: 1, codes: ['GATE_REPORT'], gate: null });
    store.finalizeMessage(db, id, { content: '答案', tokensJson: null, gateJson: payload });
    store.finalizeMessage(db, id, { content: '答案', tokensJson: null, gateJson: payload });

    const rows = db.prepare('SELECT gate_json FROM messages WHERE id = ?').all(id) as { gate_json: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].gate_json).toBe(payload);
  });

  it('不传 gateJson 时写 NULL，不用 "{}" 冒充（"不知道"与"闸没动"必须分得开）', () => {
    const db = new BetterSqlite3(':memory:');
    runMigrations(db);
    db.prepare("INSERT INTO users (phone_hash, auth_status) VALUES ('h', '已实名')").run();
    db.prepare("INSERT INTO cases (user_id, title, stage) VALUES (1, 't', '已收通知')").run();
    db.prepare("INSERT INTO threads (case_id, mode) VALUES (1, '陪跑')").run();
    const id = Number(
      db.prepare("INSERT INTO messages (thread_id, role) VALUES (1, 'assistant')").run().lastInsertRowid,
    );
    store.finalizeMessage(db, id, { content: '答案', tokensJson: null });
    const row = db.prepare('SELECT gate_json FROM messages WHERE id = ?').get(id) as { gate_json: string | null };
    expect(row.gate_json).toBeNull();
  });
});
