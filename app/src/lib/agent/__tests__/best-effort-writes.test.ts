// app/src/lib/agent/__tests__/best-effort-writes.test.ts
// 【记录性写库不许掀翻这一轮】收尾段排在 `finalizeMessage` 之前的那几处写库，
// 一处抛异常就是 **content 停在 NULL、这一轮不记账**——F-02 的形状，只是换了个病灶。
//
// ─────────────── 这组补的是哪个缺口 ───────────────
// 复审 2026-09-02（RV2-①）故障注入实测：上一轮给 `tryOffer` 与 `recordCrisisCardGiven`
// 各包了一层 try/catch，**漏掉了排在它们前面的杠杆闸留痕**。给库加一条
//   BEFORE INSERT ON timeline_events WHEN NEW.title='危机轮杠杆闸拦截' RAISE(ABORT)
// 之后，危机轮 content NULL、token_usage 0、gongdao_ledger 0——用户刚说完"要是人没了"，
// 那一轮的正文和账一起没了。
//
// 【为什么修法是"收入口"而不是"再补第三个 try"】独立写 N 次就会忘第 N 次，
// 那是默认形态而不是疏忽。所以三处全部改走 `bestEffort`，并由**结构守卫**钉住
// 「finalizeMessage 之前不许有裸的记录性写库调用」：以后新增同类写库，守卫会点名，
// 而不是等下一次故障注入才发现。
//
// 【判据分两层，缺一层就抓不住对应的退化】
//  ① 结构层：源码里那一段不许出现裸调用（改回裸调用即红）；
//  ② 行为层：故障注入真跑一轮，content 非 NULL、usage 1、ledger 1（去掉 bestEffort 即红）。
// 只有①会退化成"包了个 try 但吞错了东西"；只有②会漏掉下一处新写库。
//
// 【变异臂】
//  · M-B1 杠杆闸留痕改回裸 cases.addTimelineEvent(...)     ⇒ ①②一起红
//  · M-B2 tryOffer 改回裸调用                              ⇒ ①红
//  · M-B3 recordCrisisCardGiven 改回裸调用                 ⇒ ①红
//  · M-B4 bestEffort 不再吞异常（catch 里 throw err）      ⇒ ②红
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { runTurn } from '../orchestrator';
import { fixtureSearcher, makeAgentFixture, makeSink, scriptedProvider, type AgentFixture } from './fixtures';

/* ── ① 结构守卫：finalizeMessage 之前不许有裸的记录性写库 ──────────────── */

const SRC = readFileSync(new URL('../orchestrator.ts', import.meta.url), 'utf8');

/**
 * 只扫 `runTurn` 开头到 `finalizeMessage` 之间那一段。
 *
 * 【为什么不整文件 grep】`finalizeMessage` **之后**的调用是合法的——那时正文与账都已落地，
 * 再抛也只是丢一条记录。整文件扫会把合法调用一起判红，那种守卫第一次误报就会被人删掉。
 * 两个锚点各自 count==1 先自检：锚点漂了就明说"守卫定位不到"，而不是安静地扫了个空区间
 * （空区间里当然没有裸调用，那是**假绿**）。
 */
function preFinalizeRegion(): string {
  const START = 'export async function runTurn(';
  const END = 'store.finalizeMessage(db, messageId, {';
  const nStart = SRC.split(START).length - 1;
  const nEnd = SRC.split(END).length - 1;
  expect(nStart, `守卫定位不到起点「${START}」（count=${nStart}）：锚点改了就把这条守卫一起改`).toBe(1);
  expect(nEnd, `守卫定位不到终点「${END}」（count=${nEnd}）：锚点改了就把这条守卫一起改`).toBe(1);
  return SRC.slice(SRC.indexOf(START), SRC.indexOf(END));
}

