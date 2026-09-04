'use client';

import { useCallback, useEffect, useState } from 'react';
import { notFound } from 'next/navigation';
import { ApiError, apiFetch, humanError } from '@/app/_ui/api';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { Input } from '@/components/shadcn/input';
import { WooNav } from '../_components/WooNav';

interface CodeRow {
  id: number;
  code: string;
  gongdao_value: number;
  note: string | null;
  enabled: number;
  expires_at: string | null;
  redeemed_by: number | null;
  redeemed_at: string | null;
  created_at: string;
}

/**
 * 兑换码后台（极简：签发一批 + 看列表）。
 *
 * 【404 从哪来】接口对非白名单回的是空体 404，`apiFetch` 把它翻成 `ApiError`
 * 且 `status === 404`。这里就地 `notFound()`，用户看到的是全站那张 404 卡——
 * 与随便敲一个不存在的地址**完全一样**。不写「你没有权限」：那句话等于承认这里有个后台。
 */
export function AdminCodesView() {
  const [rows, setRows] = useState<CodeRow[] | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 签发表单
  const [count, setCount] = useState('10');
  const [gongdao, setGongdao] = useState('300');
  const [note, setNote] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ codes: CodeRow[] }>('/admin/codes');
      setRows(res.codes);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setGone(true);
        return;
      }
      setError(humanError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // notFound() 必须在渲染期抛，不能在 effect 里调——放在这里，全站 404 边界接住。
  if (gone) notFound();

  async function issue() {
    setBusy(true);
    setError(null);
    setIssued(null);
    try {
      const res = await apiFetch<{ codes: string[] }>('/admin/codes', {
        method: 'POST',
        body: {
          count: Number(count),
          gongdao: Number(gongdao),
          note: note.trim(),
          expires_at: expiresAt.trim(),
        },
      });
      setIssued(res.codes);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setGone(true);
        return;
      }
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      {/* 走到这里就是接口已放行（上面的 gone 分支已 notFound()），导航条挂在这儿
          天然不会被非白名单的人看见。 */}
      <WooNav />
      <h1 className="text-[20px] font-semibold text-ink">兑换码</h1>

      <Card className="mt-4 p-4">
        <h2 className="text-[17px] font-semibold text-ink">签发一批</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-4">
          <label className="text-[14px] text-ink-2">
            张数
            <Input
              value={count}
              onChange={(e) => setCount(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              className="num mt-1"
            />
          </label>
          <label className="text-[14px] text-ink-2">
            单张面值
            <Input
              value={gongdao}
              onChange={(e) => setGongdao(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              className="num mt-1"
            />
          </label>
          <label className="text-[14px] text-ink-2">
            批次备注
            <Input value={note} onChange={(e) => setNote(e.target.value)} className="mt-1" />
          </label>
          <label className="text-[14px] text-ink-2">
            到期（留空＝不过期）
            <Input
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              placeholder="2026-12-31"
              className="num mt-1"
            />
          </label>
        </div>
        <Button size="sm" className="mt-3" disabled={busy} onClick={() => void issue()}>
          {busy ? '签发中' : '签发'}
        </Button>

        {error && <p className="mt-2 text-[14px] leading-6 text-danger-ink">{error}</p>}

        {issued && (
          <div className="mt-3">
            <p className="text-[14px] text-ink-2">这一批 {issued.length} 张，复制走：</p>
            {/* 明文码本来就存在库里，列表页也照样回显——这里不做「只此一次」的假神秘感 */}
            <textarea
              readOnly
              value={issued.join('\n')}
              rows={Math.min(12, issued.length + 1)}
              className="num mt-1 w-full rounded-[8px] border border-line bg-surface-2 p-2 text-[13px]"
            />
          </div>
        )}
      </Card>

      <Card className="mt-4 overflow-x-auto p-4">
        <h2 className="text-[17px] font-semibold text-ink">全部码</h2>
        {rows === null ? (
          <p className="mt-2 text-[14px] text-ink-2">读取中…</p>
        ) : rows.length === 0 ? (
          <p className="mt-2 text-[14px] text-ink-2">还没有签发过任何码。</p>
        ) : (
          <table className="mt-3 w-full text-left text-[13px]">
            <thead className="text-ink-2">
              <tr>
                <th className="py-1 pr-3">码</th>
                <th className="py-1 pr-3">面值</th>
                <th className="py-1 pr-3">备注</th>
                <th className="py-1 pr-3">状态</th>
                <th className="py-1 pr-3">兑换人</th>
                <th className="py-1 pr-3">兑换时间</th>
                <th className="py-1">到期</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="num py-1 pr-3">{r.code}</td>
                  <td className="num py-1 pr-3">{r.gongdao_value}</td>
                  <td className="py-1 pr-3">{r.note ?? '—'}</td>
                  <td className="py-1 pr-3">{statusOf(r)}</td>
                  <td className="num py-1 pr-3">{r.redeemed_by ?? '—'}</td>
                  <td className="num py-1 pr-3">{r.redeemed_at ?? '—'}</td>
                  <td className="num py-1">{r.expires_at ?? '不过期'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

/**
 * 状态是**算出来的**，库里没有这一列——已兑 / 已停用 / 已过期 / 可用。
 * 顺序与核销那边一致（lib/billing/redeem.ts）：先看兑没兑，再看停没停，最后看过没过期。
 */
function statusOf(r: CodeRow): string {
  if (r.redeemed_by != null) return '已兑换';
  if (!r.enabled) return '已停用';
  // 到期串是 UTC canonical（库里就这一种格式），补 T/Z 再比，别让本机时区插进来
  if (r.expires_at && new Date(r.expires_at.replace(' ', 'T') + 'Z') < new Date()) return '已过期';
  return '可用';
}
