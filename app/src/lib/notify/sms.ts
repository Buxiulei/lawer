// app/src/lib/notify/sms.ts
// 阿里云 dysmsapi RPC 裸客户端，整块移植自 /home/roots/六爻/app/src/lib/auth/sms.ts（spec §3.3 抄优于写）。
// 本文件只负责「把一条短信发出去」：验证码的生成、限流、入库、比对都在 lib/auth，不要往这里塞业务。
import { buildSignedRpcUrl } from './aliyun-rpc';
import { smsVerifyTemplateParam } from './copy';
import { shouldDryRun } from './dry-run';

const SMS_ENDPOINT = 'https://dysmsapi.aliyuncs.com';

export type { FetchImpl } from './aliyun-rpc';
import type { FetchImpl } from './aliyun-rpc';

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

  const url = buildSignedRpcUrl({
    endpoint: SMS_ENDPOINT,
    accessKeyId,
    accessKeySecret,
    signatureMethod: 'HMAC-SHA1',
    params: {
      Action: 'SendSms',
      PhoneNumbers: phone,
      RegionId: process.env.ALIYUN_REGION ?? 'cn-hangzhou',
      SignName: signName,
      TemplateCode: templateCode,
      TemplateParam: templateParam,
      Version: '2017-05-25',
    },
  });

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
  // 干跑判断放在凭证校验之前：开发机上没配阿里云也要能把注册流程走通
  if (shouldDryRun('短信', phone)) return;
  const templateCode = process.env.SMS_TEMPLATE_VERIFY_CODE;
  if (!templateCode) {
    throw new Error('阿里云短信凭证未配置');
  }
  await sendSms(phone, templateCode, smsVerifyTemplateParam(code), fetchImpl);
}
