// app/src/lib/crypto/index.ts
// 字段级加密（spec §10）：手机号/身份证/实名/认证原始报文等敏感列以 AES-256-GCM 落库，
// 数据库里对应 `*_enc` 列存本文件产出的自包含密文串；`*_hash` 查找列存 hashLookup 的确定性摘要。
// 主密钥只来自 env LAWER_DATA_KEY，绝不入库、绝不静默降级（缺失即启动报错）。
import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = 'v1';
/** 整文件密文的 v1 magic 头（4 字节 ASCII），与字段密文的 "v1:" 前缀同代但格式不同 */
const FILE_MAGIC = Buffer.from('LWR1', 'ascii');
/** HKDF info：查找摘要密钥与加密主钥必须分离，密文泄漏不得反推查找列 */
const LOOKUP_INFO = 'lawer-lookup-v1';

let masterKey: Buffer | null = null;
let lookupKey: Buffer | null = null;

/** 解析 env 主密钥：hex(64 字符) 或 base64，必须解出 32 字节 */
function getMasterKey(): Buffer {
  if (masterKey) return masterKey;
  const raw = process.env.LAWER_DATA_KEY;
  if (!raw) {
    throw new Error('缺少 env LAWER_DATA_KEY：字段级加密主密钥未配置，参见 app/.env.example');
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`env LAWER_DATA_KEY 长度错误：解出 ${key.length} 字节，要求 ${KEY_BYTES} 字节（hex 或 base64）`);
  }
  masterKey = key;
  return key;
}

function getLookupKey(): Buffer {
  if (lookupKey) return lookupKey;
  const derived = crypto.hkdfSync('sha256', getMasterKey(), Buffer.alloc(0), LOOKUP_INFO, KEY_BYTES);
  lookupKey = Buffer.from(derived);
  return lookupKey;
}

/**
 * 主密钥到底配没配好（能不能解出 32 字节）。
 *
 * 【为什么要这么一个探针】「env 没配」与「这条密文坏了」对用户是两件完全不同的事：
 * 前者是**服务端的事**，这把 key 本身没坏、照样能用，等运维配好再来看就行；
 * 后者是**这条记录的事**，明文再也找不回来了，只能轮换。裸抛一个异常出去，
 * 两种情形在页面上长成同一句「出错了」，而用户会为前者去做一次不必要的轮换。
 *
 * 判定逻辑走 getMasterKey 本人，**不在调用方复写一遍 hex/base64 的解析规则**——
 * 复写的那份必然在某次改格式时忘了跟，于是探针说「配好了」而加密照样炸。
 */
export function masterKeyConfigured(): boolean {
  try {
    getMasterKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * 加密单个字段。输出自包含格式 `v1:base64(iv(12B) || ciphertext || tag(16B))`，
 * 可直接整串存进 `*_enc` 列，解密不需要额外元数据。
 */
export function encryptField(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, getMasterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const payload = Buffer.concat([iv, enc, cipher.getAuthTag()]);
  return `${PREFIX}:${payload.toString('base64')}`;
}

/** 解密 encryptField 的产物。前缀/长度/认证标签任一不符即抛错，绝不返回可疑明文。 */
export function decryptField(token: string): string {
  const sep = token.indexOf(':');
  const version = sep < 0 ? '' : token.slice(0, sep);
  if (version !== PREFIX) {
    throw new Error(`密文格式无法识别：期望 "${PREFIX}:" 前缀`);
  }
  const payload = Buffer.from(token.slice(sep + 1), 'base64');
  if (payload.length < IV_BYTES + TAG_BYTES) {
    throw new Error('密文长度不足：缺少 iv 或认证标签');
  }
  const iv = payload.subarray(0, IV_BYTES);
  const enc = payload.subarray(IV_BYTES, payload.length - TAG_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGO, getMasterKey(), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf-8');
  } catch {
    throw new Error('密文认证失败：内容被篡改或密钥不匹配');
  }
}

/**
 * 整文件加密。产出二进制 `magic("LWR1") || iv(12B) || ciphertext || tag(16B)`。
 *
 * 与 encryptField 分开是因为落盘的是证据原件（图片/录音/PDF，可达数十 MB）：
 * base64 会让体积涨三分之一且必须整串驻留内存，故这里走裸二进制、不做 base64。
 * magic 头让「这是不是本系统的密文文件」在读第一个字节时就能判定。
 */
export function encryptBuffer(plaintext: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, getMasterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([FILE_MAGIC, iv, enc, cipher.getAuthTag()]);
}

/** 解密 encryptBuffer 的产物。magic/长度/认证标签任一不符即抛错，绝不返回可疑明文。 */
export function decryptBuffer(blob: Buffer): Buffer {
  if (blob.length < FILE_MAGIC.length + IV_BYTES + TAG_BYTES) {
    throw new Error('密文文件长度不足：缺少 magic、iv 或认证标签');
  }
  if (!blob.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
    throw new Error(`密文文件格式无法识别：期望 "${FILE_MAGIC.toString('ascii')}" magic 头`);
  }
  const iv = blob.subarray(FILE_MAGIC.length, FILE_MAGIC.length + IV_BYTES);
  const enc = blob.subarray(FILE_MAGIC.length + IV_BYTES, blob.length - TAG_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGO, getMasterKey(), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  } catch {
    throw new Error('密文文件认证失败：内容被篡改或密钥不匹配');
  }
}

/**
 * 确定性查找摘要（hex），供 phone_hash 等 UNIQUE 列按明文反查。
 * AES-GCM 每次 iv 随机、密文不可用于等值查询，故查找列另走 HMAC。
 * 调用方负责先做业务归一化（如手机号去空格），本函数不改写入参。
 */
export function hashLookup(value: string): string {
  return crypto.createHmac('sha256', getLookupKey()).update(value, 'utf-8').digest('hex');
}
