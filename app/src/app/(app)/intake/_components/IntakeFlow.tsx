'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { SanbeiCap } from '@/lib/cap/sanbei';
import { DEFAULT_DOMAIN, domainPackOrDefault, type DomainPack } from '@/lib/domains/registry';
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
import { guidePlacement, NoCaseGuide, useCaseGuard } from './caseGuard';
import {
  EMPTY_DRAFT,
  clearDraft,
  draftHasContent,
  loadDraft,
  saveDraft,
  type IntakeDraft,
} from './draft';
import {
  pushStepHistory,
  resetStepHistory,
  seedStepHistory,
  stepFromHistoryState,
} from './stepHistory';
import { SchemaField } from './SchemaField';
import { emptyValue, fieldBlock, isFilled, stepTitleOf, type FieldValue } from './schemaFlow';
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
  /**
   * 这一步还不能往下走的理由；null = 可以走。
   * 手写向导那条路省略它，由 validate.advanceBlock 按步序统一判（既有行为逐字不变）。
   */
  block?: (draft: IntakeDraft, today: string) => string | null;
}

const HANDWRITTEN_STEPS: StepDef[] = [
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

/**
 * **手写向导的登记处**。键即领域 key，值是那个领域一步步问下来的那份稿子。
 *
 * 【为什么是一张表，不是一句 `if (domain === 缺省)`】写成 if 的形态是：
 * 第二个领域将来也有人为它手写了向导，得回来改那句判断，而漏改的后果是
 * 它的用户仍然走通用表单——页面照常能用，只是那份手写稿从没被摆出来过。
 * 表里没有的领域一律按 schema 排步（schemaSteps），**不退回别人的向导**。
 */
const HANDWRITTEN_FLOWS: Record<string, StepDef[]> = {
  [DEFAULT_DOMAIN]: HANDWRITTEN_STEPS,
};

/**
 * 没有手写向导的领域：按 `intakeSchema` 一格一步问下来，末步是「你的档案」。
 *
 * 【顺序即 schema 的顺序】先问什么由领域包定，不由页面定——页面自作主张排序的形态是：
 * 领域包把最要紧的一问放在第一位，页面按自己的偏好挪到第五步，而两边都不报错。
 */
function schemaSteps(pack: DomainPack): StepDef[] {
  const steps: StepDef[] = pack.intakeSchema.map((field) => ({
    title: stepTitleOf(field),
    // 说明用领域包**逐字对外**的那句话，不在页面上另编一句白话：
    // 另编的形态是两处说法不一致，而工具清单那份是对外契约，改不得。
    reassurance: field.description,
    render: (d, p) => (
      <SchemaField
        field={field}
        value={d.fields[field.key] ?? emptyValue(field)}
        onChange={(next) => p({ fields: { ...d.fields, [field.key]: next } })}
      />
    ),
    block: (d, today) => fieldBlock(field, d.fields[field.key] ?? emptyValue(field), today),
  }));
  steps.push({
    title: '你的档案',
    reassurance: '下面是这一份要存进档案的内容。点「进入驾驶舱」才会存进去，接下来一件一件来。',
    render: (d) => <SchemaPreview pack={pack} draft={d} />,
  });
  return steps;
}

/**
 * 通用末步：把填过的那几格原样列一遍。**只列填过的**——把空格子也摆出来，
 * 等于在最后一屏再问一遍那些他已经决定不填的问题。
 */
function SchemaPreview({ pack, draft }: { pack: DomainPack; draft: IntakeDraft }) {
  const filled = pack.intakeSchema.filter((f) => isFilled(draft.fields[f.key] ?? emptyValue(f)));
  return (
    <div data-veil="" className="flex flex-col gap-2.5">
      {filled.length === 0 ? (
        <p className="text-[15px] leading-7 text-ink-2">这一份还什么都没填。往回走几步补上再交。</p>
      ) : (
        filled.map((f) => (
          <div key={f.key} className="rounded-[10px] bg-surface-2 px-3.5 py-2.5">
            <p className="text-[13px] leading-5 text-ink-2">{stepTitleOf(f)}</p>
            <p className="mt-0.5 text-[15px] leading-7 text-ink">
              {summarize(draft.fields[f.key] ?? emptyValue(f))}
            </p>
          </div>
        ))
      )}
    </div>
  );
}

/** 一格的值 → 末步那行摘要。只求认得出自己填过什么，不求好看。 */
function summarize(value: FieldValue): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v : [v.date, v.text].filter(Boolean).join(' ')))
      .filter((v) => v.trim() !== '')
      .join('；');
  }
  return Object.entries(value)
    .filter(([, v]) => typeof v === 'string' && v.trim() !== '')
    .map(([k, v]) => `${k}：${v}`)
    .join('；');
}

