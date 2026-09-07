'use client';

/**
 * 「我的数据」——协议附一第 7 项点名的四个入口：**案件删除、整案导出、账号注销、撤回同意**。
 *
 * 【为什么四个挤在同一张卡里，而不是各回各的页面】这四件事之前只有 API 与 MCP 两条路，
 * 网页上一个都点不到；其中注销与撤回同意的端点还只认网页登录态（api key 一律 403），
 * 于是它们**对任何用户都不可达**——协议里那句「入口」是空的，而每一条接口自测都是绿的。
 * 补入口要先决定它们摆在哪儿：给案件加一栏、给设置加一页都动导航位次，而导航位次不是本票
 * 能定的事。所以先集中落在设置页这一张卡上：四条都点得到、一处都不动导航。
 *
 * 【「我的同意」这个小标题是有出处的，不能改字】撤回情绪同意之后，站内与 MCP 两条路
 * 都会回同一句话，末尾写着「去网页『设置 → 我的同意』」（lib/lifecycle/consents 的
 * EMOTION_REVOKED_NOTE）。用户照那句话翻进来，得真找得到这四个字。
 * 判据钉着两处逐字一致。
 *
 * 【两步式一步都不省】删除案件与注销账号都是先取一份确认单（会删什么、会留下什么），
 * 逐条念给用户看，再带 confirm_token 调第二次。页面自己攒一份"会删什么"的清单是不行的：
 * 服务端那份改了，页面这份还在念旧的，而用户是照页面上那几行做的决定。
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, humanError } from '@/app/_ui/api';
import { clearToken } from '@/app/_ui/auth';
import { Alert } from '@/components/shadcn/alert';
import { Button } from '@/components/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/shadcn/card';
import { ConfirmDialog } from '@/components/shadcn/confirm-dialog';
import { Input } from '@/components/shadcn/input';

/** 「设置 → 我的同意」里的那四个字。EMOTION_REVOKED_NOTE 指过来的就是它。 */
export const CONSENTS_SECTION_TITLE = '我的同意';

// ───────────────────────── 回包形状（与服务端逐字对齐） ─────────────────────────

export interface ConsentState {
  kind: string;
  label: string;
  effect: string;
  revoked: boolean;
  revoked_at: string | null;
}

export interface CaseRow {
  id: number;
  title: string;
}

export interface CaseDeleteConfirm {
  stage: 'confirm';
  case_id: number;
  title: string;
  confirm_token: string;
  removes: string[];
  keeps: string[];
  retention_days: number;
}

export interface CaseDeleted {
  stage: 'deleted';
  case_id: number;
  purge_after: string;
  shares_revoked: number;
  note: string;
}

export interface CancelChallenge {
  stage: 'challenge';
  confirm_token: string;
  sent_to: string;
  cases: number;
  removes: string[];
  keeps: string[];
  balance_note: string;
}

export interface AccountCancelled {
  stage: 'cancelled';
  purge_after: string;
  cases_deleted: number;
  shares_revoked: number;
  note: string;
}

export interface CaseExported {
  filename: string;
  download_url: string;
  expires_at: string;
  omissions: { path: string; reason: string }[];
  note: string;
}

/**
 * 这张卡会打的全部请求，**一处集中**。
 *
 * 页面上四个按钮没有一个自己拼路径：删除那条的 confirm_token 走查询串而不是请求体
 * （DELETE 带体会被一些客户端与网关丢掉，丢掉之后那次调用看起来像"第一步"——
 * 页面上点了删除却什么都没发生，且没有一处报错，见 api/v1/cases/[id]/route.ts）。
 * 这种一处写错就静默失效的细节，只能有一份。
 */
export const dataRightsApi = {
  listConsents: () => apiFetch<{ consents: ConsentState[] }>('/me/consents'),
  revokeConsent: (kind: string) =>
    apiFetch<{ effect: string }>('/me/consents', { method: 'POST', body: { kind } }),
  listCases: () => apiFetch<{ cases: CaseRow[] }>('/cases'),
  exportCase: (caseId: number) => apiFetch<CaseExported>(`/cases/${caseId}/export`),
  deleteCase: (caseId: number, confirmToken?: string) =>
    apiFetch<CaseDeleteConfirm | CaseDeleted>(
      confirmToken === undefined
        ? `/cases/${caseId}`
        : `/cases/${caseId}?confirm_token=${encodeURIComponent(confirmToken)}`,
      { method: 'DELETE' },
    ),
  cancelAccount: (body: { code?: string; confirm_token?: string }) =>
    apiFetch<CancelChallenge | AccountCancelled>('/me/cancel', { method: 'POST', body }),
};

