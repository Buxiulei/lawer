// app/src/lib/auth/sms-errors.ts
// 把 lib/notify/sms.ts 抛上来的错误分类成 (HTTP status, error_code, 用户可读提示)。
// 移植自 NBDpsy auth_sms.rs::classify_sms_error。
//
// 约束与 NBDpsy 相同：sms.ts 只把阿里云的 Message 透传上来、不带原始 Code，
// 所以只能靠 Message 关键词做模式匹配，命中任何一条即返回。
// 存在的意义：阿里云的业务限流（isv.BUSINESS_LIMIT_CONTROL）如果被当成 500，
// 前端会引导用户「稍后重试」，而正确的提示是「今日该号码已达上限，换号或明天再来」。
// 参考 https://help.aliyun.com/document_detail/101346.html

export interface ClassifiedSmsError {
  status: number;
  errorCode: string;
  message: string;
}

export function classifySmsError(err: unknown): ClassifiedSmsError {
  const text = err instanceof Error ? err.message : String(err);

  // 配置缺失：本地就能发现，属于我们自己的锅
  if (text.includes('阿里云短信凭证未配置')) {
    return { status: 500, errorCode: 'SMS_CONFIG_ERROR', message: '短信服务配置错误，请联系客服' };
  }
  // isv.BUSINESS_LIMIT_CONTROL — 号码/IP/分钟级/天级流控
  if (text.includes('流控') || text.includes('BUSINESS_LIMIT_CONTROL')) {
    return {
      status: 429,
      errorCode: 'SMS_RATE_LIMITED',
      message: '该号码今日发送已达上限，请明日再试或使用其他手机号',
    };
  }
  // isv.MOBILE_NUMBER_ILLEGAL — 手机号非法
  if (
    text.includes('号码格式错误') ||
    text.includes('MOBILE_NUMBER_ILLEGAL') ||
    text.includes('非国内手机号') ||
    text.includes('无效的手机号')
  ) {
    return { status: 400, errorCode: 'INVALID_PHONE', message: '手机号格式不正确' };
  }
  // isv.OUT_OF_SERVICE — 业务停机
  if (text.includes('业务停机') || text.includes('OUT_OF_SERVICE')) {
    return { status: 503, errorCode: 'SMS_SERVICE_DOWN', message: '短信服务暂时不可用，请稍后重试' };
  }
  // isv.AMOUNT_NOT_ENOUGH — 账户欠费
  if (text.includes('账户余额不足') || text.includes('AMOUNT_NOT_ENOUGH')) {
    return { status: 503, errorCode: 'SMS_BALANCE_LOW', message: '短信服务异常，请联系客服' };
  }
  // isv.SMS_SIGNATURE_SCENE_ILLEGAL / isv.SMS_TEMPLATE_ILLEGAL — 签名/模板违规
  if (
    text.includes('签名') ||
    text.includes('模板') ||
    text.includes('SIGNATURE_SCENE_ILLEGAL') ||
    text.includes('TEMPLATE_ILLEGAL')
  ) {
    return { status: 500, errorCode: 'SMS_CONFIG_ERROR', message: '短信服务配置错误，请联系客服' };
  }
  // 兜底按 502 而非 500：反映「上游短信服务」故障而不是我们的进程崩了
  return { status: 502, errorCode: 'SMS_UPSTREAM_ERROR', message: '短信发送失败，请稍后重试' };
}
