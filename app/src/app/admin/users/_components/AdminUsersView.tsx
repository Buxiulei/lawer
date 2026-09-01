'use client';

// 后台账号管理台。三块：检索 + 列表 / 选中账号的操作面板 / 最近操作。
//
// 【所有变更都过二次确认，确认文案必须写明后果】沿 ConfirmDialog 的既有规矩
//（confirmLabel 不许写「确定」）。这一页的每一个按钮按下去都是钱或权益，
// 而操作者是人——手滑点错行、把 5000 打成 50000，都得在弹层里被读出来。
//
// 【非白名单看到的和路径不存在完全一样】接口回 404 时这一页只出一张
// 「这个地址上没有内容。」，不出标题、不出表格骨架、不出任何"后台"字样。
import { useCallback, useEffect, useState } from 'react';

import { ApiError, apiFetch, humanError } from '@/app/_ui/api';
import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { ConfirmDialog } from '@/components/shadcn/confirm-dialog';
import { Input } from '@/components/shadcn/input';
import { Select } from '@/components/shadcn/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/shadcn/table';

interface AdminUser {
  uid: number;
  email: string | null;
  phone_masked: string | null;
  created_at: string;
  auth_status: string;
  plan: string | null;
  plan_expires_at: string | null;
  balance: number;
  case_count: number;
}

interface UserPage {
  rows: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
  hint: string | null;
  /** 登录者自己的 uid（服务端给）。幂等键要带它，前端不猜自己是谁。 */
  self_uid: number;
}

interface AuditRow {
  id: number;
  operator_uid: number;
  action: string;
  target_uid: number;
  detail_json: string | null;
  created_at: string;
}

const PLANS = [
  { value: 'entry', label: '入门' },
  { value: 'standard', label: '中配' },
  { value: 'pro', label: '高配' },
] as const;

const PLAN_LABEL: Record<string, string> = { entry: '入门', standard: '中配', pro: '高配' };

const FIELDS = [
  { value: 'uid', label: 'UID（精确）' },
  { value: 'email', label: '邮箱（子串）' },
  { value: 'phone', label: '手机（全号）' },
] as const;

/**
 * 可选时长。**与服务端 lib/admin/actions.ADMIN_MEMBERSHIP_DAYS 是同一份值域**，
 * 但不能从那边 import——那个模块连着 better-sqlite3 与 node:crypto，
 * 进不了浏览器包。两处一致由 __tests__/admin-ui-guard.test.ts 机检，防悄悄分叉：
 * 分叉的现象是"下拉里有个选项，选了就报 400"，只有点到那一项的人才会遇到。
 */
const DAYS = [31, 92, 365] as const;

/**
 * 库里的 canonical 串是 UTC、空格分隔、无时区后缀（ADR-002）。
 * `new Date('2026-09-01 10:00:00')` 按**本机时区**解析，在 +08 上整体漂 8 小时——
 * 所以补 'T' 与 'Z' 之后再交给 Intl。存量 ISO 串（带 T/Z）原样吃。
 */
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

/** 幂等键在**打开确认框那一刻**生成，重试复用同一个——重复提交才真的被账本挡下。 */
function newOpRef(operatorHint: number): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `admin-${operatorHint}-${Date.now()}-${rand}`;
}

type Pending =
  | { kind: 'membership'; uid: number; plan: string; days: number }
  | { kind: 'gongdao'; uid: number; delta: number; note: string; opRef: string };