/** 排在 finalizeMessage 之前的记录性写库，逐个点名 */
const RECORDING_WRITES: Array<[string, RegExp]> = [
  ['危机轮杠杆闸留痕', /cases\.addTimelineEvent\(/g],
  ['推荐位点占位', /referralOffers\.tryOffer\(/g],
  ['危机资源卡留痕', /store\.recordCrisisCardGiven\(/g],
];

describe('结构守卫：finalizeMessage 之前的记录性写库，一处都不许是裸调用', () => {
  it.each(RECORDING_WRITES)('%s 必须经 bestEffort 调用', (label, pattern) => {
    const region = preFinalizeRegion();
    const hits = [...region.matchAll(pattern)];
    // 前提自检：这一段里确实有这处调用。搬走 / 改名之后守卫会空跑，那比不设守卫更糟。
    expect(hits.length, `${label}：这一段里一处都没找到——是搬到 finalizeMessage 之后了，还是改名了？守卫需要同步更新`)
      .toBeGreaterThan(0);

    for (const hit of hits) {
      const before = region.slice(0, hit.index).trimEnd();
      // 形状必须是 `bestEffort('…', () => <写库调用>, <fallback>)`：
      // 紧邻的前一个非空白 token 是箭头，且同一条语句里带着 bestEffort。
      expect(before.endsWith('=>'), `${label}：这是个裸调用（前面是「${before.slice(-40)}」），一抛就把正文与账一起带走`)
        .toBe(true);
      expect(before.slice(-240), `${label}：包在了别的东西里，不是 bestEffort`).toContain('bestEffort(');
    }
  });

  it('入口本身还在，且吞异常返回 fallback（守卫扫的那个名字不是空壳）', () => {
    expect(SRC).toMatch(/function bestEffort<T>\(label: string, fn: \(\) => T, fallback: T\): T \{/);
    expect(SRC, '吞掉但不静音：失败要能从服务端日志查到').toMatch(/console\.error\(`\[chat\] \$\{label\}`, err\)/);
    expect(SRC, 'catch 里必须返回 fallback，不是再抛一次').toMatch(/catch \(err\) \{\s*console\.error\(`\[chat\] \$\{label\}`, err\);\s*return fallback;/);
  });
});

/* ── ② 行为层：故障注入，把杠杆闸留痕的写路径打断 ─────────────────────── */

/** 用户说出自伤念头的那一轮（与 orchestrator.test.ts 的 CRISIS 同形） */
const CRISIS = '有时候半夜想，要是人没了是不是就不用还房贷了，也不用对不起爸妈了。就是想想，你别紧张。';
/** 一句会被杠杆闸剥掉的模型正文 ⇒ leverageOutcome = 'stripped' ⇒ 走留痕那条路 */
const LEVERAGE_BODY = '我听见了。你走了他们怎么办？现在告诉我你在哪、身边有没有人。';

/**
 * 故障注入 = 只打断**这一条**写路径（BEFORE INSERT + WHEN 精确到 title），
 * 让 `cases.addTimelineEvent` 真的抛一个 SqliteError。
 *
 * 【为什么带 WHEN 而不是拦所有 timeline_events 的 INSERT】拦全部会连 tool-loop 里的
 * `timeline_add` 一起断，那时红的是另一段路——判据看着红，量的却不是这处（先审量具再信读数）。
 */
function fixtureWithBrokenLeverageTrace(): AgentFixture {
  const f = makeAgentFixture();
  f.db.exec(
    "CREATE TRIGGER leverage_trace_broken BEFORE INSERT ON timeline_events " +
      "WHEN NEW.title = '危机轮杠杆闸拦截' " +
      "BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;",
  );
  return f;
}

async function crisisTurn(f: AgentFixture) {
  const sink = makeSink();
  const result = await runTurn({
    db: f.db,
    caseId: f.caseId,
    userId: f.userId,
    message: CRISIS,
    provider: scriptedProvider([{ text: LEVERAGE_BODY }]),
    searcher: fixtureSearcher(),
    emit: sink.emit,
    now: new Date('2026-08-19T12:40:00Z'),
  });
  return { f, sink, result };
}

function traces(f: AgentFixture) {
  const one = <T>(sql: string, ...args: unknown[]): T => f.db.prepare(sql).get(...(args as [])) as T;
  return {
    content: one<{ content: string | null } | undefined>(
      "SELECT content FROM messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 1",
    )?.content,
    leverageTraces: one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM timeline_events WHERE case_id = ? AND title = '危机轮杠杆闸拦截'", f.caseId,
    ).n,
    usage: one<{ n: number }>('SELECT COUNT(*) AS n FROM token_usage WHERE user_id = ?', f.userId).n,
    ledger: one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM gongdao_ledger WHERE user_id = ? AND type = '消耗'", f.userId,
    ).n,
  };
}

describe('★故障注入：杠杆闸留痕写库断了，这一轮照样落库、照样记账', () => {
  it('正对照：库好的时候留痕真会写（否则下面那条是在测一件根本不发生的事）', async () => {
    const { f, sink } = await crisisTurn(makeAgentFixture());
    const t = traces(f);
    expect(t.leverageTraces, '前提：这一轮确实会写这条留痕').toBe(1);
    expect(sink.of('notice').map((e) => e.data.code)).toContain('EMOTIONAL_LEVERAGE_DETECTED');
  });

  it('留痕 INSERT 抛异常 ⇒ runTurn 不抛，正文照样回填、账照样记', async () => {
    const { f, result } = await crisisTurn(fixtureWithBrokenLeverageTrace());

    expect('ok' in result && result.ok, '一条留痕写失败把整轮危机对话弄丢了').toBe(true);
    const t = traces(f);
    expect(t.leverageTraces, '前提：注入确实拦住了这条 INSERT').toBe(0);
    expect(t.content, '正文停在 NULL = 刷新即永久消失（F-02 原样复发）').not.toBeNull();
    expect(t.content, '危机轮的确定性首段是这一轮最不能丢的东西').toContain('我在。');
    expect(t.usage, 'token_usage：模型的钱已经花掉了').toBe(1);
    expect(t.ledger, 'gongdao_ledger 消耗流水').toBe(1);
  });

  it('留痕断了，用户侧该有的通知一个不少（丢的只是那条统计）', async () => {
    const { sink } = await crisisTurn(fixtureWithBrokenLeverageTrace());
    expect(sink.of('notice').map((e) => e.data.code)).toContain('EMOTIONAL_LEVERAGE_DETECTED');
    expect(sink.of('done'), '收尾帧照发').toHaveLength(1);
  });
});
