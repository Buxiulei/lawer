// app/src/lib/crypto/__tests__/index.test.ts
// 加密是实名信息的最后一道墙：回环、篡改检测、查找摘要确定性、密钥校验四条都不能松。
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';

const KEY_B64 = crypto.randomBytes(32).toString('base64');

/** 模块内缓存了主密钥，改 env 的用例必须重新加载模块 */
async function loadWithKey(key?: string) {
  vi.resetModules();
  if (key === undefined) delete process.env.LAWER_DATA_KEY;
  else process.env.LAWER_DATA_KEY = key;
  return import('../index');
}

beforeEach(() => {
  process.env.LAWER_DATA_KEY = KEY_B64;
});

afterEach(() => {
  vi.resetModules();
});

describe('encryptField / decryptField', () => {
  test('回环：中文、空串、长文本都能原样解回', async () => {
    const { encryptField, decryptField } = await loadWithKey(KEY_B64);
    for (const plain of ['13800138000', '张三', '', '北京市朝阳区'.repeat(500)]) {
      expect(decryptField(encryptField(plain))).toBe(plain);
    }
  });

  test('密文自包含且带 v1 前缀', async () => {
    const { encryptField } = await loadWithKey(KEY_B64);
    const token = encryptField('13800138000');
    expect(token.startsWith('v1:')).toBe(true);
    // iv(12) + 明文 11 字节 + tag(16) = 39 字节
    expect(Buffer.from(token.slice(3), 'base64')).toHaveLength(39);
  });

  test('同一明文两次加密密文不同（iv 随机）', async () => {
    const { encryptField, decryptField } = await loadWithKey(KEY_B64);
    const a = encryptField('13800138000');
    const b = encryptField('13800138000');
    expect(a).not.toBe(b);
    expect(decryptField(b)).toBe('13800138000');
  });

  test('篡改密文体 → 认证失败抛错', async () => {
    const { encryptField, decryptField } = await loadWithKey(KEY_B64);
    const payload = Buffer.from(encryptField('13800138000').slice(3), 'base64');
    payload[20] ^= 0xff;
    expect(() => decryptField(`v1:${payload.toString('base64')}`)).toThrow(/认证失败/);
  });

  test('篡改认证标签 → 抛错', async () => {
    const { encryptField, decryptField } = await loadWithKey(KEY_B64);
    const payload = Buffer.from(encryptField('13800138000').slice(3), 'base64');
    payload[payload.length - 1] ^= 0xff;
    expect(() => decryptField(`v1:${payload.toString('base64')}`)).toThrow(/认证失败/);
  });

  test('换密钥解不开旧密文', async () => {
    const { encryptField } = await loadWithKey(KEY_B64);
    const token = encryptField('13800138000');
    const other = await loadWithKey(crypto.randomBytes(32).toString('base64'));
    expect(() => other.decryptField(token)).toThrow(/认证失败/);
  });

  test('前缀缺失或版本不符 → 抛格式错', async () => {
    const { encryptField, decryptField } = await loadWithKey(KEY_B64);
    const token = encryptField('13800138000');
    expect(() => decryptField(token.slice(3))).toThrow(/格式无法识别/);
    expect(() => decryptField(`v2:${token.slice(3)}`)).toThrow(/格式无法识别/);
  });

  test('长度不足（丢了 iv 或 tag）→ 抛长度错', async () => {
    const { decryptField } = await loadWithKey(KEY_B64);
    expect(() => decryptField(`v1:${crypto.randomBytes(20).toString('base64')}`)).toThrow(/长度不足/);
  });
});

describe('hashLookup', () => {
  test('确定性：同一明文恒等，可作 UNIQUE 查找列', async () => {
    const { hashLookup } = await loadWithKey(KEY_B64);
    expect(hashLookup('13800138000')).toBe(hashLookup('13800138000'));
    expect(hashLookup('13800138000')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('不同明文摘要不同', async () => {
    const { hashLookup } = await loadWithKey(KEY_B64);
    expect(hashLookup('13800138000')).not.toBe(hashLookup('13800138001'));
  });

  test('查找密钥由 HKDF 派生，不等于直接用主钥做 HMAC', async () => {
    const { hashLookup } = await loadWithKey(KEY_B64);
    const naive = crypto.createHmac('sha256', Buffer.from(KEY_B64, 'base64'))
      .update('13800138000', 'utf-8').digest('hex');
    expect(hashLookup('13800138000')).not.toBe(naive);
  });

  test('换主密钥摘要随之改变', async () => {
    const { hashLookup } = await loadWithKey(KEY_B64);
    const mine = hashLookup('13800138000');
    const other = await loadWithKey(crypto.randomBytes(32).toString('base64'));
    expect(other.hashLookup('13800138000')).not.toBe(mine);
  });
});

describe('LAWER_DATA_KEY 校验', () => {
  test('缺失 → 抛明确错误，不静默降级', async () => {
    const { encryptField, hashLookup } = await loadWithKey(undefined);
    expect(() => encryptField('x')).toThrow(/缺少 env LAWER_DATA_KEY/);
    expect(() => hashLookup('x')).toThrow(/缺少 env LAWER_DATA_KEY/);
  });

  test('长度不足 32 字节 → 抛错', async () => {
    const { encryptField } = await loadWithKey(crypto.randomBytes(16).toString('base64'));
    expect(() => encryptField('x')).toThrow(/长度错误/);
  });

  test('hex 形式与等值 base64 形式等效', async () => {
    const key = crypto.randomBytes(32);
    const hexMod = await loadWithKey(key.toString('hex'));
    const token = hexMod.encryptField('13800138000');
    const hexHash = hexMod.hashLookup('13800138000');
    const b64Mod = await loadWithKey(key.toString('base64'));
    expect(b64Mod.decryptField(token)).toBe('13800138000');
    expect(b64Mod.hashLookup('13800138000')).toBe(hexHash);
  });
});
