'use client';

/**
 * 首诊页要**提前**问的那一件事：这个人名下有没有可以存进去的案件档案。
 *
 * 【立这个模块的由头（F-205）】案件是「手机 + 邮箱双验证齐全」那一刻才由
 * lib/cases 的 ensureDefaultCase 建的。只验了手机号、邮箱还没补的人（后端那边叫
 * need_email）名下一个案件都没有，而 /intake 从前对此**一次都不查**：
 * 他能一路填完六步，点「进入驾驶舱」才撞上「没找到你名下的案件…」。
 * 东西确实没丢（草稿在本机），可六步是白填的——而「你还差一个邮箱」这句话，
 * 本来在第 1 步就说得出口。
 *
 * 所以这里定死两条：
 *  ① 进 /intake 就查一次，没案件就在**第 1 步顶上**摆一条关不掉的引导条；
 *  ② 第 6 步提交前那次查（saveIntake 本来就先查后发）撞上「名下没有案件」时，
 *    给的是**同一条引导条**，不是一行红字——红字说得出出了什么事，说不出该去哪儿。
 *
 * 【建案时机不动】新手机号注册未绑邮箱才强制补绑，这是产品规则；
 * 这个模块只负责把规则的后果**提前**告诉用户，不改规则本身。
 *
 * 【为什么「查不到」不算「没有」】网络断了、后端 5xx 一律回 'unknown'。
 * 那时摆一条「先去补邮箱」，是拿一个看着很正常的错答案挡住一个名下明明有案件的人——
 * 与 case/_components/resolve.ts 里 failed 那一支同一条口径。
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { cn } from '@/app/_ui/cn';
import { fetchMyCases } from '@/app/_ui/currentCase';
import { latestOf } from '@/app/(app)/case/_components/resolve';
import { Button } from '@/components/shadcn/button';

/** 三态。'unknown' 同时覆盖「还没查」「没登录」「查不到」——三者都不许推出「没有」。 */
export type CaseGuard = 'unknown' | 'has-case' | 'no-case';

/**
 * 补邮箱在哪儿补。同一个标签页里登录页会接回补绑那一格（sessionStorage 半程记录，
 * 见 login/_components/loginStep.ts）；换了标签页就重走一次手机号验证，也仍然到得了。
 */
export const COMPLETE_EMAIL_HREF = '/login';

/** 现查一次名下案件。**异常一律回 unknown**，不回 no-case。 */
export async function checkCaseGuard(): Promise<CaseGuard> {
  try {
    return latestOf(await fetchMyCases()) !== null ? 'has-case' : 'no-case';
  } catch {
    return 'unknown';
  }
}

/**
 * 页面挂载后查一次。返回的 setter 给末步用：提交前那次查（在 saveIntake 里）
 * 得出「名下没有案件」时，把结论写回来，好让引导条在第 6 步也摆出来。
 */
export function useCaseGuard(signedIn: boolean): [CaseGuard, (next: CaseGuard) => void] {
  const [guard, setGuard] = useState<CaseGuard>('unknown');
  useEffect(() => {
    if (!signedIn) {
      // 没登录的人本来就走「保存草稿并注册」那条路，不该再被这条引导条截一次
      setGuard('unknown');
      return;
    }
    let alive = true;
    void checkCaseGuard().then((next) => {
      if (alive) setGuard(next);
    });
    return () => {
      alive = false;
    };
  }, [signedIn]);
  return [guard, setGuard];
}

/**
 * 引导条摆在哪一步。两处而不是六处：第 1 步是「别白填」，第 6 步是「按下去之前拦住」，
 * 中间四步摆着只会一路挡视线（草稿本来就一直留着，不填完也不会丢）。
 */
export type GuidePlacement = 'none' | 'first-step' | 'last-step';

export function guidePlacement(input: {
  guard: CaseGuard;
  step: number;
  total: number;
}): GuidePlacement {
  if (input.guard !== 'no-case') return 'none';
  if (input.step === 0) return 'first-step';
  if (input.step === input.total - 1) return 'last-step';
  return 'none';
}

/** 引导条第一句。这句话同时被末步那支结局的提示复用，所以只写一次。 */
export const NO_CASE_GUIDE_LEAD = '先补一个邮箱，你填的内容会一直留在这台设备上';

/**
 * 引导条本体。**关不掉**：没有「知道了」也没有叉——能关掉的引导条等于没有，
 * 而关掉之后他仍然会一路填到第 6 步撞墙。
 */
export function NoCaseGuide({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'rounded-[10px] border border-amber-ink/25 bg-amber-wash px-3.5 py-3',
        className,
      )}
    >
      {/* 自述三段式：缺什么 / 为什么缺 / 怎么办 */}
      <p className="text-[14px] leading-6 text-ink">{NO_CASE_GUIDE_LEAD}。</p>
      <p className="mt-1 text-[13px] leading-5 text-ink-2">
        手机号已经验过了，邮箱还没有——邮箱验完才会给你建好这份档案，现在这六步还存不进去。
        补完回来，这一页会接着刚才那一步打开。
      </p>
      <Button asChild variant="secondary" size="sm" className="mt-2.5">
        <Link href={COMPLETE_EMAIL_HREF}>去补邮箱</Link>
      </Button>
    </div>
  );
}