export function IntakeFlow({ cap }: { cap: SanbeiCap | null }) {
  const router = useRouter();
  const toast = useToast();
  const signedIn = useSignedIn();
  /**
   * 名下有没有案件可以存。挂载后现查一次（F-205）——只验了手机号还没补邮箱的人
   * 名下一个案件都没有，这件事必须在第 1 步就说，不能等他填完六步才撞墙。
   */
  const [caseProbe, setCaseGuard] = useCaseGuard(signedIn);
  const caseGuard = caseProbe.guard;
  /**
   * 这一份首诊按哪个领域问。**取的是名下那个案件的 domain**（首诊是往它里面提交的），
   * 查不到就退回缺省领域——查不到的常见形态是还没登录，那时问哪一套都还没有落点。
   */
  const pack = domainPackOrDefault(caseProbe.domain || undefined);
  const steps = HANDWRITTEN_FLOWS[pack.key] ?? schemaSteps(pack);
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

  /**
   * 草稿是**上一个领域**填的就整份作废。
   *
   * 【为什么不留着】各格的答案按字段键存，而键名跨领域同名（IntakeFieldSpec 的约定）——
   * 留着的形态是：上一个领域的答案一格不落地被按这个领域的 schema 提交上去，
   * 每一格都对得上某个键，服务端照收，没有一处会报错。
   *
   * 【domain 是空串时不动它】存量草稿都没有这一列，抹掉它们等于把老用户填了一半的东西删了。
   */
  useEffect(() => {
    if (!hydrated) return;
    setDraft((prev) => {
      if (prev.domain === pack.key) return prev;
      if (prev.domain === '') return { ...prev, domain: pack.key };
      return { ...EMPTY_DRAFT, domain: pack.key };
    });
  }, [hydrated, pack.key]);

  useEffect(() => {
    if (!hydrated) return;
    saveDraft(draft);
  }, [draft, hydrated]);

  const patch = useCallback((p: Partial<IntakeDraft>) => {
    setDraft((prev) => ({ ...prev, ...p }));
    setRestored(false);
  }, []);

  const reduce = useReducedMotion();
  const step = Math.min(draft.step, steps.length - 1);
  const stepRef = useRef(step);
  stepRef.current = step;
  const current = steps[step];
  const isLast = step === steps.length - 1;
  // 「今天」现取：入职时间填在未来要当场拦下，不能等提交时才由后端说不行
  const today = new Date().toISOString().slice(0, 10);
  // 手写向导按步序统一判（advanceBlock，逐字不变）；按 schema 排步的那条路
  // 由每一步自己带的 block 判，说的是**领域包自己那句话**。
  const block = current.block ? current.block(draft, today) : advanceBlock(step, draft, today);
  const canAdvance = block === null;
  // 引导条摆哪一步由 caseGuard 一处说了算；'unknown'（还没查到 / 查不到）一律不摆
  const placement = guidePlacement({ guard: caseGuard, step, total: steps.length });

  /** 落一步：改 state + 回到顶部。前进与「返回键弹回来」共用这一处，两边不许各写一遍。 */
  const applyStep = useCallback(
    (next: number) => {
      setDraft((prev) => ({ ...prev, step: next }));
      setRestored(false);
      // 程序化平滑滚动是前庭敏感者最难受的一类运动，而 globals.css 那条全局
      // reduced-motion 规则只管 CSS、管不到这里——必须过 scrollBehavior()
      window.scrollTo({ top: 0, behavior: scrollBehavior(reduce) });
    },
    [reduce],
  );

  /**
   * 【F-208】向导的 6 步全在同一个 URL 上。不往 history 里压条目，浏览器返回键
   * 第一下就把整个 /intake 弹掉——用户在第 2 步按返回，期待回第 1 步，实际跳出向导。
   * 挂载后先把已恢复的步数铺进栈（草稿恢复到第 3 步时栈里本来一个条目都没有，
   * 不铺就跟没修一样），此后每前进一步压一个条目。
   *
   * seeded 这个 ref 只挡得住**同一次挂载**里的重复调用。F5、跳走再返回、
   * 同标签页二进 /intake 都是**新的一次挂载配上一轮那副栈**，ref 是新的、栈是旧的——
   * 「已经铺过没有」只有栈自己答得了，所以那道闸在 seedStepHistory 里（见其注释）。
   */
  const seeded = useRef(false);
  useEffect(() => {
    if (!hydrated || seeded.current) return;
    seeded.current = true;
    seedStepHistory(window.history, stepRef.current);
  }, [hydrated]);

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const back = stepFromHistoryState(e.state);
      // 读不出步数＝这个条目不是向导压的（第 1 步再往回就是它）：
      // 什么都不做，让浏览器照常离开。
      if (back === null) return;
      // 退回来的就是屏幕上这一步：seedStepHistory 发现条目比屏幕深时会退栈
      // （复核 MF-4），那一下只动栈、不该动屏幕。落一遍 applyStep 步数虽然不变，
      // 却会把「已恢复上次填的内容」那行提示按掉——只对齐栈的一下不算用户操作。
      if (back === stepRef.current) return;
      applyStep(Math.min(back, steps.length - 1));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [applyStep]);

  const go = (next: number) => {
    // 往回走一律走浏览器的栈（「上一步」按钮与返回键是同一件事）：
    // 按钮自己改 state 的话，栈还停在原处，下一次返回就会多退一格或直接出去。
    if (next < step) {
      window.history.back();
      return;
    }
    pushStepHistory(window.history, next);
    applyStep(next);
  };

  const reset = () => {
    clearDraft();
    // 清空后回到第 1 步，历史栈也得跟着退回第一格。只改写栈顶的话，
    // 下面那几格还写着第 2、3 步，按一下返回就弹回一张空表单，
    // 「第 1 步返回才离开」当场失效（见 stepHistory 的 resetStepHistory）。
    // 退栈是异步的，popstate 回来时 applyStep(0) 会把步数再落一遍，与这里一致。
    resetStepHistory(window.history, stepRef.current);
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
    // 名下没有案件那一支的出路是引导条，不是一行红字：把结论写回 caseGuard，
    // 第 6 步就摆出跟第 1 步同一条引导条（带「去补邮箱」）。红字那条留给
    // 真正没有现成出路的支（网络断了、后端拒收）。
    if (dest.guide) setCaseGuard('no-case');
    setSaveFailure(dest.href === null && !dest.guide ? dest.notice.message : null);
    toast(dest.notice.message, dest.notice.tone, dest.notice.discreet);
    if (dest.clearDraft) clearDraft();
    if (dest.href) router.push(dest.href);
  };

  const runSave = async () => {
    setSaving(true);
    try {
      return await saveIntake(draft, pack);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pb-2">
      <StepBar current={step} total={steps.length} title={current.title} />

      {placement === 'first-step' && <NoCaseGuide className="mt-3" />}

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

      {/* 末步这一条贴着「进入驾驶舱」摆：按下去之前就把出路给他，而不是按下去之后 */}
      {placement === 'last-step' && <NoCaseGuide className="mt-3" />}

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
