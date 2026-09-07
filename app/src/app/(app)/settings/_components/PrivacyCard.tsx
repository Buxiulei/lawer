'use client';

import { useEffect, useState } from 'react';
import { apiFetch, humanError } from '@/app/_ui/api';
import {
  CONSENT_KINDS,
  EVAL_OPTIN_HINT,
  EVAL_OPTIN_LABEL,
  OVERSEAS_SWITCH_HINT,
  OVERSEAS_SWITCH_LABEL,
  type ConsentKind,
} from '@/lib/consent';
import { OverseasConsent } from '@/app/terms/overseas/OverseasConsent';
import { Button } from '@/components/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/shadcn/card';
import { Dialog, DialogContent, DialogTitle } from '@/components/shadcn/dialog';
import { Label } from '@/components/shadcn/label';
import { Switch } from '@/components/shadcn/switch';
import { SignInHint } from './SignInHint';

interface MeResponse {
  consents: string[];
  preferences: { overseas_models: boolean; eval_optin: boolean };
}

/**
 * 隐私与同意卡（协议 五.2（2）、五.3、五.5（2）/ 附一 #4、#5、#6）。
 *
 * 三行，各自独立：
 *   · 境外模型 —— **开启前必须先读到那四件事**，所以开是「读说明 → 确认」两步，关是一步；
 *   · 评测授权 —— 默认关，开关一步，随时可关（协议五.3）；
 *   · 情绪与危机记录 —— 单独同意的**网页落点**。站内对话里模型也会问一次，
 *     但 MCP/REST 那条路上的错误提示写的是"到网页设置里给"——那句话必须真有地方可去。
 *
 * 【为什么状态从 /api/v1/me 一次取回】开关的位置与它旁边那句"你同意过没有"来自同一份
 * 数据。分两次请求的形态是：其中一次失败，页面显示"没同意"而用户明明同意过，
 * 于是他再点一次，而服务端早就记着了。
 */
export function PrivacyCard() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [unauthorized, setUnauthorized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 开启境外模型的确认屏（关闭不弹：撤回不该有前置条件） */
  const [overseasOpen, setOverseasOpen] = useState(false);

  const load = async () => {
    try {
      setMe(await apiFetch<MeResponse>('/me'));
      setUnauthorized(false);
    } catch (err) {
      // 没登录时整张卡换成登录引导，不报错——与实名卡同一处置
      if (String(err).includes('401') || String(err).includes('UNAUTHORIZED')) setUnauthorized(true);
      else setError(humanError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // 只在挂载时取一次；后面每次写完都用返回值就地更新，不再整卡重取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const has = (kind: ConsentKind) => me?.consents.includes(kind) ?? false;

  const savePreferences = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await apiFetch<{ overseas_models: boolean; eval_optin: boolean }>(
        '/me/preferences',
        { method: 'POST', body },
      );
      setMe((prev) =>
        prev
          ? {
              // 开启境外时同一次请求也落了同意台账，本地跟着记上，
              // 免得关掉再打开时又弹一次说明（服务端那侧本来就不会再要）
              consents: body.consent === true ? [...new Set([...prev.consents, CONSENT_KINDS.overseas])] : prev.consents,
              preferences: { overseas_models: next.overseas_models, eval_optin: next.eval_optin },
            }
          : prev,
      );
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  const grantEmotion = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/consents', { method: 'POST', body: { kind: CONSENT_KINDS.emotion } });
      setMe((prev) =>
        prev ? { ...prev, consents: [...new Set([...prev.consents, CONSENT_KINDS.emotion])] } : prev,
      );
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>隐私与同意</CardTitle>
        </CardHeader>
        <CardContent>
          {unauthorized ? (
            <SignInHint>这些开关记在你的账号上，登录之后在这里改。</SignInHint>
          ) : (
            <>
              <div className="flex items-start gap-3 border-t border-line py-3">
                <div className="min-w-0 flex-1">
                  <Label htmlFor="overseas-switch" className="text-[15px]">
                    {OVERSEAS_SWITCH_LABEL}
                  </Label>
                  <p className="mt-0.5 text-[14px] leading-6 text-ink-2">{OVERSEAS_SWITCH_HINT}</p>
                </div>
                <div className="flex size-11 shrink-0 items-center justify-center">
                  <Switch
                    id="overseas-switch"
                    checked={me?.preferences.overseas_models ?? false}
                    disabled={loading || busy}
                    onCheckedChange={(next) => {
                      // 开：先给说明再确认；关：立刻生效（撤回不设前置条件）
                      if (next) setOverseasOpen(true);
                      else void savePreferences({ overseas_models: false });
                    }}
                    aria-label={OVERSEAS_SWITCH_LABEL}
                  />
                </div>
              </div>

              <div className="flex items-start gap-3 border-t border-line py-3">
                <div className="min-w-0 flex-1">
                  <Label htmlFor="eval-switch" className="text-[15px]">
                    {EVAL_OPTIN_LABEL}
                  </Label>
                  <p className="mt-0.5 text-[14px] leading-6 text-ink-2">{EVAL_OPTIN_HINT}</p>
                </div>
                <div className="flex size-11 shrink-0 items-center justify-center">
                  <Switch
                    id="eval-switch"
                    checked={me?.preferences.eval_optin ?? false}
                    disabled={loading || busy}
                    onCheckedChange={(next) => void savePreferences({ eval_optin: next })}
                    aria-label={EVAL_OPTIN_LABEL}
                  />
                </div>
              </div>

              <div className="border-t border-line py-3">
                <p className="text-[15px] font-medium text-ink">情绪状态与危机识别记录</p>
                <p className="mt-0.5 text-[14px] leading-6 text-ink-2">
                  记的是情绪档位、时间与你说过的那一句依据。它可以推知你的心理健康状况，
                  所以要单独同意。不同意就不记，其余功能一样用。
                </p>
                {has(CONSENT_KINDS.emotion) ? (
                  <p className="mt-2 text-[13px] leading-5 text-ink-2">你已同意记录。</p>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2.5 self-start"
                    disabled={loading || busy}
                    onClick={() => void grantEmotion()}
                  >
                    同意记录
                  </Button>
                )}
              </div>

              {error && <p className="pt-2 text-[14px] leading-6 text-ink-2">{error}</p>}
            </>
          )}
        </CardContent>
      </Card>

      {/* 开启前那一屏**用 /terms/overseas 那一页的同意件**（经理裁决 2026-09-07：
          以 C3 页面为正本）。两处各写一份告知的形态是：它们慢慢分叉，
          而用户点头时看的是这一屏——于是对外公示的告知与实际取得同意时给的告知
          不是同一段话，合规上等于没有取得对那份告知的同意（见 OverseasDetails 抬头）。

          用 Dialog 而不是 ConfirmDialog：那一件自带「同意 / 不同意」两个平级按钮
          （§39 要的单独且自愿，见它的文件头），外面再套一层确认按钮就成了四个钮，
          用户读不出哪一个才是表意的那一下。 */}
      <Dialog open={overseasOpen} onOpenChange={(next) => !next && setOverseasOpen(false)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[38rem]">
          <DialogTitle className="sr-only">开启境外模型前，先看清这几件事</DialogTitle>
          <OverseasConsent
            onAgree={() => {
              setOverseasOpen(false);
              // consent:true 与开关同一次请求：服务端据它落同意台账，没有它一律拒开
              void savePreferences({ overseas_models: true, consent: true });
            }}
            onDecline={() => setOverseasOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
