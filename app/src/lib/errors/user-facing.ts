// app/src/lib/errors/user-facing.ts
// API 边界的异常转换层：内部异常 → 服务端日志（原文完整）+ 对外的「稳定错误码 + 用户可读文案」。
//
// 为什么必须有这一层：两条出口都直接对着不该看到内部实现的人——
//   · /api/v1/verify/:orderNo/recheck 公开无鉴权，拿到订单号的任何人（含仲裁对方）都能打；
//   · /api/v1/cases/:id/chat 的 error 帧会渲染成当事人屏幕上的报错卡。
// 而内部异常的 message 里带着服务器绝对路径（files.readBytes 的 `enc_path=...`）、
// 环境变量名（llm/router 的 `DEEPSEEK_API_KEY(...)`）这类东西：对使用者一点用没有，
// 对外人却是一份免费的服务器地形图。
//
// ⚠ 这一层只换**说法**，不换**结论**。调用方该判 passed:false 的仍判 passed:false，
// 该发 error 帧的仍发 error 帧。lib/evidence 那条「宁可暴露也不吞结论」的原意
// 完整保留在**日志侧**：原始 message 与 stack 一个字不改地进 console.error，
// 排障看服务端日志，不看用户的屏幕。
//
// 新增错误码时把文案写进 USER_FACING_COPY，别在调用点就地拼字符串——
// 就地拼是这个 bug 本来的形态（两条链各拼各的，各漏各的）。

/**
 * 对外文案表。每条都按自述三段式写：**缺什么 / 为什么缺 / 怎么办**。
 * 硬约束：这里不许出现文件路径、环境变量名、上游 URL、异常原文、内部标识符——
 * 它们的去处是 console.error。
 */
export const USER_FACING_COPY = {
  /** verify 页：按 file_id 取原件复算哈希时抛错（文件缺失、密文被改、解密失败） */
  EVIDENCE_READ_FAILED:
    '有一项核验没能完成：服务端读取原件时出错。这不影响其余各项的结论，可稍后点「重新核验」；多次失败请联系我们。',
  /** verify 页：取《存证证明》PDF 时抛错，时间戳与签名两项都无从验起 */
  CERT_PDF_READ_FAILED:
    '有核验项没能完成：服务端读取《存证证明》文件时出错。这不影响「哈希一致」一项的结论，可稍后点「重新核验」；多次失败请联系我们。',
  /** verify 页：sidecar 自陈未就绪（证书 / 信任锚没配好），HTTP 503 */
  RECHECK_UNAVAILABLE:
    '在线核验暂时用不了：我们这边的复核服务还没就绪，不是这份材料有问题。稍后再点一次「在线核验」，或按页面下方的指引自己离线复核。',
  /**
   * verify 页：sidecar **回了 200 裁决**，但裁决里自带失败说明
   * （verdict.error / verdict.signatures[].error）。那两处是裸 Python 异常原文
   * （sidecar/verify_evidence_pdf.py 里 `f"...: {e}"` 直接拼），带服务器绝对路径与异常内部态。
   * ⚠ 这条与 RECHECK_* 两条不同：它**不是**「没验成」，裁决确实回来了，
   * 结论仍是这一项没过；换掉的只是那句话怎么说。
   */
  SIGNATURE_VERDICT_ERROR:
    '《存证证明》数字签名未通过校验：复核服务给出的具体原因是内部诊断信息，不便展示在这里（服务端已完整记下）。它未必是这份材料的问题，也可能是我们这边的验签环境没配好。可稍后点「重新核验」再试一次；多次如此请把订单号报给我们。',
  /** verify 页：sidecar 没响应或回了非预期状态，HTTP 502 */
  RECHECK_UPSTREAM_FAILED:
    '这次没核成：复核服务没有响应，不是核验没通过。过一会儿再点一次「在线核验」，或按页面下方的指引自己离线复核。',
  /** 问它页：一轮对话在流已开之后抛错（模型连不上、非 2xx、流内错误、缺 key） */
  AGENT_FAILED:
    '这一轮没能生成回答：模型服务这会儿连不上。稍等一下点「重试」；如果一直不行，把下面的错误码报给我们——这条报错我们服务端已经记下了，不用你复述。',
} as const;

export type UserFacingCode = keyof typeof USER_FACING_COPY;

export interface UserFacingError {
  /** 稳定错误码，留给前端做分支；本身不含内部实现信息 */
  code: UserFacingCode;
  /** 自述三段式中文；不含路径、env 名、上游地址、异常原文 */
  message: string;
}

/**
 * 把一个内部异常翻译成能过边界的东西。
 *
 * @param err 原始异常，原样进日志
 * @param ctx.code 对外错误码，同时决定对外文案
 * @param ctx.where 出错位置（如 'recheck.checkHash'），只进日志，用来定位是哪条链断的
 */
export function toUserFacingError(
  err: unknown,
  ctx: { code: UserFacingCode; where: string },
): UserFacingError {
  console.error(`[边界] ${ctx.where} → ${ctx.code}`, {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return { code: ctx.code, message: USER_FACING_COPY[ctx.code] };
}
