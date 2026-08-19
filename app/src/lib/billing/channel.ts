// app/src/lib/billing/channel.ts
// 支付渠道抽象：接入哪家（支付宝/微信/…）只实现本接口，账本侧不感知渠道差异。

export interface CreateOrderResult {
  payUrl: string;    // 拉起支付的 URL（wap / page 均为跳转 URL）
  orderNo: string;
}

export interface NotifyPayload {
  outTradeNo: string;       // 商户订单号
  tradeNo: string;          // 渠道交易号
  totalAmountFen: number;   // 实付金额（分）
  tradeStatus: string;      // 渠道交易状态原文
}

export interface RefundResult {
  ok: boolean;
  raw?: unknown;
}

export interface PaymentChannel {
  /** 创建支付订单，返回支付 URL */
  createOrder(params: {
    orderNo: string;
    amountFen: number;
    subject: string;
    userAgent?: string;
    returnUrl?: string;
  }): Promise<CreateOrderResult>;

  /** 验证并解析异步回调，返回规范化 payload；验签失败抛错 */
  verifyNotify(rawBody: string | Record<string, string>): Promise<NotifyPayload>;

  /** 主动查单（兜底轮询用） */
  queryOrder(orderNo: string): Promise<{ status: string; tradeNo?: string }>;

  /** 发起退款；outRequestNo 为幂等号（同号重复调用安全） */
  refund(opts: {
    outTradeNo: string;
    amountFen: number;
    outRequestNo: string;
    reason?: string;
  }): Promise<RefundResult>;
}

/** 测试用 Mock Channel */
export class MockChannel implements PaymentChannel {
  // 记录已处理的退款幂等号，保证重复调用安全
  private _refundedIds = new Set<string>();

  async createOrder({ orderNo, amountFen, subject }: { orderNo: string; amountFen: number; subject: string }): Promise<CreateOrderResult> {
    return { payUrl: `http://mock-pay.test/pay?order=${orderNo}&amount=${amountFen}&subject=${encodeURIComponent(subject)}`, orderNo };
  }
  async verifyNotify(payload: Record<string, string>): Promise<NotifyPayload> {
    return {
      outTradeNo: payload.out_trade_no ?? '',
      tradeNo: payload.trade_no ?? 'MOCK_TRADE_NO',
      totalAmountFen: Math.round(parseFloat(payload.total_amount ?? '0') * 100),
      tradeStatus: payload.trade_status ?? 'TRADE_SUCCESS',
    };
  }
  async queryOrder(_orderNo: string): Promise<{ status: string; tradeNo?: string }> {
    return { status: 'pending' };
  }
  async refund({ outRequestNo }: { outTradeNo: string; amountFen: number; outRequestNo: string; reason?: string }): Promise<RefundResult> {
    // 幂等：同 outRequestNo 重复调用直接返回 ok
    this._refundedIds.add(outRequestNo);
    return { ok: true, raw: { mock: true, outRequestNo } };
  }
}
