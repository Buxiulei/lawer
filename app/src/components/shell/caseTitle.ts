'use client';

/**
 * 壳层顶上那行字——PC 侧栏标题与标签页 document.title——到底写谁。
 *
 * 【立这个模块的由头】(app)/layout.tsx 从建站起就恒传 `demoCase.title`，
 * 于是**每一个**挂壳层的页面（真实案件页、「我的」、设置，以及点「进入我的案件」
 * 中转的那一瞬）标签页与 PC 侧栏都写着演示案件名。用户亲测时正是在中转页
 * 瞥见那行字，判定自己被送进了示例案例——落点 /case/2 其实没错、数据也是真的，
 * **错的只有这层布局的标题**。骨架层的一行字，把底下全对的数据全盘否定掉了。
 *
 * 所以这里只认两件事：
 *   ① 正站在演示案件页上 → 演示标题（那一页本来就该显示它）
 *   ② 其余一切情况       → 该案件的真标题；取数前、取不到、或压根不在案件页上，
 *                          一律中性词。**没有任何一条分支回 demo 标题**——
 *                          宁可短暂写「我的案件」，也不许闪一下别家公司名。
 *
 * 低调模式那条中性化（NEUTRAL_TITLE）不在这一层，仍由 _ui/discreet 管，本模块不碰。
 */

import { useEffect, useState } from 'react';
import { demoCase } from '@/app/_mock/demo';
import { APP_TITLE } from '@/app/_ui/bootstrap';
import { CASE_ID_PATTERN, fetchMyCases } from '@/app/_ui/currentCase';

/** 还不知道是哪个案件、或真标题还没取到时，壳层写这个。 */
export const NEUTRAL_CASE_TITLE = '我的案件';

export interface ShellTitles {
  /** PC 侧栏顶上那行 */
  sidebar: string;
  /** 标签页标题 */
  document: string;
}

/**
 * 纯函数：把「在不在演示案件页 + 真标题取到没有」翻成屏幕上那两行字。
 * `realTitle` 为 null ＝还不知道，走中性词那一支。
 */
export function shellTitles(input: {
  onDemoCase: boolean;
  realTitle: string | null;
}): ShellTitles {
  const title = input.onDemoCase ? demoCase.title : input.realTitle;
  return {
    sidebar: title ?? NEUTRAL_CASE_TITLE,
    document: title === null ? APP_TITLE : `${title} · ${APP_TITLE}`,
  };
}

/**
 * 已取到的标题，按 id 记一份。壳层每次路由切换都重渲染，
 * 没有这份缓存就等于每点一次导航问一次接口。
 */
const titleCache = new Map<string, string>();

/** 只给测试用：清掉进程内那份缓存，好让每条用例从同一个起点跑。 */
export function resetCaseTitleCache(): void {
  titleCache.clear();
}

/**
 * 这个案件的真标题。走**已有**的那条通路 `GET /api/v1/cases`（CaseResolver 用的同一条），
 * 一次把名下所有标题都记下来。
 *
 * 取不到（网络断、401、这个 id 不在名下）一律回 null——**不抛，更不退回 demo 标题**，
 * 让调用方写中性词。这是本模块唯一的失败形态。
 */
export async function loadCaseTitle(caseId: string): Promise<string | null> {
  const known = titleCache.get(caseId);
  if (known !== undefined) return known;
  try {
    for (const row of await fetchMyCases()) titleCache.set(String(row.id), row.title);
  } catch {
    return null;
  }
  return titleCache.get(caseId) ?? null;
}

/**
 * 路径里那个案件的真标题。
 * 不是真实案件 id（null，或 'demo' 这种字面段）就一次请求都不发。
 */
export function useRealCaseTitle(caseId: string | null): string | null {
  const key = caseId !== null && CASE_ID_PATTERN.test(caseId) ? caseId : null;
  const [title, setTitle] = useState<string | null>(null);

  useEffect(() => {
    if (key === null) {
      setTitle(null);
      return;
    }
    let alive = true;
    void loadCaseTitle(key).then((resolved) => {
      if (alive) setTitle(resolved);
    });
    return () => {
      alive = false;
    };
  }, [key]);

  return title;
}
