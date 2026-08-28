/**
 * 低调模式泄漏守卫。
 *
 * 立这组的由头是 #53 那次：`shadcn/empty-state` 迁移时把 `data-veil` 掉了，
 * 三个页面的空状态成了满屏模糊里唯一一段清晰文字——**比全不糊更扎眼**，
 * 而且没有任何报错，靠肉眼才发现。所以新加的每一处正文都要有断言钉着。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// DiscreetProvider 自己要 useRouter，SSR 环境下拿不到；这里只看标记不看运行时状态，
// 直接把 hook 顶掉，固定成「低调关」
vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, toggle: () => {} }),
}));

// next/link 在 Next 的路由上下文之外渲染会抛 invariant；这里只看标记，换成裸 a 即可
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
import { demoDeadlines } from '@/app/_mock/demo';
import { MilestoneTrack } from '../MilestoneTrack';
import { DeadlineTiles } from '../DeadlineTiles';
import { RecentRecords } from '../RecentRecords';
import { DEMO_TRACK, demoAttainments } from '../milestones';

/**
 * 断言的是**标记**（谁挂了 data-veil），不是运行时糊没糊，所以按低调**关**的状态渲染。
 * 糊层怎么实现是 _ui/veil 的事，这里只管「该挂的地方挂没挂」。
 */
const ssr = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

/**
 * 取出所有**没有** data-veil 的可见文字，用来问一句「这一屏上还有什么是清晰的」。
 *
 * 用配对标签的方式整棵子树剔除，不用正则一把梭：正则的非贪婪匹配会停在**第一个**
 * 闭合标签上，遇到嵌套（期限卡就是 data-veil 挂在外层、标题在里层）会少剔一截，
 * 于是守卫看起来在守、其实漏。
 */
const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link']);

function unveiledText(html: string): string {
  const tokens = html.split(/(<[^>]+>)/);
  const out: string[] = [];
  let skipDepth = 0; // >0 表示正在一棵被剔除的子树里
  const stack: string[] = [];

  for (const tok of tokens) {
    if (!tok) continue;
    if (!tok.startsWith('<')) {
      if (skipDepth === 0) out.push(tok);
      continue;
    }
    const closing = tok.startsWith('</');
    const name = (tok.match(/^<\/?([a-zA-Z0-9]+)/)?.[1] ?? '').toLowerCase();
    const selfClosing = tok.endsWith('/>') || VOID_TAGS.has(name);

    if (closing) {
      stack.pop();
      if (skipDepth > 0 && stack.length < skipDepth) skipDepth = 0;
      continue;
    }
    if (selfClosing) continue;
    stack.push(name);
    if (skipDepth === 0 && /\sdata-veil\b/.test(tok)) skipDepth = stack.length;
  }
  return out.join('').replace(/\s+/g, '');
}

describe('里程碑轨道', () => {
  const html = ssr(<MilestoneTrack track={DEMO_TRACK} attainments={demoAttainments()} />);

  it('每一个里程碑名字都在糊层里', () => {
    for (const word of DEMO_TRACK) expect(html).toContain(word); // 正对照：这一屏真的画了这几个格
    const clear = unveiledText(html);
    // 这五个词连起来，不知情的人一眼就知道这台手机在办什么事
    for (const word of DEMO_TRACK) expect(clear).not.toContain(word);
  });

  it('达成日期也在糊层里', () => {
    expect(html).toMatch(/\d{4}\/\d{2}\/\d{2}/); // 正对照
    expect(unveiledText(html)).not.toMatch(/\d{4}\/\d{2}\/\d{2}/);
  });

  it('圆点本身不进糊层——它不含信息，糊了轨道就看不出形状', () => {
    expect(html).toContain('rounded-full');
  });
});

describe('期限卡', () => {
  const html = ssr(<DeadlineTiles deadlines={demoDeadlines} />);

  it('期限标题都在糊层里', () => {
    expect(demoDeadlines.length).toBeGreaterThan(0);
    for (const d of demoDeadlines) expect(html).toContain(d.title); // 正对照
    const clear = unveiledText(html);
    for (const d of demoDeadlines) expect(clear).not.toContain(d.title);
  });
});

describe('最近的材料', () => {
  const html = ssr(<RecentRecords caseId="demo" />);

  /*
   * 这两条最初写成「不含『解除通知书』/『不签』」，**跑变异时才发现它们没牙**：
   * 那几个词压根没被渲染（列表按时间取前三，选中的全是「已上传」的证据），
   * 于是 `not.toContain` 恒真——**空样本上的否定断言，看起来在守、其实什么也没守**。
   * 现在每条都先有一句正对照，钉住「这一屏确实渲染了材料行」。
   */
  it('文件名在糊层里', () => {
    expect(html).toMatch(/\.(xlsx|png|m4a|pdf|jpg)/); // 正对照：确实有文件名
    expect(unveiledText(html)).not.toMatch(/\.(xlsx|png|m4a|pdf|jpg)/);
  });

  it('状态徽标也在糊层里——「已上传」「结论：不签」照样是案情', () => {
    expect(html).toContain('已上传'); // 正对照
    expect(unveiledText(html)).not.toContain('已上传');
  });
});
