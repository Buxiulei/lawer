'use client';

import { useEffect, useState } from 'react';

import { apiFetch, humanError } from '@/app/_ui/api';
import { DiscreetCollapse } from '@/app/_ui/DiscreetCollapse';
import { useDiscreet } from '@/app/_ui/discreet';
import { fetchMyCases, type CaseSummary } from '@/app/_ui/currentCase';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { NO_TOOL_CLIENTS, clientById } from '@/lib/paste/clients';
import { Button } from '@/components/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/shadcn/card';
import { Checkbox } from '@/components/shadcn/checkbox';
import { Field } from '@/components/shadcn/field';
import { Select } from '@/components/shadcn/select';
import { Textarea } from '@/components/shadcn/textarea';
import { useToast } from '@/components/ui/Toast';
import { CodeBlock } from '../../_components/CodeBlock';

/**
 * 「无工具接入」卡（设计稿 §15 路径 D）。
 *
 * 给的是三步：**选客户端 → 复制开场白 → 把助手的回复粘回来**。
 * 它服务的是 DeepSeek 网页版、豆包网页版、国内的 Gemini 网页版这类
 * **连不了任何工具、也没有常驻设定位**的客户端：能力全靠那一段开场白，
 * 回写全靠用户手动粘回来。
 *
 * 【为什么「每次新对话要重贴」必须写在屏幕上】这类客户端记不住上一轮的设定。
 * 不说这句话的形态是：用户第二天开一个新对话直接问，助手手上没有事实卡也没有纪律，
 * 于是凭记忆答——而它答得很流畅，用户不会发现自己在跟一个什么都不知道的助手谈自己的事。
 *
 * 【低调模式】卡标题与所有常驻文字走中性词；开场白正文（逐字带着案情）与解析结果
 * 都放进 DiscreetCollapse / data-veil。这一页的页面级守卫会逐词点名（agent-page-discreet）。
 */
type Phase = 'idle' | 'loading' | 'ready';

interface PreviewItem {
  index: number;
  kind: string;
  summary: string;
  ok: boolean;
  error: { code: string; message: string } | null;
  dedup: string;
  dedup_note: string;
}

interface PreviewBody {
  batch_id: string;
  crisis: { triggered: boolean; message: string | null };
  items: PreviewItem[];
  unknown_keys: string[];
}

interface ConfirmBody {
  results: { index: number; summary: string; ok: boolean; deduped: boolean; error: { message: string } | null }[];
  written: number;
  deduped: number;
  failed: number;
}

