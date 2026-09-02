// app/src/lib/agent/__tests__/action-card-correction-render.test.tsx
// 【纠正段要**在屏幕上**成立，不只是在字符串里成立】
//
// ─────────────── 这组补的是哪个缺口 ───────────────
// 复审 2026-09-02（RV2-②）真机 DOM 实测：那一段渲染出来是
//   <p>**补一句实话：这一轮我没能把行动卡挂进你的档案。**上面正文里…</p>
// **strong 计数 0**——加粗没生效，两串星号原样摊在用户眼前。
//
// 根因是 CommonMark 的 right-flanking 规则，不是渲染器的毛病：
// 闭合的 `**` 前面是「。」（Unicode 标点）、后面是「上」（既非空白也非标点），
// 「前接标点」这一支要求「后接空白或标点」才算右侧贴合——两条都不满足，
// 于是那两个星号**不成其为闭合定界符**，整对加粗作废。
// 中文里「加粗句以句号收尾、紧接着下一句」是最自然的写法，所以这个坑会反复踩。
//
// 修法：让这一句**自成一段**（闭合 `**` 之后跟空行），右侧是空白就能闭合。
//
// 【为什么判据走真渲染器而不是自己写正则】问题恰恰出在"字符串看着没错"上：
// 源码里那对星号成双成对，只有把它交给 markdown 解析器才知道它闭不闭合。
// 所以这里用产线上真在用的那个组件（RichText → react-markdown + remark-gfm）
// 出 DOM，再数 strong 节点——判的是用户屏幕上的事实。
//
// 【两层一起判】① strong 节点计数 1（加粗真生效）；② 剥光标签后**一个裸 `**` 都不许剩**
// （只判①会漏掉"标签出了、星号也还在"那一半，那正是 RichText 那组测试文件头写过的教训）。
//
// 【变异臂】
//  · M-C1 去掉加粗句后面的 `\n\n`（退回复审当天那个形态）⇒ ①②一起红
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { runTurn } from '../orchestrator';
import { fixtureSearcher, makeAgentFixture, makeSink, scriptedProvider, type AgentFixture } from './fixtures';

vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, setDiscreet: () => {}, toggle: () => {} }),
}));

const { RichText } = await import('@/app/(app)/case/[id]/_components/RichText');

/** 真机那一轮的原话：模型只在正文里承诺，一次 action_card 都没调 */
const PROMISE = '两张行动卡已挂上，系统会按截止时间提醒你。';
/** 纠正段里那句必须被加粗的实话（逐字，含句号） */
const BOLD_LINE = '补一句实话：这一轮我没能把行动卡挂进你的档案。';

/** 跑一轮"承诺了却没有卡"的对话，取归档正文——判据要判的是**存进库里的那段** */
async function archivedContent(): Promise<string> {
  const f: AgentFixture = makeAgentFixture();
  const sink = makeSink();
  await runTurn({
    db: f.db,
    caseId: f.caseId,
    userId: f.userId,
    message: 'HR 让我三天内签自愿离职协议，我该不该签？',
    provider: scriptedProvider([{ text: `先落档。${PROMISE}` }]),
    searcher: fixtureSearcher(),
    emit: sink.emit,
    now: new Date('2026-08-19T12:40:00Z'),
  });
  const row = f.db
    .prepare("SELECT content FROM messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 1")
    .get() as { content: string | null } | undefined;
  expect(row?.content, '前提：这一轮正常收尾了，判据才有东西可渲染').toBeTruthy();
  return row!.content!;
}

const ssr = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);
/** 剥光标签之后用户眼里剩下的那些字 */
const visible = (markup: string) => markup.replace(/<[^>]+>/g, '');

describe('★纠正段在真渲染器里必须真加粗（不是字面星号）', () => {
  it('归档正文交给产线渲染器 ⇒ strong 节点 1 个，且正是那句实话', async () => {
    const html = ssr(<RichText text={await archivedContent()} />);

    const strongs = [...html.matchAll(/<strong[^>]*>(.*?)<\/strong>/g)].map((m) => m[1]);
    expect(strongs, `加粗没闭合：${html.slice(0, 200)}`).toHaveLength(1);
    expect(strongs[0]).toBe(BOLD_LINE);
  });

  it('屏幕上一个裸 `**` 都不许剩（标签出了、星号也还在，是同一个 bug 的另一半）', async () => {
    const html = ssr(<RichText text={await archivedContent()} />);
    expect(visible(html), '星号原样摊给了用户').not.toContain('**');
  });

  it('纠正段的其余两句照旧在正文里（自成一段不等于丢字）', async () => {
    const text = visible(ssr(<RichText text={await archivedContent()} />));
    expect(text).toContain('以这一行为准——档案里现在没有这几张卡。');
    expect(text, '给出路，不是只报错').toContain('你回我一句「把上面几件事记进档案」，我就补上。');
  });
});
