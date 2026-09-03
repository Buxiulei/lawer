'use client';

// 护照实名待审队列（管理后台顶部）。
//
// ── 为什么是独立组件，而不是并进 AdminUsersView ──
// **这是硬约束，不是风格偏好。** AdminUsersView 的 pending/runPending 状态机被两个测试
// 文件逐字符钉着（admin-op-ref.test.ts 与 structure-guard.test.ts ④）：
// `setPending({ kind:` 恰好 2 处、`method: 'POST'` 恰好 2 处、catch 块不含 setPending、
// runPending→totalPages 之间的锚点截取。那些计数守的是"钱不双发"的跨请求幂等，
// 把审核动作塞进同一个 pending 里，等于把一条与钱无关的路混进那把尺子——
// 尺子会红，而唯一的"修法"是改断言数字，那把守住双发洞的牙就此磨平一颗。
// 所以本组件自带 state、自带确认弹层，与那条状态机零交集。
//
// ── 为什么审核动作不需要 op_ref（那两条要）──
// 会员/公道值重试会**再发一份**；审核不会：approve/reject 只接受「待审」流水，
// 第二次点击拿到的是 400 BAD_STATE，而不是第二次落定。重复提交在这里天然幂等。
//
// ── 为什么照片要用 fetch+blob 而不是 <img src="/api/..."> ──
// 本站鉴权是 Authorization: Bearer（token 在 localStorage），浏览器发 <img> 请求
// **不带这个头** ⇒ 直接撞上后台闸门的 404，页面上是一张裂图，而原因看不出来。
// 所以取图走 fetch 手动带头 → blob → createObjectURL，收起面板时 revoke
//（不 revoke 就是每看一张证件照在内存里永久留一份）。
//
// ── 低调模式不适用后台 ──
// 与 users/page.tsx 同一条既有约定：这一页不套 Sensitive、不加 data-veil。
import { useCallback, useEffect, useRef, useState } from 'react';

import { API_BASE, ApiError, apiFetch, humanError } from '@/app/_ui/api';
import { readToken } from '@/app/_ui/auth';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { ConfirmDialog } from '@/components/shadcn/confirm-dialog';
import { Textarea } from '@/components/shadcn/textarea';

interface PendingRow {
  verification_id: number;
  user_id: number;
  email: string | null;
  phone: string | null;
  phone_error: string | null;
  cert_name: string | null;
  cert_no: string | null;
  /** 信封解不开时的原话。这一行照样列出来——静默跳过等于这条待审永远没人看见 */
  envelope_error: string | null;
  submitted_at: string;
}

type Review = { kind: 'approve'; row: PendingRow } | { kind: 'reject'; row: PendingRow; reason: string };

const MATERIALS = [
  { kind: 'id_page', label: '护照资料页' },
  { kind: 'selfie', label: '手持护照自拍' },
] as const;

/** 与 AdminUsersView.fmtTime 同一套（库里是 UTC、空格分隔、无时区后缀，ADR-002）。 */
function fmtTime(value: string | null): string {
  if (!value) return '—';
  const iso = value.includes('T') || value.includes('Z') ? value : `${value.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/**
 * 取一张证件照的 objectURL。**失败要说清是哪一种**：
 * 404 多半是登录态没带上或不是白名单，500 是盘上密文坏了——两者的处置完全不同。
 */
async function fetchPhoto(verificationId: number, kind: string): Promise<string> {
  const token = readToken();
  const res = await fetch(`${API_BASE}/admin/realname/${verificationId}/photo/${kind}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const message =
      (detail as { message?: string } | null)?.message ??
      (res.status === 404 ? '取不到这张材料（记录不存在，或当前登录态不是管理员）' : '这张材料没取回来');
    throw new Error(`${message}（HTTP ${res.status}）`);
  }
  return URL.createObjectURL(await res.blob());
}

function MaterialViewer({ row }: { row: PendingRow }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // objectURL 必须在卸载时逐个 revoke。用 ref 存是因为清理函数跑的时候
  // state 已经是旧闭包里的那份，拿不到最后一次 setUrls 的结果。
  const live = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    for (const m of MATERIALS) {
      void fetchPhoto(row.verification_id, m.kind)
        .then((url) => {
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          live.current.push(url);
          setUrls((prev) => ({ ...prev, [m.kind]: url }));
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setErrors((prev) => ({ ...prev, [m.kind]: err instanceof Error ? err.message : String(err) }));
          }
        });
    }
    const urlsAtCleanup = live.current;
    return () => {
      cancelled = true;
      for (const u of urlsAtCleanup) URL.revokeObjectURL(u);
      urlsAtCleanup.length = 0;
    };
  }, [row.verification_id]);

  return (
    <div className="mt-3 flex flex-wrap gap-4">
      {MATERIALS.map((m) => (
        <figure key={m.kind} className="w-[280px]">
          <figcaption className="text-[13px] text-ink-2">{m.label}</figcaption>
          {urls[m.kind] ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={urls[m.kind]}
              alt={m.label}
              className="mt-1 w-full rounded-[10px] border border-line object-contain"
            />
          ) : errors[m.kind] ? (
            <p className="mt-1 text-[13px] leading-5 text-danger-ink">{errors[m.kind]}</p>
          ) : (
            <p className="mt-1 text-[13px] text-ink-2">正在取…</p>
          )}
        </figure>
      ))}
    </div>
  );
}

