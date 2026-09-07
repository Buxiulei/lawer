'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { apiFetch, humanError } from '@/app/_ui/api';
import { readToken, useSignedIn } from '@/app/_ui/auth';
import { CaseAiGeneratedNotice } from '@/app/_ui/CaseAiGeneratedNotice';
import { useDiscreet } from '@/app/_ui/discreet';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { Alert, AlertDescription, AlertTitle } from '@/components/shadcn/alert';
import { Button } from '@/components/shadcn/button';
import { EmptyState } from '@/components/shadcn/empty-state';
import { Skeleton } from '@/components/shadcn/skeleton';

/**
 * 个案报告页。**这一页是展示层，只渲染服务端存下的那份渲染稿**（设计稿 §4.3）：
 * 分节、措辞、结论一个字都不在前端拼。
 *
 * 【为什么不在这里排版分节】报告的分节骨架由领域包给、正文由 agent 与用户整理，
 * 前端再拼一遍的形态是：库里改了一节标题，页面上还按老骨架分块，
 * 于是新那节的内容掉进"其他"里，或者干脆不显示——而两边都没有报错。
 *
 * 【没有编辑入口是有意的】改报告走 agent（case_report_update，带乐观锁与变更日志）。
 * 页面加一个直接编辑框，就绕过了那把锁与那份日志。
 */
export function CaseReportLoader({ caseId }: { caseId: string }) {
  const signedIn = useSignedIn();
  const { discreet } = useDiscreet();
  const word = discreet ? NEUTRAL_WORD.report : '个案报告';

  const [report, setReport] = useState<ReportView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [needSignIn, setNeedSignIn] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setMissing(false);
    setNeedSignIn(false);
    // 直接读 token 而不是用 signedIn：水合那一帧 hook 还可能是 null
    if (!readToken()) {
      setNeedSignIn(true);
      setLoading(false);
      return;
    }
    try {
      const res = await apiFetch<{ report: ReportView }>(
        `/cases/${encodeURIComponent(caseId)}/report`,
      );
      setReport(res.report);
    } catch (err) {
      // 「不存在或不是你的」是终局，不给重试；其余给重试
      if (isNotFound(err)) setMissing(true);
      else setLoadError(humanError(err));
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load, signedIn]);

  if (loading) {
    return (
      <div className="pt-1">
        {/* 骨架挂 data-veil：低调模式下它是这一屏唯一的形状，不糊就成了指路牌 */}
        <div data-veil="" className="flex flex-col gap-3 py-3">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (needSignIn) {
    return (
      <div className="pt-6">
        <EmptyState
          title="登录态过期了"
          description="重新登录之后这一页会照旧显示。"
          action={
            <Link
              href={`/login?next=/case/${encodeURIComponent(caseId)}/report`}
              className="inline-block rounded-[8px] bg-primary px-5 py-2.5 text-[15px] font-semibold text-on-primary no-underline"
            >
              重新登录
            </Link>
          }
        />
      </div>
    );
  }

  if (missing) {
    return (
      <div className="pt-6">
        <EmptyState
          title="这个案件不存在或不属于你"
          description="地址里的案件号在你名下查不到。可能是链接过期、复制串了，或者这本来是别人的。"
          action={
            <Link
              href="/case"
              className="inline-block rounded-[8px] bg-primary px-5 py-2.5 text-[15px] font-semibold text-on-primary no-underline"
            >
              回我的案件
            </Link>
          }
        />
      </div>
    );
  }

  if (loadError !== null || report === null) {
    return (
      <div className="pt-6">
        <EmptyState
          title="这一屏没取出来"
          description={`${loadError ?? ''}你的记录都还在，只是这次没读到。点下面再试一次。`}
          action={<Button onClick={() => void load()}>重试</Button>}
        />
      </div>
    );
  }

  return <ReportBody caseId={caseId} report={report} word={word} />;
}

/** 与 lib/cases/report.ts 的 ReportView 同形，只留这一页用得上的字段。 */
export interface ReportView {
  version: number;
  updated_at: string | null;
  updated_by: string | null;
  rendered_md: string;
  stale: { state: null | 'changed' | 'idle'; since: string | null; changes: number; detail: string };
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { errorCode?: string }).errorCode === 'CASE_NOT_FOUND'
  );
}

/** updated_by 的三种取值译成人话。agent:<key_id> 里的 key id 不往外印——它是凭据编号。 */
function writerLabel(by: string | null): string {
  if (!by) return '系统';
  if (by === 'system') return '系统';
  if (by === 'web') return '你自己';
  return by.startsWith('agent:') ? '你的 agent' : by;
}

/** SQLite 的 'YYYY-MM-DD HH:MM:SS'（UTC）→ 给人看的本地日期时间 */
function humanTime(sqlTime: string | null): string {
  if (!sqlTime) return '未记录';
  const ms = Date.parse(`${sqlTime.replace(' ', 'T')}Z`);
  if (Number.isNaN(ms)) return sqlTime;
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 只吃传进来的 report，自己不取数——「四块到底有没有接上真数据」这类判据
 * 在 node 环境里就能验，不必跑 effect。
 */
export function ReportBody({
  caseId,
  report,
  word,
}: {
  caseId: string;
  report: ReportView;
  word: string;
}) {
  const stale = report.stale.state !== null;
  return (
    <div className="pt-1">
      <header className="pb-2">
        <h1 className="text-[17px] leading-7 font-semibold text-ink">{word}</h1>
        <p className="mt-0.5 text-[13px] leading-5 text-ink-2">
          最后由 {writerLabel(report.updated_by)} 更新于 {humanTime(report.updated_at)}（第{' '}
          <span className="num">{report.version}</span> 版）
        </p>
      </header>

      {/* 这一整页是 agent 整理出来的长期记忆——rendered_md 从第一个字到最后一个字都是
          模型写的。标识排在正文之前（标识办法 §4 第（一）项「在文本的起始…添加文字提示」）：
          排在末尾的形态是，读的人一路读完那几节结论才知道是谁写的。
          它排在「过期标」之前——过期标说的是"这份新不新"，标识说的是"这份是谁写的"，
          后者是读之前就该知道的那件事。 */}
      <CaseAiGeneratedNotice caseId={caseId} className="mb-3" />

      {/* 过期标。**不把过期的正文藏起来**：藏了用户就只剩一句"过期了"，
          而他此刻要的正是那份内容——哪怕旧，也比什么都没有强。说清楚即可。 */}
      {stale && (
        <Alert className="mb-3" data-testid="report-stale">
          <AlertTitle>这份还没跟上最新的记录</AlertTitle>
          <AlertDescription>
            {report.stale.state === 'changed'
              ? `自 ${report.stale.since} 起有 ${report.stale.changes} 处变动（${report.stale.detail}）还没整理进来。`
              : `${report.stale.detail}（最后整理于 ${report.stale.since}）。`}
            下次让它帮你办事的时候，先说一句「更新一下报告」。
          </AlertDescription>
        </Alert>
      )}

      {/* 正文整块进糊层：低调模式下换词换不干净，也没必要——按住就能看清 */}
      <article
        data-veil=""
        className="prose-report text-[15px] leading-7 text-ink [&_h1]:mt-0 [&_h1]:text-[17px] [&_h1]:font-semibold [&_h2]:mt-5 [&_h2]:text-[15px] [&_h2]:font-semibold [&_li]:my-0.5 [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
      >
        <Markdown remarkPlugins={[remarkGfm]} skipHtml>
          {report.rendered_md}
        </Markdown>
      </article>
    </div>
  );
}
