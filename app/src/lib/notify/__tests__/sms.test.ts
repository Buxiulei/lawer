// app/src/lib/notify/__tests__/sms.test.ts
// 阿里云 RPC 签名算错的表现是「线上一发就 SignatureDoesNotMatch」，本地不测出来就只能在生产上试。
// 全程注入假 fetch，绝不真发短信。
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createHmac } from 'node:crypto';

import { isMainlandPhone, sendOtp } from '../sms';

const SECRET = 'test-access-key-secret';

/** 假 fetch：记录被请求的 URL，返回阿里云成功响应 */
function okFetch() {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ Code: 'OK', Message: 'OK' }));
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

beforeEach(() => {
  process.env.ALIYUN_ACCESS_KEY_ID = 'test-access-key-id';
  process.env.ALIYUN_ACCESS_KEY_SECRET = SECRET;
  process.env.SMS_SIGN_NAME = '测试签名';
  process.env.SMS_TEMPLATE_VERIFY_CODE = 'SMS_123456789';
  delete process.env.ALIYUN_REGION;
});

describe('sendOtp', () => {
  test('请求参数齐备，且 Signature 能按阿里云规则独立复算出来', async () => {
    const { impl, calls } = okFetch();
    await sendOtp('13800138000', '123456', impl);

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]);
    const params = url.searchParams;
    expect(params.get('Action')).toBe('SendSms');
    expect(params.get('PhoneNumbers')).toBe('13800138000');
    expect(params.get('SignName')).toBe('测试签名');
    expect(params.get('TemplateCode')).toBe('SMS_123456789');
    expect(params.get('TemplateParam')).toBe(JSON.stringify({ code: '123456' }));
    expect(params.get('SignatureMethod')).toBe('HMAC-SHA1');
    expect(params.get('Version')).toBe('2017-05-25');
    expect(params.get('RegionId')).toBe('cn-hangzhou');

    // 独立复算签名：去掉 Signature 后按 key 字典序重拼 canonicalized string
    const encode = (v: string) =>
      encodeURIComponent(v).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
    const given = params.get('Signature')!;
    params.delete('Signature');
    const canonicalized = [...params.keys()]
      .sort()
      .map((k) => `${encode(k)}=${encode(params.get(k)!)}`)
      .join('&');
    const expected = createHmac('sha1', `${SECRET}&`)
      .update(`GET&${encode('/')}&${encode(canonicalized)}`)
      .digest('base64');
    expect(given).toBe(expected);
  });

  test('ALIYUN_REGION 可覆盖默认 region', async () => {
    process.env.ALIYUN_REGION = 'cn-beijing';
    const { impl, calls } = okFetch();
    await sendOtp('13800138000', '123456', impl);
    expect(new URL(calls[0]).searchParams.get('RegionId')).toBe('cn-beijing');
  });

  test('阿里云返回 Code !== OK 时抛出其 Message，供上层做业务分类', async () => {
    const impl = vi.fn(async () =>
      new Response(JSON.stringify({ Code: 'isv.BUSINESS_LIMIT_CONTROL', Message: '触发天级流控' })),
    ) as unknown as typeof fetch;
    await expect(sendOtp('13800138000', '123456', impl)).rejects.toThrow('触发天级流控');
  });

  test('非大陆手机号与缺凭证都在发请求之前就拦下', async () => {
    const { impl, calls } = okFetch();
    await expect(sendOtp('12345', '123456', impl)).rejects.toThrow('无效的手机号');

    delete process.env.SMS_SIGN_NAME;
    await expect(sendOtp('13800138000', '123456', impl)).rejects.toThrow('阿里云短信凭证未配置');
    expect(calls).toHaveLength(0);
  });
});

describe('isMainlandPhone', () => {
  test('接受带 86 前缀与分隔符的写法，拒绝非大陆号', () => {
    expect(isMainlandPhone('13800138000')).toBe(true);
    expect(isMainlandPhone('+86 138 0013 8000')).toBe(true);
    expect(isMainlandPhone('12800138000')).toBe(false);
    expect(isMainlandPhone('')).toBe(false);
  });
});
