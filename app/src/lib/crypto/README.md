# src/lib/crypto — 字段级加密

敏感字段落库前在这里加解密（spec §10）。数据库 `*_enc` 列存 `encryptField` 的产出串，
`*_hash` 查找列存 `hashLookup` 的产出。除本模块外任何地方不得直接碰 `LAWER_DATA_KEY`。

## 接口

```ts
import { encryptField, decryptField, hashLookup } from '@/lib/crypto';

encryptField(plaintext: string): string   // → "v1:<base64>"
decryptField(token: string): string       // 前缀/长度/认证标签任一不符则 throw
hashLookup(value: string): string         // → 64 字符小写 hex，确定性
encryptBuffer(plaintext: Buffer): Buffer  // 整文件加密 → 裸二进制（证据原件落盘用）
decryptBuffer(blob: Buffer): Buffer       // magic/长度/认证标签任一不符则 throw
```

三个函数都是同步的，首次调用时读取并校验 env 主密钥（之后进程内缓存）。

## env

```
LAWER_DATA_KEY=<32 字节，hex(64 字符) 或 base64>
```

生成：`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`

- 缺失 → 抛 `缺少 env LAWER_DATA_KEY: …`；长度不对 → 抛 `env LAWER_DATA_KEY 长度错误: …`。
  **不做静默降级**，配置错了就让进程炸在第一次加解密上。
- 密钥一旦轮换，既有 `*_enc` 全部解不开、`*_hash` 全部对不上（等于丢库）。请长期固定并异地备份。
  本模块不实现多密钥轮换，需要时另立 ADR。

## 密文格式

```
v1:base64( iv(12B) || ciphertext || tag(16B) )
```

AES-256-GCM，密钥即主密钥，iv 每次随机。自包含，解密不需要任何额外元数据。
密文长度 ≈ `ceil((28 + utf8字节数) / 3) * 4 + 3` 字符，建库时列类型用 `TEXT` 即可。

整文件密文（`encryptBuffer`，证据原件落盘）走**裸二进制**，不做 base64：

```
magic("LWR1") || iv(12B) || ciphertext || tag(16B)
```

同为 AES-256-GCM 同一主密钥，只是外壳不同。证据原件可达数十 MB，base64 会让体积涨
三分之一且必须整串驻留内存，故不复用字段密文那套。magic 头使「是不是本系统的密文文件」
读头 4 字节即可判定。定长开销 44 字节。

## 查找列为什么另走 HMAC

iv 随机 → 同一手机号每次密文都不同 → `phone_enc` 无法做等值查询和 UNIQUE 约束。
所以按明文反查走 `phone_hash = hashLookup(phone)`：

```ts
const row = db.prepare('SELECT * FROM users WHERE phone_hash = ?').get(hashLookup(phone));
```

HMAC 密钥用 HKDF-SHA256 从主密钥派生（`info = "lawer-lookup-v1"`，salt 空），
不直接复用加密主钥——查找摘要泄漏不应削弱密文。

**归一化由调用方负责**：`hashLookup` 原样吃入参，不做 trim/去分隔符/大小写折叠。
手机号、身份证号等在调用前先统一成规范形式，否则同一个人会落出两个 hash。
