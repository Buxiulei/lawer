'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { SanbeiCap } from '@/lib/cap/sanbei';
import { useSignedIn } from '@/app/_ui/auth';
import { scrollBehavior, useReducedMotion } from '@/app/_ui/motion';
import { Button } from '@/components/shadcn/button';
import { ConfirmDialog } from '@/components/shadcn/confirm-dialog';
import { StickyBottomBar } from '@/components/shell/StickyBottomBar';
import { useToast } from '@/components/ui/Toast';
import { StepBar } from './StepBar';
import { StepStage } from './StepStage';
import { StepBasics } from './StepBasics';
import { StepTimeline } from './StepTimeline';
import { StepCompanyDocs } from './StepCompanyDocs';
import { StepGoals } from './StepGoals';
import { StepPreview } from './StepPreview';
import {
  EMPTY_DRAFT,
  clearDraft,
  draftHasContent,
  loadDraft,
  saveDraft,
  type IntakeDraft,
} from './draft';
import { destinationForFinish, saveIntake } from './submit';
import { advanceBlock } from './validate';

/** 未登录时最后一步的说明：服务器上还没有这份档案，不能说"档案建好了" */
const DRAFT_REASSURANCE =
  '这份档案现在只在这台设备上。金额是按你填的信息初算的，注册之后并入你的案件档案，材料补齐会自动更新。';

interface StepDef {
  title: string;
  /** 每步固定的一行安抚说明：给确定感，不煽情 */
  reassurance: string;
  /** cap = 三倍社平封顶基数的当前读数，由服务端从知识卡取好传下来；只有末步的金额表用得上 */
  render: (
    draft: IntakeDraft,
    patch: (p: Partial<IntakeDraft>) => void,
    cap: SanbeiCap | null,
  ) => ReactNode;
}

const STEPS: StepDef[] = [
  {
    title: '现在到哪一步了',
    reassurance: '先定位，再想对策。每个阶段能做的事不一样，选错了随时能回来改。',
    render: (d, p) => <StepStage draft={d} patch={p} />,
  },
  {
    title: '你的基本情况',
    reassurance: '这几个数字决定后面所有金额怎么算。一时填不准也行，上传合同和流水后会自动核对。',
    render: (d, p) => <StepBasics draft={d} patch={p} />,
  },
  {
    title: '发生了什么',
    reassurance: '记不清具体日期很正常。先把顺序理出来，细节以后再补。',
    render: (d, p) => <StepTimeline draft={d} patch={p} />,
  },
  {
    title: '公司给了什么说法和文件',
    reassurance: '公司写下来的每一句话都有用，包括对你不利的那些。照实说，才能提前把窟窿补上。',
    render: (d, p) => <StepCompanyDocs draft={d} patch={p} />,
  },
  {
    title: '你想要什么',
    reassurance: '先想清楚要什么，谈判时才不会被牵着走。这一步没有标准答案，选几项都可以。',
    render: (d, p) => <StepGoals draft={d} patch={p} />,
  },
  {
    title: '你的档案',
    reassurance: '下面是按你填的信息初算的一版。点「进入驾驶舱」才会存进你的档案，接下来一件一件来。',
    render: (d, _p, cap) => <StepPreview draft={d} cap={cap} />,
  },
];

