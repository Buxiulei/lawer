'use client';

import { useState } from 'react';
import { humanError } from '@/app/_ui/api';
import { useDiscreet } from '@/app/_ui/discreet';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import { Button } from '@/components/shadcn/button';
import { Card } from '@/components/shadcn/card';
import { Input } from '@/components/shadcn/input';
import { redeemCode } from './_data';

/**
 * 兑换码入口。放在余额卡下面、散充上面：这三样是同一件事的三条路
 * （已经有码的走这里，没码的往下看充值），分开摆会让拿着码的人找不到地方输。
 *
 * 【成功后不自己加余额，回调重取】面值前端是知道的（后端回了 gongdao），
 * 把它加到旧余额上显示也"看起来对"。但这一页印着「对不上账随时把这页截给我们」，
 * 显示一个前端算出来的数就是把那句话作废——余额必须是服务端刚回的那个真值。
 *
 * 【低调模式】按 NEUTRAL_WORD 口径：整段不出现「公道值」，也不出现任何案件字样。
 * 「兑换码」三个字本身是中性的（哪个应用都有），不换。
 */
export function RedeemPanel({ onRedeemed }: { onRedeemed: () => void }) {
  const { discreet } = useDiscreet();
  const creditWord = discreet ? NEUTRAL_WORD.credits : '公道值';

  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const canSubmit = code.trim().length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await redeemCode(code.trim());
      setDone(result.gongdao);
      setCode('');
      onRedeemed();
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <h2 className="text-[17px] font-semibold text-ink">兑换码</h2>
      {/* 说清「兑的是什么」：不写出到账的东西，这一格与"填个码试试"没有区别 */}
      <p className="mt-0.5 text-[14px] leading-6 text-ink-2">
        有码就直接输，面值{creditWord}立刻到账、马上能用。一条码只能用一次。
      </p>

      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          value={code}
          // 码只由大写字母与数字组成，边输边归一：手机键盘默认小写，
          // 不在这里转的话用户会看着一串小写字母，怀疑自己抄错了。
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          aria-label="兑换码"
          placeholder="输入兑换码"
          className="num flex-1"
        />
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {busy ? '兑换中' : '兑换'}
        </Button>
      </form>

      {error && <p className="mt-2 text-[14px] leading-6 text-danger-ink">{error}</p>}
      {done !== null && (
        <p className="num mt-2 text-[14px] leading-6 text-success-ink">
          已到账 {done.toLocaleString('zh-CN')} {creditWord}。
        </p>
      )}
    </Card>
  );
}
