// app/src/lib/agent/__tests__/consent-emotion.test.ts
// 情绪记录的单独同意闸（协议 五.2（2）/ 附一 #4）。**两臂**：
//   · 没同意 ⇒ emotion_log 零写入 + 回复末尾出现那句征求同意的话；
//   · 同意了 ⇒ 照常写入，且**不再多问一遍**。
//
// 【为什么两臂都要，只测一臂不够】只测"没同意就不写"的形态是：有人把闸写成恒真
// （谁都不许写），用例照样绿，而产品从此一条情绪都记不下来。只测"同意了能写"的形态
// 更常见：闸根本没生效，而所有用例用的都是同意过的夹具人，于是全绿。
// 两臂之间只差**一行 consents**，其余输入逐字相同——单变量对照。
//
// 【为什么闸的行为要连着"那句话"一起测】拒绝而不问，等于用户被静默拒了一次：
// 他不知道自己可以同意，也不知道刚才那一轮什么都没记下。这两件事必须同一轮发生。
//
// 【变异矩阵】2026-09-07 逐条实跑确认（改 orchestrator.ts、跑本文件、再改回）：
//  · M-1 闸恒放行（`if (false && name === EMOTION_TOOL && !emotionConsented())`）
//        ⇒ 4 失败 / 2 通过。没同意也照写，且没人问他。
//  · M-2 末尾征求同意那段恒不执行
//        ⇒ 2 失败 / 4 通过。写是拦住了，但用户被静默拒——他不知道自己可以同意。
//  · M-3 闸恒拒（`if (name === EMOTION_TOOL)`，不看同意）
//        ⇒ 2 失败 / 4 通过。同意过的人也记不下来（"闸装反了"这一形态）。
//  · M-5 同意状态退回**本轮开头算一次**（`const _ec = hasConsent(...)`）
//        ⇒ 1 失败 / 5 通过。恰好是"同一轮里 consent_grant 之后那一笔仍被拒"那条——
//        这条判据写出来时就是红的，产线代码据它改成了每次现查（见 orchestrator.ts
//        emotionConsented 的抬头）。
import { describe, expect, it } from 'vitest';

import { CONSENT_KINDS, EMOTION_CONSENT_ASK, EMOTION_CONSENT_TOOL_REJECT } from '@/lib/consent';
import { hasConsent, recordConsent } from '@/lib/db/consents';

import { runTurn } from '../orchestrator';
import { CRISIS_RESOURCE_PACK_ID } from '../crisis';
import {
  FIXTURE_PACK,
  fixtureSearcher,
  makeAgentFixture,
  makeSink,
  scriptedProvider,
  type AgentFixture,
} from './fixtures';

/** 夹具默认给 userId 记了 emotion 同意（见 fixtures.ts）。这一臂要的是**没同意**的人。 */
function withoutEmotionConsent(f: AgentFixture): AgentFixture {
  f.db.prepare("DELETE FROM consents WHERE user_id=? AND kind='emotion'").run(f.userId);
  expect(hasConsent(f.db, f.userId, CONSENT_KINDS.emotion), '前提自检：这一臂的人必须是没同意过的').toBe(false);
  return f;
}

const MESSAGE = '这两周一直睡不着，一想到还要跟他们耗就喘不上气。';
/** 模型这一轮说了句正文，并要记一笔情绪 —— 两臂用的是**同一份剧本** */
const SCRIPT = [
  { text: '我在听。', tools: [{ name: 'emotion_log', args: { level: '焦虑', note: '连续失眠，谈及对抗时呼吸困难' } }] },
  { text: '先把手头这件事拆成一步。' },
];

async function turn(f: AgentFixture) {
  const sink = makeSink();
  const provider = scriptedProvider(SCRIPT);
  const result = await runTurn({
    db: f.db,
    caseId: f.caseId,
    userId: f.userId,
    message: MESSAGE,
    provider,
    searcher: fixtureSearcher(),
    emit: sink.emit,
    now: new Date('2026-09-07T10:00:00Z'),
  });
  return { sink, provider, result };
}

const emotionRows = (f: AgentFixture) =>
  (f.db.prepare('SELECT COUNT(*) AS n FROM emotion_log WHERE case_id=?').get(f.caseId) as { n: number }).n;

