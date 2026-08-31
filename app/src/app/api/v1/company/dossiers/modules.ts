// app/src/app/api/v1/company/dossiers/modules.ts
// 请求体里 modules / doc_count 字段的**唯一解析入口**。报价与确认两条路由共用——
// 两处各写一份解析，就会出现「报价按四项算、确认只买了三项」这种收错钱的偏差，且两边各自看着都对。
import { DOSSIER_MODULES, type DossierModule } from '@/lib/company/dossier-billing';

/**
 * 解析 modules 入参。
 * @returns 省略/为 null → 全部模块；合法非空数组 → 该数组；含未知值/类型不对/空数组 → null（调用方回 400）。
 *   **不做「过滤掉未知值」这种宽容处理**：`['graph','graphs']` 被过滤成 `['graph']` 后，
 *   用户会看到一个他没选的价，且没有任何一处会报错。省略即全部模块。
 */
export function parseModules(raw: unknown): DossierModule[] | null {
  if (raw === undefined || raw === null) return [...DOSSIER_MODULES];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const known = new Set<string>(DOSSIER_MODULES);
  if (!raw.every((m) => typeof m === 'string' && known.has(m))) return null;
  return raw as DossierModule[];
}

/**
 * 解析 doc_count 入参（有公开文书链接的可计费篇数，M5/M6 计价用）。
 * @returns 省略/为 null → 0；非负整数 → 该值；负数/非整数/类型不对 → null（调用方回 400）。
 *   不静默 clamp：一个负的篇数意味着前端算错了，宁可报错也不按 0 蒙混报一个用户没预期的价。
 */
export function parseDocCount(raw: unknown): number | null {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return null;
  return raw;
}
