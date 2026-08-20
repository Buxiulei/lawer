// 公开验证页的状态判定单测。
// 这里守的是一条红线：**任何读不出完整记录的情况都必须落到 unavailable**，
// 绝不能因为"接口没报错"就把状态抬成 record。
import { describe, expect, test } from 'vitest';

import {
  readRecheck,
  readRecheckVerdict,
  readVerification,
  statusLabel,
} from '../_verification';

/** 一条已盖时间戳的真实响应（形状照 lib/evidence.PublicVerification） */
function stampedBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    verification: {
      order_no: 'LAWER-ATT-20260820-1c99e1b9767f65b5',
      status: 'certified',
      sha256: '7c30ca5f3f7bf9d66180d2beef8c0b1777181edb2c7559600e85b827c07312bf',
      created_at: '2026-08-20 03:24:52',
      evidence: { name: '解除通知书.txt', category: '公司文件', mime: 'text/plain', file_size: 103 },
      timestamp: {
        gen_time: '2026-08-20T03:24:56.000Z',
        serial: 'A1B2C3D4',
        tsa_url: 'http://fake-tsa.local/tsa',
        tst_b64: 'ZmFrZQ==',
      },
      ...overrides,
    },
  };
}

describe('readVerification', () => {
  test('已盖时间戳 → record，字段原样带出', () => {
    const view = readVerification(stampedBody());
    expect(view.state).toBe('record');
    expect(view.verification?.order_no).toBe('LAWER-ATT-20260820-1c99e1b9767f65b5');
    expect(view.verification?.evidence?.name).toBe('解除通知书.txt');
    expect(view.verification?.timestamp.serial).toBe('A1B2C3D4');
  });

  test('status=stamped 也是 record', () => {
    expect(readVerification(stampedBody({ status: 'stamped' })).state).toBe('record');
  });

  test('status=pending → pending，记录仍带出供展示', () => {
    const view = readVerification(
      stampedBody({
        status: 'pending',
        timestamp: { gen_time: null, serial: null, tsa_url: null, tst_b64: null },
      }),
    );
    expect(view.state).toBe('pending');
    expect(view.verification?.sha256).toHaveLength(64);
  });

  test('status 说 certified 但没有 gen_time → 仍是 pending，不许抬成 record', () => {
    const view = readVerification(
      stampedBody({
        timestamp: { gen_time: null, serial: null, tsa_url: null, tst_b64: null },
      }),
    );
    expect(view.state).toBe('pending');
  });

  test('未知 status 按最保守的 pending 处理', () => {
    expect(readVerification(stampedBody({ status: 'whatever-new-value' })).state).toBe('pending');
  });

  test('ok:false（ORDER_NOT_FOUND）→ unavailable', () => {
    const view = readVerification({
      ok: false,
      error_code: 'ORDER_NOT_FOUND',
      message: '存证订单不存在',
    });
    expect(view).toEqual({ state: 'unavailable', verification: null });
  });

  test.each([
    ['null（解析失败）', null],
    ['undefined', undefined],
    ['字符串', 'boom'],
    ['缺 ok 字段', { verification: { order_no: 'X', sha256: 'Y' } }],
    ['verification 不是对象', { ok: true, verification: 'nope' }],
    ['缺 order_no', { ok: true, verification: { sha256: 'Y' } }],
    ['缺 sha256', { ok: true, verification: { order_no: 'X' } }],
  ])('%s → unavailable', (_label, body) => {
    expect(readVerification(body).state).toBe('unavailable');
  });

  test('evidence 为 null（证据已删）仍算 record，不因此降级', () => {
    const view = readVerification(stampedBody({ evidence: null }));
    expect(view.state).toBe('record');
    expect(view.verification?.evidence).toBeNull();
  });
});

describe('statusLabel', () => {
  test.each([
    ['certified', '已出证'],
    ['stamped', '已固化'],
    ['pending', '存证处理中'],
    ['unknown-value', '存证处理中'],
  ])('%s → %s', (status, label) => {
    expect(statusLabel(status)).toBe(label);
  });
});

describe('readRecheckVerdict', () => {
  test('只有布尔 true 才是 pass', () => {
    expect(readRecheckVerdict({ overall_ok: true })).toBe('pass');
    expect(readRecheckVerdict({ overall_ok: false })).toBe('fail');
  });

  test.each([
    ['缺字段', {}],
    ['字符串 "true"', { overall_ok: 'true' }],
    ['数字 1', { overall_ok: 1 }],
    ['null 响应体', null],
  ])('%s → unknown，绝不当成通过', (_label, body) => {
    expect(readRecheckVerdict(body)).toBe('unknown');
  });
});

describe('readRecheck 的分项宽松解析', () => {
  test('数组 + {key,label,ok,detail} 标准形状', () => {
    const r = readRecheck({
      overall_ok: true,
      checks: [
        { key: 'hash_match', label: '文件哈希一致', ok: true, detail: '逐位相同' },
        { key: 'tst_valid', label: '时间戳令牌有效', ok: true, detail: null },
      ],
    });
    expect(r.verdict).toBe('pass');
    expect(r.checks).toHaveLength(2);
    expect(r.checks[0]).toEqual({
      key: 'hash_match',
      label: '文件哈希一致',
      ok: true,
      detail: '逐位相同',
    });
  });

  test('数组 + {name,passed,message} 这类别名字段照样认', () => {
    const r = readRecheck({
      overall_ok: false,
      checks: [{ name: 'signature_valid', passed: false, message: '签名证书已吊销' }],
    });
    expect(r.verdict).toBe('fail');
    expect(r.checks[0].label).toBe('签名有效');
    expect(r.checks[0].ok).toBe(false);
    expect(r.checks[0].detail).toBe('签名证书已吊销');
  });

  test('对象映射 { hash_match: true } 形状', () => {
    const r = readRecheck({ overall_ok: false, checks: { hash_match: false, tst_valid: true } });
    expect(r.checks).toEqual([
      { key: 'hash_match', label: '文件哈希一致', ok: false, detail: null },
      { key: 'tst_valid', label: '时间戳令牌有效', ok: true, detail: null },
    ]);
  });

  test('认不出的分项原样列出，不吞掉', () => {
    const r = readRecheck({
      overall_ok: true,
      checks: [{ key: 'brand_new_check', ok: true }, { key: 'ltv_present', ok: false }],
    });
    expect(r.checks.map((c) => c.label)).toEqual(['brand_new_check', 'ltv_present']);
  });

  test('分项没有布尔结论 → ok 为 null（不算过也不算不过）', () => {
    const r = readRecheck({ overall_ok: true, checks: [{ key: 'hash_match', detail: '超时' }] });
    expect(r.checks[0].ok).toBeNull();
  });

  test.each([
    ['checks 缺失', { overall_ok: true }],
    ['checks 是字符串', { overall_ok: true, checks: 'nope' }],
    ['响应体是 null', null],
  ])('%s → checks 为空数组，不炸', (_label, body) => {
    expect(readRecheck(body).checks).toEqual([]);
  });

  test('分项全 true 但 overall_ok 缺失 → 仍是 unknown（分项不参与裁决）', () => {
    const r = readRecheck({ checks: [{ key: 'hash_match', ok: true }] });
    expect(r.verdict).toBe('unknown');
    expect(r.checks[0].ok).toBe(true);
  });
});