export function IntakeFlow({ cap }: { cap: SanbeiCap | null }) {
  const router = useRouter();
  const toast = useToast();
  const signedIn = useSignedIn();
  const [draft, setDraft] = useState<IntakeDraft>(EMPTY_DRAFT);
  const [restored, setRestored] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 上一次提交没成的原因。留在页面上，不靠一闪而过的 toast 交代「没存下」 */
  const [saveFailure, setSaveFailure] = useState<string | null>(null);

  useEffect(() => {
    const saved = loadDraft();
    if (saved && draftHasContent(saved)) {
      setDraft(saved);
      setRestored(true);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveDraft(draft);
  }, [draft, hydrated]);

  const patch = useCallback((p: Partial<IntakeDraft>) => {
    setDraft((prev) => ({ ...prev, ...p }));
    setRestored(false);
  }, []);

  const reduce = useReducedMotion();
  const step = Math.min(draft.step, STEPS.length - 1);
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;
  // 「今天」现取：入职时间填在未来要当场拦下，不能等提交时才由后端说不行
  const block = advanceBlock(step, draft, new Date().toISOString().slice(0, 10));
  const canAdvance = block === null;

  const go = (next: number) => {
    setDraft((prev) => ({ ...prev, step: next }));
    setRestored(false);
    // 程序化平滑滚动是前庭敏感者最难受的一类运动，而 globals.css 那条全局
    // reduced-motion 规则只管 CSS、管不到这里——必须过 scrollBehavior()
    window.scrollTo({ top: 0, behavior: scrollBehavior(reduce) });
  };

  const reset = () => {
    clearDraft();
    setDraft(EMPTY_DRAFT);
    setRestored(false);
    setConfirmReset(false);
    window.scrollTo({ top: 0 });
  };

  /**
   * 末步。**先真的存进去，再说"存好了"**——四种结局各自的去处与说辞
   * 全在 destinationForFinish 里定死（含"失败不许弹成功提示""失败不许清草稿"），
   * 这一层只负责把它执行出来。
   */
  const finish = async () => {
    if (saving) return;
    const outcome = signedIn ? await runSave() : ({ kind: 'signed-out' } as const);
    const dest = destinationForFinish(outcome);
    setSaveFailure(dest.href === null ? dest.notice.message : null);
    toast(dest.notice.message, dest.notice.tone, dest.notice.discreet);
    if (dest.clearDraft) clearDraft();
    if (dest.href) router.push(dest.href);
  };

  const runSave = async () => {
    setSaving(true);
    try {
      return await saveIntake(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pb-2">
      <StepBar current={step} total={STEPS.length} title={current.title} />

      {restored && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-surface-2 px-3.5 py-2.5">
          <p className="text-[14px] leading-6 text-ink-2">
            上次填到第 {step + 1} 步，已经接着打开了。
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmReset(true)}
            className="px-2 text-[14px]"
          >
            清空重填
          </Button>
        </div>
      )}

      <div className="mt-4">{current.render(draft, patch, cap)}</div>

      <p
        data-veil=""
        className="mt-5 rounded-[10px] bg-surface-2 px-3.5 py-3 text-[14px] leading-6 text-ink-2"
      >
        {isLast && !signedIn ? DRAFT_REASSURANCE : current.reassurance}
      </p>

      <StickyBottomBar className="-mx-4 mt-4 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur-sm lg:-mx-6 lg:px-6">
        <div className="flex gap-2.5">
          {step > 0 && (
            <Button variant="secondary" onClick={() => go(step - 1)} className="min-w-24">
              上一步
            </Button>
          )}
          {isLast ? (
            <Button onClick={() => void finish()} disabled={saving} className="flex-1">
              {saving ? '正在存进你的档案…' : signedIn ? '进入驾驶舱' : '保存草稿并注册'}
            </Button>
          ) : (
            <Button onClick={() => go(step + 1)} disabled={!canAdvance} className="flex-1">
              下一步
            </Button>
          )}
        </div>
        {/* 拦下来的理由用**这一步自己的话**说。一句放之四海皆准的「有必填项未填」等于没说 */}
        {!isLast && block !== null && (
          <p className="mt-2 text-[13px] leading-5 text-ink-2">{block}</p>
        )}
        {isLast && saveFailure !== null && (
          <p role="alert" className="mt-2 text-[13px] leading-5 text-amber-ink">
            {saveFailure}
          </p>
        )}
        {step === 0 && (
          <p className="mt-2 text-[13px] leading-5 text-ink-2">
            填的内容只存在这台设备的浏览器里，随时可以关掉页面，回来接着填。
          </p>
        )}
      </StickyBottomBar>

      <ConfirmDialog
        open={confirmReset}
        title="清空已经填的内容"
        description={
          // 糊层挂在描述自己身上：弹窗根容器是 fixed，filter 会把它拽进自己的坐标系
          <div data-veil="">
            这一步会删掉本机保存的首诊草稿，包括时间线和底线，删掉之后找不回来。
          </div>
        }
        confirmLabel="确认清空重填"
        cancelLabel="再想想"
        onConfirm={reset}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}
