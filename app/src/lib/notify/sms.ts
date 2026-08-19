// app/src/lib/notify/sms.ts
// 阿里云 dysmsapi RPC 裸客户端，整块移植自 /home/roots/六爻/app/src/lib/auth/sms.ts（spec §3.3 抄优于写）。
// 本文件只负责「把一条短信发出去」：验证码的生成、限流、入库、比对都在 lib/auth，不要往这里塞业务。
import { createHmac, randomUUID } from 'node:crypto';
import { smsVerifyTemplateParam } from './copy';

const SMS_ENDPOINT = 'https://dysmsapi.aliyuncs.com/';

/** 供测试注入的 fetch，签名与全局 fetch 一致 */
export type FetchImpl = typeof fetch;

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

interface AliyunCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
}

function getCredentials(): AliyunCredentials {
  const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET;
  const signName = process.env.SMS_SIGN_NAME;
  const templateCode = process.env.SMS_TEMPLATE_VERIFY_CODE;
  if (!accessKeyId || !accessKeySecret || !signName || !templateCode) {
    throw new Error('阿里云短信凭证未配置');
  }
  return { accessKeyId, accessKeySecret, signName };
}

/**
 * 校验中国大陆手机号：取出所有数字，去掉可选的前缀 86，
 * 要求剩余正好 11 位且首位是 1、第二位 3..9。
 */
export function isMainlandPhone(phone: string): boolean {
  const trimmed = (phone ?? '').trim();
  // 带国际前缀时只认 +86：如 "+1 415 555 0100" 去符号后是 14155550100，
  // 恰为 11 位且 1[3-9] 开头，会被下面的正则误放行（与 lib/auth/phone.ts 同口径修复）
  if (trimmed.startsWith('+') && !/^\+\s*86/.test(trimmed)) {
    return false;
  }
  let digits = trimmed.replace(/\D/g, '');
  if (digits.startsWith('86')) {
    digits = digits.slice(2);
  }
  return /^1[3-9]\d{9}$/.test(digits);
}

/**
 * 生成当前 UTC 时间戳，格式 YYYY-MM-DDTHH:mm:ssZ。
 */
function utcTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 调用阿里云短信发送 OTP。
 * 失败（响应 Code !== "OK"，或网络/凭证异常）抛 Error。
 */
async function sendSms(
  phone: string,
  templateCode: string,
  templateParam: string,
  fetchImpl: FetchImpl,
): Promise<void> {
  const { accessKeyId, accessKeySecret, signName } = getCredentials();

  const params: Record<string, string> = {
    AccessKeyId: accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    RegionId: process.env.ALIYUN_REGION ?? 'cn-hangzhou',
    SignName: signName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomUUID(),
    SignatureVersion: '1.0',
    TemplateCode: templateCode,
    TemplateParam: templateParam,
    Timestamp: utcTimestamp(),
    Version: '2017-05-25',
  };

  // 按 key 字典序排序，拼成 "key=percentEncode(value)" 用 & 连接
  const sortedKeys = Object.keys(params).sort();
  const canonicalized = sortedKeys
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');

  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonicalized)}`;

  const signature = createHmac('sha1', `${accessKeySecret}&`)
    .update(stringToSign)
    .digest('base64');

  const url = `${SMS_ENDPOINT}?${canonicalized}&Signature=${percentEncode(signature)}`;

  const res = await fetchImpl(url, { method: 'GET' });
  const data = (await res.json()) as { Code?: string; Message?: string };

  if (data.Code !== 'OK') {
    throw new Error(data.Message ?? '短信发送失败');
  }
}

/**
 * 发送验证码短信（中国大陆手机号）。
 * @param phone     手机号
 * @param code      6 位验证码
 * @param fetchImpl 测试注入用，默认走全局 fetch
 */
export async function sendOtp(
  phone: string,
  code: string,
  fetchImpl: FetchImpl = fetch,
): Promise<void> {
  if (!isMainlandPhone(phone)) {
    throw new Error('无效的手机号');
  }
  const templateCode = process.env.SMS_TEMPLATE_VERIFY_CODE;
  if (!templateCode) {
    throw new Error('阿里云短信凭证未配置');
  }
  await sendSms(phone, templateCode, smsVerifyTemplateParam(code), fetchImpl);
}
