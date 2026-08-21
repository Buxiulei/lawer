// app/src/lib/notify/aliyun-rpc.ts
// 阿里云 RPC 风格 API 的请求签名。短信（dysmsapi）与实人认证（cloudauth）走的是同一套协议，
// 区别只有 endpoint、Version、摘要算法（SHA1 / SHA256）与业务参数，故签名这段抽在这里共用。
//
// 签错的表现是线上一发就 SignatureDoesNotMatch，本地不复算就只能在生产上试——
// 调用方的单测必须独立复算一遍签名（见 __tests__/sms.test.ts 的手法）。
import { createHmac, randomUUID } from 'node:crypto';

/** 供测试注入的 fetch，签名与全局 fetch 一致 */
export type FetchImpl = typeof fetch;

export type SignatureMethod = 'HMAC-SHA1' | 'HMAC-SHA256';

/**
 * 阿里云 RPC 风格 percentEncode。
 * 未保留字符 A-Za-z0-9-_.~ 原样保留；其余按 UTF-8 字节编码为 %XX（大写十六进制）；
 * 空格须为 %20（encodeURIComponent 会编为 %20，无需额外处理 +）。
 */
function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

/** 公共参数 Timestamp 的格式：UTC，YYYY-MM-DDTHH:mm:ssZ（阿里云自有格式，与 ADR-002 的库内格式无关） */
function utcTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 拼出带 Signature 的完整 GET URL。
 * 公共参数（AccessKeyId / Format / SignatureMethod / SignatureNonce / SignatureVersion / Timestamp）
 * 由本函数补齐，调用方只传 Action、Version 与业务参数。
 *
 * @param endpoint 不带结尾斜杠，如 https://dysmsapi.aliyuncs.com
 */
export function buildSignedRpcUrl(input: {
  endpoint: string;
  accessKeyId: string;
  accessKeySecret: string;
  signatureMethod: SignatureMethod;
  params: Record<string, string>;
}): string {
  const params: Record<string, string> = {
    AccessKeyId: input.accessKeyId,
    Format: 'JSON',
    SignatureMethod: input.signatureMethod,
    SignatureNonce: randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: utcTimestamp(),
    ...input.params,
  };

  // 按 key 字典序排序，拼成 "key=percentEncode(value)" 用 & 连接
  const canonicalized = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');

  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonicalized)}`;
  const algo = input.signatureMethod === 'HMAC-SHA256' ? 'sha256' : 'sha1';
  const signature = createHmac(algo, `${input.accessKeySecret}&`)
    .update(stringToSign)
    .digest('base64');

  return `${input.endpoint}/?${canonicalized}&Signature=${percentEncode(signature)}`;
}