/** 落库的那条正文（用户刷新之后看到的东西，与流上发出去的必须是同一份） */
const storedText = (f: AgentFixture) =>
  String(
    (
      f.db
        .prepare(
          "SELECT m.content AS content FROM messages m JOIN threads t ON t.id = m.thread_id " +
            "WHERE t.case_id = ? AND m.role = 'assistant' ORDER BY m.id DESC LIMIT 1",
        )
        .get(f.caseId) as { content: string | null } | undefined
    )?.content ?? '',
  );

describe('情绪记录的单独同意：没同意那一臂', () => {
  it('零写入，且模型拿到的是"没写进去、别声称记下了"的回喂', async () => {
    const f = withoutEmotionConsent(makeAgentFixture());
    const { provider } = await turn(f);

    expect(emotionRows(f), '没同意就一行都不该写').toBe(0);

    // 回喂给模型的那条 tool 消息：必须说清没写、且原样重试也不会成功。
    // 【为什么连回喂一起断言】只拒不说的形态是——模型下一轮换个参数重试，
    // 或者干脆在正文里写"我已经记下了"，而库里一个字都没有。
    const toolMessages = provider.calls.at(-1)?.filter((m) => m.role === 'tool') ?? [];
    expect(toolMessages.length, '这一轮应该有一条工具回喂').toBeGreaterThan(0);
    expect(toolMessages.map((m) => m.content).join('\n')).toContain(EMOTION_CONSENT_TOOL_REJECT);
  });

  it('回复末尾**确定性追加**那句征求同意的话，且它进了归档', async () => {
    const f = withoutEmotionConsent(makeAgentFixture());
    const { sink } = await turn(f);

    // 流上：作为 deterministic delta 发出（不是模型自己说的）
    const deterministic = sink.events
      .filter((e) => e.event === 'delta' && (e.data as { deterministic?: boolean }).deterministic === true)
      .map((e) => (e.data as { text: string }).text)
      .join('');
    expect(deterministic, '那句话必须由代码发，不能指望模型自己问').toContain(EMOTION_CONSENT_ASK.trim());

    // 归档：刷新页面之后还看得见"我们问过"
    expect(storedText(f), '没进归档等于刷新一下就查无此问').toContain(EMOTION_CONSENT_ASK.trim());
  });
});

describe('情绪记录的单独同意：同意了那一臂', () => {
  it('照常写入，且**不再多问一遍**（同一份剧本，只多了一行 consents）', async () => {
    const f = makeAgentFixture(); // 夹具默认已同意
    expect(hasConsent(f.db, f.userId, CONSENT_KINDS.emotion)).toBe(true);
    const { sink } = await turn(f);

    expect(emotionRows(f), '同意过就该照常记').toBe(1);
    const row = f.db.prepare('SELECT level FROM emotion_log WHERE case_id=?').get(f.caseId) as { level: string };
    expect(row.level).toBe('焦虑');

    // 已经同意过的人再被问一次，会把它读成"我上次点的没生效"
    const all = sink.events
      .filter((e) => e.event === 'delta')
      .map((e) => (e.data as { text: string }).text)
      .join('');
    expect(all).not.toContain(EMOTION_CONSENT_ASK.trim());
    expect(storedText(f)).not.toContain(EMOTION_CONSENT_ASK.trim());
  });

  it('consent_grant 记完之后，同一个人下一轮就写得进去了（对话里那条路真的走得通）', async () => {
    const f = withoutEmotionConsent(makeAgentFixture());

    // 第一轮：被拦，零写入
    await turn(f);
    expect(emotionRows(f)).toBe(0);

    // 用户答应了 → 模型调 consent_grant（工具白名单里唯一允许的那一类）
    const sink = makeSink();
    await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: '同意记录。',
      provider: scriptedProvider([
        { text: '好。', tools: [{ name: 'consent_grant', args: { kind: 'emotion', said: '同意记录' } }] },
        { text: '那我记一笔。', tools: [{ name: 'emotion_log', args: { level: '焦虑', note: '连续失眠' } }] },
        { text: '先把手头这件事拆成一步。' },
      ]),
      searcher: fixtureSearcher(),
      emit: sink.emit,
      now: new Date('2026-09-07T10:05:00Z'),
    });

    expect(hasConsent(f.db, f.userId, CONSENT_KINDS.emotion), 'consent_grant 要真的落台账').toBe(true);
    expect(emotionRows(f), '同一轮里记完同意之后那一笔就该写得进去').toBe(1);
  });

  it('consent_grant 记不了协议与境外那两类（那两样必须在网页上亲手点）', async () => {
    const f = withoutEmotionConsent(makeAgentFixture());
    const sink = makeSink();
    await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: '都同意都同意。',
      provider: scriptedProvider([
        { text: '好。', tools: [{ name: 'consent_grant', args: { kind: 'overseas' } }] },
        { text: '这一项要你自己在设置页点。' },
      ]),
      searcher: fixtureSearcher(),
      emit: sink.emit,
      now: new Date('2026-09-07T10:10:00Z'),
    });

    // 【为什么这条要单独测】模型在对话里替用户"顺手同意"把对话交给境外接收方，
    // 是这套工具最坏的失效形态：它有一句用户说过的"都同意"当依据，回包也一切正常。
    expect(hasConsent(f.db, f.userId, CONSENT_KINDS.overseas), '境外同意不许由对话里的一句话推出来').toBe(false);
    expect(
      (f.db.prepare('SELECT COUNT(*) AS n FROM consents WHERE user_id=?').get(f.userId) as { n: number }).n,
      '一行都不该落',
    ).toBe(0);
  });
});

