// app/src/lib/knowledge/__tests__/grounding-pending.ts
//
// 扎根守卫的显式豁免（`knowledge/packs/<包>/GROUNDING_PENDING`）在 TS 判据这一侧的读法。
//
// 【为什么 TS 侧也要读它】python 那三把尺子（gen / verify-quotes / pytest）管的是"生成这份
// index.json 的那一次"；TS 这几条判据管的是**仓库里现在躺着的那份 index.json**
// （有人手改、别的分支带来、拿 --no-strict 生成后提交）。两侧盯的是同一条纪律，
// 就必须认同一个豁免——只在一侧认的形态是：CI 里 python 全绿、vitest 全红，
// 而两边说的其实是同一件事。
//
// 【为什么不把这个口径再抄一遍在每个判据文件里】抄第二遍的那天，两处会在到期日上分叉：
// 一处认为豁免还在、一处认为已经过期。这里是 TS 侧读它的唯一入口。
import fs from 'node:fs';
import path from 'node:path';

/** 豁免标记文件名（与 scripts/knowledge_sources.py 的 GROUNDING_PENDING 同名同义） */
export const GROUNDING_PENDING = 'GROUNDING_PENDING';

/** 文件里那行到期日：`最迟: 2026-09-14` */
const UNTIL = /^[ \t]*(?:最迟|until)[ \t]*[:：][ \t]*(\d{4}-\d{2}-\d{2})[ \t]*$/m;

/**
 * 判「今天」用的时区。python 侧是 `date.today()`——**服务器本地日期**，
 * 而这套东西的服务器与写豁免的人都在 UTC+8。
 *
 * 【为什么不能用 toISOString()】那是 UTC 日期。2026-09-14T00:30+08:00 这一刻，
 * UTC 还是 09-13：python 说「到期了」（今天 09-14 > 最迟 09-13），
 * TS 说「还没到期」（今天 09-13 不大于 09-13）。于是 CI 里 pytest 红、vitest 绿，
 * 两边说的其实是同一件事，而每天有八小时窗口它们必然不一致。
 * 不一致的方向还特别差：TS 那侧偏向"豁免还在"，也就是偏向少报。
 */
const PENDING_TZ = 'Asia/Shanghai';

/** 固定时区的 `YYYY-MM-DD`（en-CA 恰好就是这个排法，不用自己拼）。 */
const DATE_IN_TZ = new Intl.DateTimeFormat('en-CA', {
  timeZone: PENDING_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * 那一刻在 {@link PENDING_TZ} 的日历日期。导出是为了让判据钉边界
 *（`2026-09-14T00:30+08:00` 这类跨 UTC 日界的时刻）。
 */
export function localDateStamp(at: Date): string {
  return DATE_IN_TZ.format(at);
}

export interface Pending {
  /** 相对 knowledge/ 的目录，如 `packs/counseling`，一律用 `/` 分隔 */
  dir: string;
  /** 到期日 `YYYY-MM-DD` */
  until: string;
  /** 到期日已过（到期即恢复全部守卫，与 python 侧 expired_pending 同口径） */
  expired: boolean;
}

/**
 * 扫出 knowledge/packs 下所有豁免目录。
 *
 * 没写到期日一律抛错：一份**不会到期的豁免**与"这批卡不受任何标准约束"是同一件事，
 * 而它看起来只是一句临时说明。
 */
export function loadPending(knowledgeDir: string, today = new Date()): Pending[] {
  const out: Pending[] = [];
  // 与 python 侧 date.today() 同口径：本地（Asia/Shanghai）日历日，不是 UTC 日
  const stamp = localDateStamp(today);
  const walk = (rel: string) => {
    const abs = path.join(knowledgeDir, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) {
        walk(`${rel}/${e.name}`);
      } else if (e.name === GROUNDING_PENDING) {
        const text = fs.readFileSync(path.join(abs, e.name), 'utf8');
        const m = UNTIL.exec(text);
        if (!m) {
          throw new Error(
            `${rel}/${GROUNDING_PENDING} 没写到期日：文件里必须有一行「最迟: YYYY-MM-DD」。` +
              '一份没有到期日的豁免等于把这批卡永久移出扎根守卫，而它看起来只是一句说明。',
          );
        }
        out.push({ dir: rel, until: m[1], expired: m[1] < stamp });
      }
    }
  };
  walk('packs');
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * 这张卡（index.json 里的 `path`）落在哪个**未过期**的豁免目录下；不在任何一个下面返回 null。
 *
 * 认的是目录段，不是字符串前缀：`packs/counseling` 的豁免罩不到 `packs/counseling-x/`。
 */
export function pendingFor(cardPath: string, pending: Pending[]): string | null {
  const parts = String(cardPath).split(/[\\/]/);
  for (const p of pending) {
    if (p.expired) continue;
    const dp = p.dir.split('/');
    if (parts.slice(0, dp.length).join('/') === dp.join('/')) return p.dir;
  }
  return null;
}