export function NoToolCard() {
  const { discreet } = useDiscreet();
  const toast = useToast();

  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [caseId, setCaseId] = useState<number | null>(null);
  const [clientId, setClientId] = useState(NO_TOOL_CLIENTS[0].id);

  const [openerPhase, setOpenerPhase] = useState<Phase>('idle');
  const [opener, setOpener] = useState<string | null>(null);
  const [openerError, setOpenerError] = useState<string | null>(null);

  const [text, setText] = useState('');
  const [preview, setPreview] = useState<PreviewBody | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<ConfirmBody | null>(null);

  useEffect(() => {
    let alive = true;
    fetchMyCases()
      .then((list) => {
        if (!alive) return;
        setCases(list);
        setCaseId(list[0]?.id ?? null);
      })
      .catch(() => {
        if (alive) setCases([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const client = clientById(clientId) ?? NO_TOOL_CLIENTS[0];

  const copyOpener = async () => {
    if (caseId === null) return;
    setOpenerPhase('loading');
    setOpenerError(null);
    try {
      const body = await apiFetch<{ text: string; omitted: string[] }>(
        `/cases/${caseId}/opener?tier=${client.tier}`,
      );
      setOpener(body.text);
      setOpenerPhase('ready');
      // 复制失败不算失败：文本已经在下面的折叠块里，长按也能选中
      await navigator.clipboard
        .writeText(body.text)
        .then(() => toast('开场白已复制，去那个对话框里粘上', 'success', '已复制'))
        .catch(() => toast('复制没成功，点开下面那块手动复制', 'neutral', '操作未完成'));
    } catch (err) {
      setOpenerPhase('idle');
      setOpenerError(humanError(err));
    }
  };

  const runPreview = async () => {
    if (caseId === null) return;
    setBusy(true);
    setPasteError(null);
    setConfirmed(null);
    try {
      const body = await apiFetch<PreviewBody>(`/cases/${caseId}/paste-back`, {
        method: 'POST',
        body: { text },
      });
      setPreview(body);
      // 默认勾上能写的那些：用户要做的是**取消**他不想留的，而不是逐条勾一遍
      setChecked(new Set(body.items.filter((i) => i.ok).map((i) => i.index)));
    } catch (err) {
      setPreview(null);
      setPasteError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  const runConfirm = async () => {
    if (caseId === null || !preview) return;
    setBusy(true);
    setPasteError(null);
    try {
      const body = await apiFetch<ConfirmBody>(`/cases/${caseId}/paste-back/confirm`, {
        method: 'POST',
        body: { batch_id: preview.batch_id, accept: [...checked] },
      });
      setConfirmed(body);
    } catch (err) {
      setPasteError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (index: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>接不了工具的客户端</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p data-veil="" className="text-[14px] leading-6 text-ink-2">
          DeepSeek 网页版、豆包网页版、国内的 Gemini 网页版这类客户端没有工具入口，连不上这边。
          走这条路：把下面这段「开场白」复制进新对话，聊完之后再把它的回复整段粘回来，
          我替你把该记的东西挑出来，你点头才写进{discreet ? NEUTRAL_WORD.dossier : '档案'}。
        </p>
        <p className="text-[14px] leading-6 font-semibold text-primary-ink">
          这类客户端记不住上一轮：每开一个新对话，都要把开场白重贴一次。
        </p>

        {cases !== null && cases.length === 0 ? (
          <p className="text-[14px] leading-6 text-ink-2">
            名下还没有可用的{discreet ? NEUTRAL_WORD.caseGroup : '案件'}，先去建一个再回来。
          </p>
        ) : (
          <>
            {cases !== null && cases.length > 1 && (
              <Field label={`给哪一个${discreet ? NEUTRAL_WORD.caseGroup : '案件'}用`}>
                <Select
                  value={caseId ?? ''}
                  onChange={(e) => setCaseId(Number(e.target.value))}
                >
                  {cases.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <Field label="你要用哪个客户端" hint={client.note}>
              <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
                {NO_TOOL_CLIENTS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>

            <div>
              <Button disabled={caseId === null || openerPhase === 'loading'} onClick={() => void copyOpener()}>
                {openerPhase === 'loading' ? '正在生成…' : '复制开场白'}
              </Button>
              {openerError && (
                <p className="mt-2 text-[14px] leading-6 text-ink-2">{openerError}</p>
              )}
              {opener && (
                <div className="mt-3">
                  {/* 开场白逐字带着案情（事实卡就在里面），低调模式下整块折叠 */}
                  <DiscreetCollapse label="开场白全文（点开查看）">
                    <CodeBlock code={opener} wrap maxHeight="max-h-72" copyLabel="再复制一次" />
                  </DiscreetCollapse>
                </div>
              )}
            </div>

            <div className="border-t border-ink-2/15 pt-4">
              <Field
                label="把助手的回复粘回来"
                hint="整段粘（包括末尾那个结构块）。块外面的话我不会记进去。"
              >
                <Textarea
                  rows={5}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="在这里粘贴助手那一轮的完整回复"
                />
              </Field>
              <Button
                className="mt-3"
                variant="secondary"
                disabled={busy || !text.trim() || caseId === null}
                onClick={() => void runPreview()}
              >
                {busy && !preview ? '正在看…' : '看看要写什么'}
              </Button>
              {pasteError && (
                <p className="mt-2 rounded-[10px] bg-amber-wash px-3 py-2.5 text-[14px] leading-6 text-amber-ink">
                  {pasteError}
                </p>
              )}
            </div>

            {preview?.crisis.triggered && preview.crisis.message && (
              /* 危机提示不折叠、不糊：号码要在最坏的那一刻一眼能看见，这比低调优先 */
              <div
                role="alert"
                className="rounded-[10px] border-l-4 border-danger bg-danger-wash px-3 py-2.5 text-[14px] leading-6 whitespace-pre-wrap text-danger-ink"
              >
                {preview.crisis.message}
              </div>
            )}

            {preview && !confirmed && (
              <div data-veil="">
                <p className="text-[14px] leading-6 text-ink-2">
                  {preview.items.length === 0
                    ? '这一轮没有要记的东西（助手给的是空块）。'
                    : '勾上要留下的，取消不要的。没勾的一个字都不会写进去。'}
                </p>
                <ul className="mt-2 flex flex-col gap-2">
                  {preview.items.map((item) => (
                    <li key={item.index} className="flex items-start gap-3">
                      <Checkbox
                        className="mt-1"
                        checked={checked.has(item.index)}
                        disabled={!item.ok}
                        onCheckedChange={() => toggle(item.index)}
                        aria-label={item.summary}
                      />
                      <div className="text-[14px] leading-6">
                        <p className="text-ink">{item.summary}</p>
                        <p className={item.ok ? 'text-ink-2' : 'text-amber-ink'}>
                          {item.ok ? item.dedup_note : item.error?.message}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
                {preview.unknown_keys.length > 0 && (
                  <p className="mt-2 text-[13px] leading-5 text-ink-2">
                    结构块里还有我不认的键：{preview.unknown_keys.join('、')}（这些没有解析）。
                  </p>
                )}
                {preview.items.some((i) => i.ok) && (
                  <Button className="mt-3" disabled={busy || checked.size === 0} onClick={() => void runConfirm()}>
                    {busy ? '正在写…' : `确认写入这 ${checked.size} 条`}
                  </Button>
                )}
              </div>
            )}

            {confirmed && (
              <div data-veil="" className="rounded-[10px] bg-surface-2 px-3 py-2.5">
                <p className="text-[14px] leading-6 font-semibold text-ink">
                  写好了：新增 {confirmed.written} 条
                  {confirmed.deduped > 0 && `，${confirmed.deduped} 条本来就有（没有重复记）`}
                  {confirmed.failed > 0 && `，${confirmed.failed} 条没写进去`}。
                </p>
                <ul className="mt-1 flex flex-col gap-1">
                  {confirmed.results.map((r) => (
                    <li key={r.index} className="text-[13px] leading-5 text-ink-2">
                      {r.summary}：{r.ok ? (r.deduped ? '本来就有' : '已记下') : r.error?.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
