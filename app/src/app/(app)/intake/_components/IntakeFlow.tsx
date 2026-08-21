'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useSignedIn } from '@/app/_ui/auth';
import { Button } from '@/components/shadcn/button';
import { ConfirmDialog } from '@/components/shadcn/confirm-dialog';
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

const DEMO_CASE_ID = 'demo';

/** 未登录时最后一步的说明：服务器上还没有这份档案，不能说"档案建好了" */
const DRAFT_REASSURANCE =
  '这份档案现在只在这台设备上。金额是按你填的信息初算的，注册之后并入你的案件档案，材料补齐会自动更新。';

interface StepDef {
  title: string;
  /** 每步固定的一行安抚说明：给确定感，不煽情 */
  reassurance: string;
  render: (draft: IntakeDraft, patch: (p: Partial<IntakeDraft>) => void) => ReactNode;
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
    reassurance: '档案建好了。金额是按现有信息初算的，材料补齐后会自动更新。接下来一件一件来。',
    render: (d) => <StepPreview draft={d} />,
  },
];

export function IntakeFlow() {
  const router = useRouter();
  const toast = useToast();
  const signedIn = useSignedIn();
  const [draft, setDraft] = useState<IntakeDraft>(EMPTY_DRAFT);
  const [restored, setRestored] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

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

  const step = Math.min(draft.step, STEPS.length - 1);
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const canAdvance = step !== 0 || Boolean(draft.stage);

  const go = (next: number) => {
    setDraft((prev) => ({ ...prev, step: next }));
    setRestored(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const reset = () => {
    clearDraft();
    setDraft(EMPTY_DRAFT);
    setRestored(false);
    setConfirmReset(false);
    window.scrollTo({ top: 0 });
  };

  /**
   * 末步的去处取决于有没有登录。没登录时这些内容**只在这台设备的浏览器里**，
   * 服务器上还没有任何东西——按钮和提示都得照实说，不能假装档案已经建好了。
   */
  const finish = () => {
    if (!signedIn) {
      toast(
        '你填的内容已暂存在这台设备上，注册后我会把它并入你的案件档案',
        'success',
        '已经暂存在这台设备上',
      );
      router.push('/login');
      return;
    }
    toast('档案已建好，正在打开工作台', 'success', '已经准备好了');
    router.push(`/case/${DEMO_CASE_ID}`);
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

      <div className="mt-4">{current.render(draft, patch)}</div>

      <p className="mt-5 rounded-[10px] bg-surface-2 px-3.5 py-3 text-[14px] leading-6 text-ink-2">
        {isLast && !signedIn ? DRAFT_REASSURANCE : current.reassurance}
      </p>

      <div className="sticky bottom-[calc(56px+env(safe-area-inset-bottom))] z-30 -mx-4 mt-4 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur-sm lg:bottom-0 lg:-mx-6 lg:px-6">
        <div className="flex gap-2.5">
          {step > 0 && (
            <Button variant="secondary" onClick={() => go(step - 1)} className="min-w-24">
              上一步
            </Button>
          )}
          {isLast ? (
            <Button onClick={finish} className="w-full">
              {signedIn ? '进入工作台' : '保存草稿并注册'}
            </Button>
          ) : (
            <Button onClick={() => go(step + 1)} disabled={!canAdvance} className="w-full">
              下一步
            </Button>
          )}
        </div>
        {!canAdvance && (
          <p className="mt-2 text-[13px] leading-5 text-ink-2">
            先选一个最接近你现在情况的阶段。
          </p>
        )}
        {step === 0 && (
          <p className="mt-2 text-[13px] leading-5 text-ink-2">
            填的内容只存在这台设备的浏览器里，随时可以关掉页面，回来接着填。
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirmReset}
        title="清空已经填的内容"
        description="这一步会删掉本机保存的首诊草稿，包括时间线和底线，删掉之后找不回来。"
        confirmLabel="确认清空重填"
        cancelLabel="再想想"
        onConfirm={reset}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}