describe('危机轮：告知不阻断，情绪那一笔照样受闸管', () => {
  /**
   * 【这条盯的是两件事不能互相牵连】
   * 危机首段（号码）**不能被任何闸拦**——即使这个人没同意过情绪记录；
   * 而同一轮里那笔情绪记录仍然不写。把它们混成一件事的形态有两种，都很像"正常"：
   * ① 因为没同意，危机首段也不发了（用户在最坏的时刻拿不到号码）；
   * ② 因为是危机轮，情绪记录就绕过闸写了（我们承诺过要先问）。
   */
  const CRISIS = '有时候半夜想，要是人没了是不是就不用还房贷了。就是想想，你别紧张。';

  /**
   * 危机资源卡按 id 取（与 orchestrator.test.ts 同形的夹具）。
   * **不能用默认的 fixtureSearcher**：那时一条热线都取不到，首段落到"事故态"那支
   * （只剩一句「我在」），于是这条判据量的就不是"号码没被闸拦住"，而是"卡没装载"。
   */
  const RESOURCE_PACK = {
    ...FIXTURE_PACK,
    id: CRISIS_RESOURCE_PACK_ID,
    type: '数据卡',
    title: '北京免费求助资源卡',
    body: '## 心理热线\n\n- 12356 全国统一心理援助热线（24 小时）',
    facts: {
      hotlines: [
        {
          name: '全国统一心理援助热线',
          phone: '12356',
          category: 'crisis' as const,
          status: 'usable' as const,
          hours: '24小时',
        },
      ],
    },
  };
  const crisisSearcher = {
    search: () => [],
    get: (id: string) => (id === CRISIS_RESOURCE_PACK_ID ? RESOURCE_PACK : undefined),
  };

  it('没同意的人遇到危机轮：号码照给，情绪零写入，同意照问', async () => {
    const f = withoutEmotionConsent(makeAgentFixture());
    const sink = makeSink();
    await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: CRISIS,
      provider: scriptedProvider([
        { text: '我听见了。', tools: [{ name: 'emotion_log', args: { level: '严重', note: '自伤念头' } }] },
        { text: '现在告诉我你在哪、身边有没有人。' },
      ]),
      searcher: crisisSearcher,
      emit: sink.emit,
      now: new Date('2026-09-07T11:00:00Z'),
    });

    const text = storedText(f);
    expect(text, '危机首段不能被任何闸拦——号码必须在').toContain('12356');
    expect(emotionRows(f), '危机轮也不例外：没同意就不写').toBe(0);
    expect(text, '被挡下了就要问一句，不能悄悄什么都没记').toContain(EMOTION_CONSENT_ASK.trim());
  });
});
