// app/src/lib/auth/phone.ts
// 手机号归一化。lib/crypto 的 hashLookup 明确「归一化由调用方负责」，
// 所以入库、查表、限流三处用的必须是同一个归一化产物，否则同一个人会落出两个 phone_hash。
// 规范形式 = 11 位纯数字，不带 +86、不带分隔符。

/**
 * 归一化中国大陆手机号：抽出所有数字，去掉可选的 86 前缀，
 * 要求剩余正好 11 位且首位 1、第二位 3..9。不合规返回 null。
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  // 带 + 的国际写法只认 +86。否则 "+1 415 555 0100" 去掉符号后是 14155550100，
  // 11 位、1 开头、第二位 4，正好落进下面的大陆号正则被放行。
  if (trimmed.startsWith('+') && !/^\+\s*86/.test(trimmed)) {
    return null;
  }
  let digits = trimmed.replace(/\D/g, '');
  if (digits.startsWith('86')) {
    digits = digits.slice(2);
  }
  return /^1[3-9]\d{9}$/.test(digits) ? digits : null;
}

/** 日志脱敏：保留前 3 后 4。任何日志里都不许出现完整手机号。 */
export function maskPhone(phone: string): string {
  return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : '***';
}