/** 确认框里那两份清单：会删什么、会留下什么。**服务端给什么念什么**，页面不自己攒。 */
export function ConsequenceLists({
  removes,
  keeps,
  tail,
}: {
  removes: string[];
  keeps: string[];
  tail?: string | null;
}) {
  return (
    <>
      <p className="text-[14px] leading-6 text-ink">会被删掉的：</p>
      <ul className="mt-1 list-disc pl-5 text-[13px] leading-6 text-ink-2">
        {removes.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <p className="mt-3 text-[14px] leading-6 text-ink">会留下的：</p>
      <ul className="mt-1 list-disc pl-5 text-[13px] leading-6 text-ink-2">
        {keeps.map((k) => (
          <li key={k}>{k}</li>
        ))}
      </ul>
      {tail ? <p className="mt-3 text-[13px] leading-6 text-ink-2">{tail}</p> : null}
    </>
  );
}

// ───────────────────────────── 我的同意 ─────────────────────────────

interface ConsentsState {
  consents: ConsentState[] | null;
  /** 正在确认撤回的那一项 */
  pending: ConsentState | null;
  busy: boolean;
  error: string | null;
  done: string | null;
}

const CONSENTS_INIT: ConsentsState = {
  consents: null,
  pending: null,
  busy: false,
  error: null,
  done: null,
};

export function ConsentsSection() {
  const [s, set] = useState<ConsentsState>(CONSENTS_INIT);

  const load = useCallback(() => {
    void dataRightsApi
      .listConsents()
      .then((b) => set((p) => ({ ...p, consents: b.consents })))
      // 读不到就当没有：这一段是附加信息，不该把整个设置页变成一个错误页
      .catch(() => set((p) => ({ ...p, consents: [] })));
  }, []);

  useEffect(load, [load]);

  const confirmRevoke = () => {
    const target = s.pending;
    if (!target) return;
    set((p) => ({ ...p, busy: true, error: null }));
    void dataRightsApi
      .revokeConsent(target.kind)
      .then((r) => {
        set((p) => ({ ...p, busy: false, pending: null, done: r.effect }));
        load();
      })
      .catch((err) =>
        set((p) => ({ ...p, busy: false, pending: null, error: humanError(err) })),
      );
  };

  return (
    <div className="border-t border-line py-3">
      <p className="text-[15px] font-medium text-ink">{CONSENTS_SECTION_TITLE}</p>
      <p className="mt-0.5 text-[14px] leading-6 text-ink-2">
        这些是你单独同意过的事项。撤回之后我们不再做这一项；撤回不影响撤回之前已经进行的处理。
      </p>

      {s.consents === null ? (
        <p className="mt-2 text-[13px] leading-6 text-ink-2">正在读取…</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-3">
          {s.consents.map((c) => (
            <li key={c.kind} className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[15px] text-ink">{c.label}</p>
                <p className="mt-0.5 text-[13px] leading-6 text-ink-2">{c.effect}</p>
                {c.revoked ? (
                  <p className="mt-0.5 text-[13px] leading-6 text-ink-2">
                    已于 {c.revoked_at?.slice(0, 16)} 撤回
                  </p>
                ) : null}
              </div>
              {c.revoked ? null : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={s.busy}
                  onClick={() => set((p) => ({ ...p, pending: c, error: null, done: null }))}
                >
                  撤回同意
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {s.done ? (
        <Alert className="mt-3">{s.done}</Alert>
      ) : null}
      {s.error ? (
        <Alert tone="danger" className="mt-3">
          {s.error}
        </Alert>
      ) : null}

      <ConfirmDialog
        open={s.pending !== null}
        title={`撤回「${s.pending?.label ?? ''}」`}
        // 后果那句话是服务端给的（CONSENT_KINDS[kind].effect），页面不另写一份
        description={s.pending?.effect ?? ''}
        confirmLabel="确认撤回这一项同意"
        onConfirm={confirmRevoke}
        onCancel={() => set((p) => ({ ...p, pending: null }))}
      />
    </div>
  );
}

// ───────────────────────── 案件：整案导出 / 删除 ─────────────────────────

interface CaseDataState {
  cases: CaseRow[] | null;
  /** 已经取回、正在等用户确认的那份删除确认单 */
  pending: CaseDeleteConfirm | null;
  busy: boolean;
  exported: CaseExported | null;
  error: string | null;
  done: string | null;
}

const CASE_DATA_INIT: CaseDataState = {
  cases: null,
  pending: null,
  busy: false,
  exported: null,
  error: null,
  done: null,
};

export function CaseDataSection() {
  const [s, set] = useState<CaseDataState>(CASE_DATA_INIT);

  const load = useCallback(() => {
    void dataRightsApi
      .listCases()
      .then((b) => set((p) => ({ ...p, cases: b.cases })))
      .catch(() => set((p) => ({ ...p, cases: [] })));
  }, []);

  useEffect(load, [load]);

  const startExport = (caseId: number) => {
    set((p) => ({ ...p, busy: true, error: null, done: null, exported: null }));
    void dataRightsApi
      .exportCase(caseId)
      .then((r) => set((p) => ({ ...p, busy: false, exported: r })))
      .catch((err) => set((p) => ({ ...p, busy: false, error: humanError(err) })));
  };

  /** 第一步：**不带 confirm_token**，只取确认单，一行都不删。 */
  const startDelete = (caseId: number) => {
    set((p) => ({ ...p, busy: true, error: null, done: null }));
    void dataRightsApi
      .deleteCase(caseId)
      .then((r) =>
        set((p) => ({
          ...p,
          busy: false,
          // 服务端若直接回了 deleted（例如重放一次已删的），照原样说出来，不假装弹过确认框
          pending: r.stage === 'confirm' ? r : null,
          done: r.stage === 'deleted' ? r.note : null,
        })),
      )
      .catch((err) => set((p) => ({ ...p, busy: false, error: humanError(err) })));
  };

  /** 第二步：带上第一步回的那串 confirm_token。 */
  const confirmDelete = () => {
    const t = s.pending;
    if (!t) return;
    set((p) => ({ ...p, busy: true, error: null }));
    void dataRightsApi
      .deleteCase(t.case_id, t.confirm_token)
      .then((r) => {
        set((p) => ({
          ...p,
          busy: false,
          pending: null,
          done: r.stage === 'deleted' ? r.note : null,
        }));
        load();
      })
      .catch((err) => set((p) => ({ ...p, busy: false, pending: null, error: humanError(err) })));
  };

  return (
    <div className="border-t border-line py-3">
      <p className="text-[15px] font-medium text-ink">我的案件档案</p>
      <p className="mt-0.5 text-[14px] leading-6 text-ink-2">
        整案副本免费导出，包含档案全表、文书 PDF 与材料原件。删除的档案会立刻从所有页面消失，
        之后按协议第五条第 8 款彻底删除。
      </p>

      {s.cases === null ? (
        <p className="mt-2 text-[13px] leading-6 text-ink-2">正在读取…</p>
      ) : s.cases.length === 0 ? (
        <p className="mt-2 text-[13px] leading-6 text-ink-2">还没有建过案件档案。</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-3">
          {s.cases.map((c) => (
            <li key={c.id} className="flex items-start gap-2">
              <p className="min-w-0 flex-1 truncate text-[15px] text-ink">{c.title}</p>
              <Button
                variant="secondary"
                size="sm"
                disabled={s.busy}
                onClick={() => startExport(c.id)}
              >
                导出整案副本
              </Button>
              <Button variant="danger" size="sm" disabled={s.busy} onClick={() => startDelete(c.id)}>
                删除这个档案
              </Button>
            </li>
          ))}
        </ul>
      )}

      {s.exported ? (
        <Alert className="mt-3">
          <a href={s.exported.download_url} className="underline">
            下载 {s.exported.filename}
          </a>
          <span className="block">{s.exported.note}</span>
          {s.exported.omissions.map((o) => (
            <span key={o.path} className="block">
              {o.path}：{o.reason}
            </span>
          ))}
        </Alert>
      ) : null}
      {s.done ? <Alert className="mt-3">{s.done}</Alert> : null}
      {s.error ? (
        <Alert tone="danger" className="mt-3">
          {s.error}
        </Alert>
      ) : null}

      <ConfirmDialog
        open={s.pending !== null}
        title={`删除《${s.pending?.title ?? ''}》`}
        description={
          <ConsequenceLists
            removes={s.pending?.removes ?? []}
            keeps={s.pending?.keeps ?? []}
            tail={
              s.pending
                ? `确认之后这个档案立刻从所有页面消失，${s.pending.retention_days} 日后彻底删除，无法撤销。`
                : null
            }
          />
        }
        confirmLabel="确认删除这个档案"
        onConfirm={confirmDelete}
        onCancel={() => set((p) => ({ ...p, pending: null }))}
      />
    </div>
  );
}

// ───────────────────────────── 注销账号 ─────────────────────────────

interface CancelState {
  /** 第一步取回的确认单（同时也是"验证码已经发出去了"的凭据） */
  challenge: CancelChallenge | null;
  code: string;
  busy: boolean;
  error: string | null;
  done: AccountCancelled | null;
}

const CANCEL_INIT: CancelState = { challenge: null, code: '', busy: false, error: null, done: null };

export function CancelAccountSection() {
  const router = useRouter();
  const [s, set] = useState<CancelState>(CANCEL_INIT);

  /** 第一步：零删除，只出确认单 + 把验证码发出去。 */
  const start = () => {
    set((p) => ({ ...p, busy: true, error: null }));
    void dataRightsApi
      .cancelAccount({})
      .then((r) =>
        set((p) => ({
          ...p,
          busy: false,
          challenge: r.stage === 'challenge' ? r : null,
          done: r.stage === 'cancelled' ? r : null,
        })),
      )
      .catch((err) => set((p) => ({ ...p, busy: false, error: humanError(err) })));
  };

  /** 第二步：confirm_token + 收到的验证码，两样齐才执行。 */
  const confirm = () => {
    const ch = s.challenge;
    if (!ch) return;
    set((p) => ({ ...p, busy: true, error: null }));
    void dataRightsApi
      .cancelAccount({ code: s.code, confirm_token: ch.confirm_token })
      .then((r) => {
        if (r.stage !== 'cancelled') {
          set((p) => ({ ...p, busy: false }));
          return;
        }
        set((p) => ({ ...p, busy: false, challenge: null, done: r }));
        // 账号已经没有登录方式了，本机这张 token 留着只会在下一次请求上撞 401
        clearToken();
        router.push('/login');
      })
      .catch((err) => set((p) => ({ ...p, busy: false, error: humanError(err) })));
  };

  return (
    <div className="border-t border-line py-3">
      <p className="text-[15px] font-medium text-ink">注销账号</p>
      <p className="mt-0.5 text-[14px] leading-6 text-ink-2">
        注销不可撤销。点下面这个按钮**不会**注销任何东西，只会取回一份「会删什么、会留下什么」
        的清单，并把验证码发到你的手机或邮箱。
      </p>

      {s.challenge === null ? (
        <div className="mt-3">
          <Button variant="secondary" disabled={s.busy} onClick={start}>
            注销账号
          </Button>
        </div>
      ) : (
        <div className="mt-3 rounded-[10px] border border-dashed border-line p-4">
          <ConsequenceLists
            removes={s.challenge.removes}
            keeps={s.challenge.keeps}
            tail={s.challenge.balance_note}
          />
          <p className="mt-3 text-[13px] leading-6 text-ink-2">
            验证码已发到 {s.challenge.sent_to}。名下 {s.challenge.cases} 个案件档案会一起进入删除流程。
          </p>
          <Input
            className="mt-2"
            inputMode="numeric"
            aria-label="注销验证码"
            value={s.code}
            onChange={(e) => set((p) => ({ ...p, code: e.target.value }))}
          />
          <div className="mt-3 flex gap-2">
            <Button variant="danger" disabled={s.busy || !s.code} onClick={confirm}>
              确认注销，删除我的全部档案
            </Button>
            <Button variant="secondary" onClick={() => set(() => CANCEL_INIT)}>
              再想想
            </Button>
          </div>
        </div>
      )}

      {s.done ? <Alert className="mt-3">{s.done.note}</Alert> : null}
      {s.error ? (
        <Alert tone="danger" className="mt-3">
          {s.error}
        </Alert>
      ) : null}
    </div>
  );
}

export function DataRightsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>我的数据</CardTitle>
      </CardHeader>
      <CardContent>
        <CaseDataSection />
        <ConsentsSection />
        <CancelAccountSection />
      </CardContent>
    </Card>
  );
}