export function AdminUsersView() {
  const [field, setField] = useState<string>('uid');
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState<{ field: string; query: string }>({
    field: 'uid',
    query: '',
  });
  const [page, setPage] = useState(1);

  const [data, setData] = useState<UserPage | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [loading, setLoading] = useState(true);

  const [selected, setSelected] = useState<AdminUser | null>(null);
  const [plan, setPlan] = useState<string>('entry');
  const [days, setDays] = useState<number>(DAYS[0]);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        field: submitted.field,
        q: submitted.query,
        page: String(page),
      });
      const [users, auditRes] = await Promise.all([
        apiFetch<{ ok: true } & UserPage>(`/admin/users?${params}`),
        apiFetch<{ ok: true; rows: AuditRow[] }>('/admin/audit?limit=30'),
      ]);
      setData(users);
      setAudit(auditRes.rows);
    } catch (err) {
      // 404 = 不是白名单里的人（或这条路径根本不存在）。两者刻意同形，页面不解释。
      if (err instanceof ApiError && err.status === 404) {
        setGone(true);
        return;
      }
      setError(humanError(err));
    } finally {
      setLoading(false);
    }
  }, [submitted, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // 列表刷新后把操作面板上的余额/会员档跟上：不同步的话，刚发完钱那一刻面板还写着旧余额，
  // 而这一页的用途正是让操作者确认自己刚才那一下的后果。选中的人不在本页结果里就保持原样。
  useEffect(() => {
    if (!data) return;
    setSelected((prev) => (prev ? (data.rows.find((r) => r.uid === prev.uid) ?? prev) : prev));
  }, [data]);

  if (gone) {
    return (
      <main className="mx-auto max-w-md px-4 py-16">
        <Card className="p-5">
          <p className="text-[15px] text-ink">这个地址上没有内容。</p>
        </Card>
      </main>
    );
  }

  const pick = (u: AdminUser) => {
    setSelected(u);
    setPlan(u.plan ?? 'entry');
    setDays(DAYS[0]);
    setAmount('');
    setNote('');
    setFlash(null);
  };

  const runPending = async () => {
    if (!pending) return;
    setBusy(true);
    setFlash(null);
    try {
      if (pending.kind === 'membership') {
        const res = await apiFetch<{ expires_at: string | null; downgraded: boolean }>(
          `/admin/users/${pending.uid}/membership`,
          { method: 'POST', body: { plan: pending.plan, days: pending.days } },
        );
        setFlash(
          `已把 ${pending.uid} 调为「${PLAN_LABEL[pending.plan]}」${pending.days} 天` +
            `${res.downgraded ? '（降档：原档已提前到期）' : ''}，到期 ${fmtTime(res.expires_at)}`,
        );
      } else {
        const res = await apiFetch<{ balance: number; applied: boolean; ref_id: string }>(
          `/admin/users/${pending.uid}/gongdao`,
          {
            method: 'POST',
            body: { delta: pending.delta, note: pending.note, op_ref: pending.opRef },
          },
        );
        setFlash(
          res.applied
            ? `已发 ${pending.delta} 公道值给 ${pending.uid}，当前余额 ${res.balance}`
            : `这一笔（${res.ref_id}）此前已经发过，本次没有重复入账，余额仍是 ${res.balance}`,
        );
      }
      setPending(null);
      await load();
    } catch (err) {
      setPending(null);
      setFlash(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-[20px] font-semibold text-ink">账号管理台</h1>
        <p className="text-[13px] text-ink-2">
          手机号加密存储，列表只显尾 4；检索手机须填 11 位全号（密文无法模糊匹配）。
        </p>
      </header>

      <form
        className="mt-4 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setSubmitted({ field, query });
        }}
      >
        <Select
          className="h-10 w-[168px] text-[14px]"
          value={field}
          onChange={(e) => setField(e.target.value)}
          aria-label="检索字段"
        >
          {FIELDS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
        <Input
          className="h-10 w-[240px] text-[14px]"
          value={query}
          placeholder="留空= 全部"
          aria-label="检索词"
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" size="sm">
          搜索
        </Button>
      </form>

      {data?.hint && <p className="mt-2 text-[14px] text-amber-ink">{data.hint}</p>}
      {error && <p className="mt-2 text-[14px] text-danger-ink">{error}</p>}

      <Card className="mt-4 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>UID</TableHead>
              <TableHead>邮箱</TableHead>
              <TableHead>手机</TableHead>
              <TableHead>注册时间</TableHead>
              <TableHead>实名</TableHead>
              <TableHead>会员</TableHead>
              <TableHead>公道值</TableHead>
              <TableHead>案件</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.rows ?? []).map((u) => (
              <TableRow key={u.uid}>
                <TableCell className="num">{u.uid}</TableCell>
                <TableCell className="max-w-[220px] truncate">{u.email ?? '—'}</TableCell>
                {/* 只显尾 4。这里**没有**展开全号的入口，服务端也不出全号。 */}
                <TableCell className="num">{u.phone_masked ?? '—'}</TableCell>
                <TableCell className="num whitespace-nowrap">{fmtTime(u.created_at)}</TableCell>
                <TableCell>
                  <Badge tone={u.auth_status === '已实名' ? 'success' : 'neutral'}>
                    {u.auth_status}
                  </Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {u.plan ? (
                    <span>
                      {PLAN_LABEL[u.plan] ?? u.plan}
                      <span className="num ml-1 text-[13px] text-ink-2">
                        至 {fmtTime(u.plan_expires_at)}
                      </span>
                    </span>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell className="num">{u.balance.toLocaleString('zh-CN')}</TableCell>
                <TableCell className="num">{u.case_count}</TableCell>
                <TableCell>
                  <Button size="sm" variant="ghost" onClick={() => pick(u)}>
                    操作
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!loading && (data?.rows.length ?? 0) === 0 && (
          <p className="px-4 py-6 text-[14px] text-ink-2">没有匹配的账号。</p>
        )}
      </Card>

      <div className="mt-3 flex items-center gap-3 text-[14px] text-ink-2">
        <span className="num">
          共 {data?.total ?? 0} 人 · 第 {data?.page ?? 1}/{totalPages} 页
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={(data?.page ?? 1) <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          上一页
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={(data?.page ?? 1) >= totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </Button>
      </div>

      {selected && (
        <Card className="mt-6 p-5">
          <h2 className="text-[16px] font-semibold text-ink">
            账号 <span className="num">{selected.uid}</span>
            <span className="ml-2 text-[14px] font-normal text-ink-2">
              {selected.email ?? selected.phone_masked ?? '（无联系方式）'}
            </span>
          </h2>

          {flash && <p className="mt-2 text-[14px] text-primary-ink">{flash}</p>}

          <section className="mt-4">
            <h3 className="text-[15px] font-medium text-ink">调会员</h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Select
                className="h-10 w-[140px] text-[14px]"
                value={plan}
                aria-label="会员档"
                onChange={(e) => setPlan(e.target.value)}
              >
                {PLANS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
              <Select
                className="h-10 w-[120px] text-[14px]"
                value={days}
                aria-label="时长"
                onChange={(e) => setDays(Number(e.target.value))}
              >
                {DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d} 天
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => setPending({ kind: 'membership', uid: selected.uid, plan, days })}
              >
                调整会员
              </Button>
            </div>
          </section>

          <section className="mt-5">
            <h3 className="text-[15px] font-medium text-ink">发公道值</h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Input
                className="h-10 w-[140px] text-[14px]"
                inputMode="numeric"
                value={amount}
                aria-label="数额"
                placeholder="数额"
                onChange={(e) => setAmount(e.target.value)}
              />
              <Input
                className="h-10 w-[280px] text-[14px]"
                value={note}
                aria-label="备注"
                placeholder="备注（必填，事后要靠它解释）"
                onChange={(e) => setNote(e.target.value)}
              />
              <Button
                size="sm"
                disabled={busy || !/^\d+$/.test(amount.trim()) || !note.trim()}
                onClick={() =>
                  setPending({
                    kind: 'gongdao',
                    uid: selected.uid,
                    delta: Number(amount.trim()),
                    note: note.trim(),
                    opRef: newOpRef(data?.self_uid ?? 0),
                  })
                }
              >
                发放
              </Button>
            </div>
          </section>
        </Card>
      )}

      <section className="mt-8">
        <h2 className="text-[16px] font-semibold text-ink">最近操作</h2>
        <Card className="mt-2 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>操作者</TableHead>
                <TableHead>动作</TableHead>
                <TableHead>对象</TableHead>
                <TableHead>明细</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {audit.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="num whitespace-nowrap">{fmtTime(a.created_at)}</TableCell>
                  <TableCell className="num">{a.operator_uid}</TableCell>
                  <TableCell>{a.action}</TableCell>
                  <TableCell className="num">{a.target_uid}</TableCell>
                  <TableCell className="max-w-[420px] truncate text-[13px] text-ink-2">
                    {a.detail_json ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {audit.length === 0 && (
            <p className="px-4 py-6 text-[14px] text-ink-2">还没有后台操作记录。</p>
          )}
        </Card>
      </section>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === 'gongdao' ? '确认发放公道值' : '确认调整会员'}
        description={
          pending?.kind === 'gongdao' ? (
            <span>
              给账号 <b className="num">{pending.uid}</b> 发放{' '}
              <b className="num">{pending.delta.toLocaleString('zh-CN')}</b> 公道值，备注「
              {pending.note}」。发出后进账本、不可撤销（要收回得再做一次反向调整）。
            </span>
          ) : pending ? (
            <span>
              把账号 <b className="num">{pending.uid}</b> 调为「{PLAN_LABEL[pending.plan]}」
              <b className="num">{pending.days}</b> 天，立即生效。若当前档更高，这一步会把
              现有会员期<b>提前到此刻结束</b>。
            </span>
          ) : null
        }
        confirmLabel={
          pending?.kind === 'gongdao'
            ? `确认发放 ${pending.delta} 公道值`
            : pending
              ? `确认调为 ${PLAN_LABEL[pending.plan]} ${pending.days} 天`
              : '确认'
        }
        tone="primary"
        onConfirm={() => void runPending()}
        onCancel={() => setPending(null)}
      />
    </main>
  );
}
