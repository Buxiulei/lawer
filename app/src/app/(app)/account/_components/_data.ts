'use client';

/**
 * 「我的」页的数据层：真接口调用 + 视图类型。页面组件只认这里的类型，不认后端字段名。
 *
 *   GET /api/v1/billing/ledger?limit=N  → { ok, balance, ledger_sum, entries[] }
 *
 * 【为什么 balance 和 ledger_sum 都要留着】
 * 后端特意把两个数分开返回，注释写明了理由：只给一个数，物化余额与账本不符时
 * 页面会渲染出**一个看起来完全正常的错数**。而这一页上印着
 * 「每一笔都记着，只增不改。对不上账随时把这页截给我们。」——
 * 兑现那句承诺的方式不是显示一个漂亮数字，是**让不符可见**。
 * 所以前端不许只挑 `balance` 渲染完事，那等于把后端留出的告警信号扔掉。
 */

import { apiFetch } from '@/app/_ui/api';

/**
 * 后端 `GONGDAO_LEDGER_TYPE` 的**全部**取值（`lib/billing/pricing.ts`）。
 *
 * ⚠️ 这份清单此前在前端是照 mock 抄的，与后端**八个值里对不上五个**：
 * mock 写「兑换码」后端是「兑换」（一字之差的近义词）、mock 有「固化出证」后端根本没有、
 * 后端的「会员额度 / 管理员调整 / 失败核销」mock 里一个都没有。
 * 对不上的后果不是崩，是**静默降级成灰色徽标**——页面照常渲染、无任何异常信号。
 */
const LEDGER_TONE = {
  注册赠送: 'success',
  充值: 'success',
  兑换: 'success',
  退款: 'success',
  会员额度: 'success',
  消耗: 'neutral',
  管理员调整: 'primary',
  失败核销: 'amber',
} as const;

export type LedgerType = keyof typeof LEDGER_TONE;

/** 认不出的类型要**出声**，不许静默当灰色处理——静默降级和「本来就是灰的」在页面上同形 */
export function toneOf(type: string): 'success' | 'neutral' | 'primary' | 'amber' {
  if (type in LEDGER_TONE) return LEDGER_TONE[type as LedgerType];
  console.warn('[billing] 未知的流水类型，按中性色渲染：', type);
  return 'neutral';
}

export interface LedgerEntryView {
  id: number;
  delta: number;
  type: string;
  /** 用途，后端可能为空 */
  feature: string | null;
  createdAt: string;
  /** 这一笔之后的余额（后端由当前余额沿时间倒推，任何 limit 下都对） */
  balanceAfter: number;
}

export interface BillingView {
  /** 物化余额，就是计费门槛实际读的那个数 */
  balance: number;
  /** 账本流水求和 */
  ledgerSum: number;
  entries: LedgerEntryView[];
  /**
   * 两个数对得上吗。**不对时必须让用户看见**——他是这条对账信号唯一的读者。
   * 注意只有**取全**流水时这个比较才成立，分页取一部分时无从判断，见 `complete`。
   */
  reconciled: boolean;
  /**
   * 这次是否取到了全部流水。`entries` 少于 limit 说明取全了；
   * 取不全时 `reconciled` 恒为 true（无从判断），别拿它当"对上了"用。
   */
  complete: boolean;
}

interface LedgerResponse {
  balance: number;
  ledger_sum: number;
  entries: {
    id: number;
    delta: number;
    type: string;
    ref_id: string | null;
    feature: string | null;
    created_at: string;
    balance_after: number;
  }[];
}

export async function fetchBilling(limit: number): Promise<BillingView> {
  const raw = await apiFetch<LedgerResponse>(`/billing/ledger?limit=${limit}`);
  const complete = raw.entries.length < limit;
  return {
    balance: raw.balance,
    ledgerSum: raw.ledger_sum,
    entries: raw.entries.map((e) => ({
      id: e.id,
      delta: e.delta,
      type: e.type,
      feature: e.feature,
      createdAt: e.created_at,
      balanceAfter: e.balance_after,
    })),
    // 取不全就无从比较，此时不报"不符"——报了是误报，比不报更坏
    reconciled: complete ? raw.balance === raw.ledger_sum : true,
    complete,
  };
}

// ───────────────────────────── 本人身份摘要 ─────────────────────────────

export interface MeView {
  /** 服务端已掩码。没绑手机的账号确实存在，那时是 null */
  phoneMasked: string | null;
  email: string | null;
  authStatus: string;
  /** 无有效会员时为 null（过期不算）。**没有真值就不显示徽标**，不给占位串 */
  membership: { plan: string; expiresAt: string | null } | null;
}

interface MeResponse {
  phone_masked: string | null;
  email: string | null;
  auth_status: string;
  membership: { plan: string; expires_at: string | null } | null;
}

/**
 * 【没有 nickname】`users` 表里没有这个字段，全站也没有任何地方让用户起过名。
 * 后端不编默认值、前端也不拿 `_mock/demo` 的 `demoUser` 顶——
 * **两侧都不编，这一行才真的空着，空着才有人去问为什么。**
 */
export async function fetchMe(): Promise<MeView> {
  const raw = await apiFetch<MeResponse>('/me');
  return {
    phoneMasked: raw.phone_masked,
    email: raw.email,
    authStatus: raw.auth_status,
    membership: raw.membership
      ? { plan: raw.membership.plan, expiresAt: raw.membership.expires_at }
      : null,
  };
}