export function RealnamePendingQueue() {
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [loading, setLoading] = useState(true);
  /** 404 = 不是白名单（或这条路径不存在）。整块隐身，不解释、不出「后台」字样。 */
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const body = await apiFetch<{ ok: true; count: number; rows: PendingRow[] }>(
        '/admin/realname/pending',
      );
      setRows(body.rows);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setGone(true);
        return;
      }
      setError(humanError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runReview = async () => {
    if (!review) return;
    setBusy(true);
    setFlash(null);
    try {
      const path = `/admin/realname/${review.row.verification_id}/${review.kind}`;
      const body = review.kind === 'reject' ? { reason: review.reason } : {};
      await apiFetch<{ ok: true }>(path, { method: 'POST', body });
      setFlash(
        review.kind === 'approve'
          ? `账号 ${review.row.user_id} 已转「已实名」（证件类型：护照）。已尽力给他发一封中性通知。`
          : `已驳回账号 ${review.row.user_id} 的这次提交，他会在设置页看到你写的原因，并可以重新提交。`,
      );
      setReview(null);
      setOpenId(null);
      await load();
    } catch (err) {
      // 失败不关弹层：审核不像发钱那样怕重试（非待审的流水只会拿到 400），
      // 但把错误显示在原地，操作者才知道自己刚才那一下到底成没成。
      setFlash(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  if (gone) return null;

  // 【队列空掉也要走同一个 return】早先这里是一条早退分支，于是"审完最后一条"那一刻
  // 整块面板换成一句"当前没有待审"，**flash 被一起吞掉**——操作者刚点完确认，
  // 屏幕上没有一个字说刚才那一下成没成，只有一块突然空掉的面板。
  // 真机跑出来的就是这个（drive.json：flash=(none)、emptyQueue=1）。
  const empty = !loading && rows.length === 0;

  return (
    <section className="mb-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[16px] font-semibold text-ink">
          实名待审核{empty ? '' : <> <span className="num">{rows.length}</span> 件</>}
        </h2>
        {!empty && (
          <p className="text-[13px] text-ink-2">
            护照通道由人工核材料。核对要点：两张图上的姓名与护照号必须与下面逐字一致；自拍里的人脸与资料页照片是同一个人；护照在有效期内。
          </p>
        )}
      </div>

      {error && <p className="mt-2 text-[14px] text-danger-ink">{error}</p>}
      {flash && <p className="mt-2 text-[14px] text-primary-ink">{flash}</p>}
      {empty && !error && (
        <p className="mt-1 text-[14px] text-ink-2">当前没有等待人工核验的护照实名申请。</p>
      )}

      <div className="mt-3 flex flex-col gap-3">
        {rows.map((row) => (
          <Card key={row.verification_id} className="p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-[15px] text-ink">
                账号 <span className="num">{row.user_id}</span>
                <span className="ml-2 text-[14px] text-ink-2">
                  {row.email ?? row.phone ?? row.phone_error ?? '（无联系方式）'}
                </span>
              </div>
              <span className="num text-[13px] text-ink-2">
                提交于 {fmtTime(row.submitted_at)} · 流水 #{row.verification_id}
              </span>
            </div>

            {row.envelope_error ? (
              <p className="mt-2 text-[14px] leading-6 text-danger-ink">
                这条流水的材料信封读不出来：{row.envelope_error}
              </p>
            ) : (
              <p className="mt-2 text-[15px] leading-7 text-ink">
                姓名 <b>{row.cert_name ?? '—'}</b>
                <span className="ml-4">
                  护照号 <b className="num">{row.cert_no ?? '—'}</b>
                </span>
              </p>
            )}

            <div className="mt-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setOpenId((cur) => (cur === row.verification_id ? null : row.verification_id))}
              >
                {openId === row.verification_id ? '收起材料' : '查看材料'}
              </Button>
            </div>

            {openId === row.verification_id && <MaterialViewer row={row} />}

            <div className="mt-4 flex flex-wrap items-start gap-2">
              <Button
                size="sm"
                disabled={busy || row.envelope_error !== null}
                onClick={() => setReview({ kind: 'approve', row })}
              >
                通过
              </Button>
              <div className="flex flex-1 flex-wrap items-start gap-2">
                <Textarea
                  rows={2}
                  className="min-w-[280px] flex-1 text-[14px]"
                  aria-label="驳回原因"
                  placeholder="驳回原因（必填，用户会原样看到这句话）"
                  value={reasons[row.verification_id] ?? ''}
                  onChange={(e) =>
                    setReasons((prev) => ({ ...prev, [row.verification_id]: e.target.value }))
                  }
                />
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy || !(reasons[row.verification_id] ?? '').trim()}
                  onClick={() =>
                    setReview({
                      kind: 'reject',
                      row,
                      reason: (reasons[row.verification_id] ?? '').trim(),
                    })
                  }
                >
                  驳回
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <ConfirmDialog
        open={review !== null}
        title={review?.kind === 'reject' ? '确认驳回这次实名' : '确认通过这次实名'}
        description={
          review?.kind === 'reject' ? (
            <span>
              驳回账号 <b className="num">{review.row.user_id}</b> 的护照实名，原因「{review.reason}」。
              这句话会<b>原样</b>显示给用户；他会被打回「未认证」，可以重新提交。
            </span>
          ) : review ? (
            <span>
              把账号 <b className="num">{review.row.user_id}</b> 认定为
              「<b>{review.row.cert_name ?? '—'}</b>／护照 <b className="num">{review.row.cert_no ?? '—'}</b>」。
              这是一次<b>身份断言</b>：此后他出具的存证文件都以这个身份署名，且不可撤销。
            </span>
          ) : null
        }
        confirmLabel={
          review?.kind === 'reject'
            ? `确认驳回并告知原因`
            : review
              ? `确认认定为 ${review.row.cert_name ?? '该身份'}`
              : '确认'
        }
        tone={review?.kind === 'reject' ? 'danger' : 'primary'}
        onConfirm={() => void runReview()}
        onCancel={() => setReview(null)}
      />
    </section>
  );
}
