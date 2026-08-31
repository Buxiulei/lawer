// app/src/lib/company/stats.ts
// 档案统计层。**纯 SQL 聚合 + 纯算术，零 LLM**：这一块的每个数都必须能从库里逐行数回来。
//
// ─────────────── 这个文件在防什么 ───────────────
// 「劳动者胜诉比例」这个指标，按现有语料算出来会骗人，三条实证都来自已落盘的外勤产物：
//  1. **分母是幸存者**。2021 年起裁判文书上网率大幅下降，企查类站点全在登录墙后；
//     外勤自己的涉诉目录写着「仅为本次免登录公开检索能触达的极小部分」。
//     偏差方向未知 ⇒ 不可用一个百分数把它盖住。
//  2. **方向会反**。实测某系公司 2022-09 单日 8 件的批量案，特征是**用人单位起诉员工**。
//     此时「公司赢了」与「劳动者输了」不是同一件事——不区分程序位置的胜诉率是错的数。
//  3. **分子多数取不到**。JSONL 实测绝大多数行是「仅列表项_未取全文」，没有全文就没有结果。
//
// ⇒ 本文件的三条硬规则（每条都有测试盯着，改坏会红）：
//   A. 比率的分母**只能是 docs_outcome_decided**（结果可判定的篇数），不是 docs_total。
//      指标名不叫「胜诉率」，叫「劳动者全部或部分获支持的比例」，且同屏并列申请人方分布。
//   B. 样本不足时**整块不出数字**——返回值里连 `worker_favorable_ratio` 这个键都没有。
//      不是给 0、不是给 null：一个存在的键会被下游当成「有这个数」。
//   C. 四段时长**各自独立样本量、各自独立门槛**，且**没有「平均时长」那一格**。
//      一段不足不牵连其它段；合成一个总均值只会得到一个谁也没经历过的时长。
import type { Database } from 'better-sqlite3';

import { readConfigInt } from '../billing/pricing-config';

import { RELAY_SOURCE } from './ingest';

/** 四段等待各自独立，顺序即流程顺序。**这里没有、也不许有第五项「平均/总时长」。** */
export const DURATION_SEGMENTS = [
  '仲裁受理→裁决',
  '一审立案→判决',
  '二审立案→判决',
  '判决生效→执行立案',
] as const;
export type SegmentName = (typeof DURATION_SEGMENTS)[number];

/** company_litigation.stage → 段名。stage 为空的行不进任何一段（不猜它属于哪段）。 */
const STAGE_TO_SEGMENT: Record<string, SegmentName> = {
  仲裁: '仲裁受理→裁决',
  一审: '一审立案→判决',
  二审: '二审立案→判决',
  执行: '判决生效→执行立案',
};

/** 默认门槛（表里 dossier.min_sample_* 有行即以表为准，不硬编码在判定处）。 */
export const DEFAULT_MIN_SAMPLE_OUTCOME = 5;
export const DEFAULT_MIN_SAMPLE_DURATION = 5;

export interface DurationCard {
  segment: SegmentName;
  /** 本段可算时长的篇数（两端日期都载明、且非负） */
  n: number;
  /** 仅样本达标时存在。**样本不足时这个键根本不出现**，不是 null */
  median_days?: number;
  /** 仅样本不足时存在，说清「不足」是哪几个数 */
  insufficient_note?: string;
}

export interface DossierStats {
  dossier_id: number;
  /** 全部入档条目（含仅列表项）。**不是比率分母** */
  docs_total: number;
  /** 取到全文的篇数 */
  docs_fulltext: number;
  /** 结果可判定的篇数 = 比率的唯一合法分母 */
  docs_outcome_decided: number;
  /** 其中劳动者全部或部分获支持的篇数 */
  worker_favorable_n: number;
  /** 劳动者提起的件数（程序位置，与胜负是两回事） */
  applicant_labor_n: number;
  /** 单位提起的件数 */
  applicant_employer_n: number;
  /** 劳动者全部或部分获支持的比例（0~1）。**仅样本达标且 as_of 可知时存在** */
  worker_favorable_ratio?: number;
  /** 仅比率不出时存在：一句把三个数都说全的话 */
  insufficient_note?: string;
  /** 四段各一张卡，顺序固定 */
  durations: DurationCard[];
  /** 比率卡的样本量元数据（= docs_outcome_decided） */
  sample_n: number;
  /** 采集截止日 = MAX(fetched_at)。**为 null 时整份统计都不出数字** */
  as_of: string | null;
  /** 出处 */
  source: string;
  /** 覆盖度声明：与统计卡**同屏同级**的结构化字段，不是可折叠脚注 */
  coverage_note: string;
  /** 模型编造率的体温计：被逐条校验丢掉的 pattern 数 */
  dropped_patterns: number;
}

interface DocRow {
  has_fulltext: number;
  outcome: string | null;
  applicant_side: string | null;
  stage: string | null;
  filed_at: string | null;
  judged_at: string | null;
}

/** 偶数样本取中间两个的均值。取整会在小样本上系统性偏移，所以留 REAL。 */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 两个 ISO 日期之间的整天数；任一端缺失或倒序（数据脏）返回 null，不进样本。 */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const d = Math.round((b - a) / 86_400_000);
  return d >= 0 ? d : null;
}

/**
 * 重算一份档案的统计。**不写库**（写库是 saveStats 的事），
 * 这样测试可以只看返回值，也让「算」和「存」各自独立可测。
 */
export function computeStats(db: Database, dossierId: number): DossierStats {
  const rows = db
    .prepare(
      `SELECT has_fulltext, outcome, applicant_side, stage, filed_at, judged_at
         FROM company_litigation WHERE dossier_id = ?`,
    )
    .all(dossierId) as DocRow[];

  const { as_of } = db
    .prepare('SELECT MAX(fetched_at) AS as_of FROM company_litigation WHERE dossier_id = ?')
    .get(dossierId) as { as_of: string | null };

  const { dropped_patterns } = (db
    .prepare('SELECT dropped_patterns FROM company_dossier_stats WHERE dossier_id = ?')
    .get(dossierId) as { dropped_patterns: number } | undefined) ?? { dropped_patterns: 0 };

  const minOutcome = readConfigInt(db, 'dossier.min_sample_outcome', DEFAULT_MIN_SAMPLE_OUTCOME);
  const minDuration = readConfigInt(db, 'dossier.min_sample_duration', DEFAULT_MIN_SAMPLE_DURATION);

  const docsTotal = rows.length;
  const docsFulltext = rows.filter((r) => r.has_fulltext === 1).length;
  const decided = rows.filter((r) => r.outcome !== null && r.outcome !== '');
  const docsDecided = decided.length;
  const favorable = decided.filter(
    (r) => r.outcome === '劳动者全部获支持' || r.outcome === '劳动者部分获支持',
  ).length;
  const applicantLabor = rows.filter((r) => r.applicant_side === '劳动者').length;
  const applicantEmployer = rows.filter((r) => r.applicant_side === '单位').length;

  // 【as_of 缺席即全档不出数字】三个元数据缺一不渲染那条规矩在这里就执行，
  // 不推给渲染层：一个「有数字但说不出数据截止到哪天」的统计，
  // 到了别的调用方（导出、通知、第三方）手里就会被当成新鲜数据用。
  const datable = as_of !== null && as_of !== '';

  const stats: DossierStats = {
    dossier_id: dossierId,
    docs_total: docsTotal,
    docs_fulltext: docsFulltext,
    docs_outcome_decided: docsDecided,
    worker_favorable_n: favorable,
    applicant_labor_n: applicantLabor,
    applicant_employer_n: applicantEmployer,
    durations: DURATION_SEGMENTS.map((segment) => {
      const days = rows
        .filter((r) => r.stage && STAGE_TO_SEGMENT[r.stage] === segment)
        .map((r) => (r.filed_at && r.judged_at ? daysBetween(r.filed_at, r.judged_at) : null))
        .filter((d): d is number => d !== null);
      const card: DurationCard = { segment, n: days.length };
      if (datable && days.length >= minDuration) card.median_days = median(days);
      else {
        card.insufficient_note =
          `样本不足：本段（${segment}）取到两端日期均载明的文书 ${days.length} 篇，` +
          `不足 ${minDuration} 篇不出时长。` +
          (datable ? '' : '（且本档案尚无采集时点，无法说明数据截止到哪天。）');
      }
      return card;
    }),
    sample_n: docsDecided,
    as_of: datable ? as_of : null,
    source: RELAY_SOURCE,
    coverage_note:
      `本档案不构成该公司全部涉诉记录，仅为「${RELAY_SOURCE}」在 ${datable ? as_of : '（采集时点未知）'} ` +
      `之前可公开触达的部分：已入档 ${docsTotal} 条，其中取到全文 ${docsFulltext} 篇、` +
      `可判定结果 ${docsDecided} 篇。2021 年起裁判文书上网率持续下降，未上网的案件本档案看不见，` +
      '偏差方向未知——请把下面的数字当作「已知的这些」，不要当作「全部」。',
    dropped_patterns,
  };

  if (datable && docsDecided >= minOutcome) {
    stats.worker_favorable_ratio = Number((favorable / docsDecided).toFixed(4));
  } else {
    stats.insufficient_note =
      `样本不足：已入档 ${docsTotal} 条，其中取到全文 ${docsFulltext} 篇、` +
      `可判定结果 ${docsDecided} 篇，不足 ${minOutcome} 篇不出比例。` +
      (datable ? '' : '（且本档案尚无采集时点，无法说明数据截止到哪天。）');
  }
  return stats;
}

/** 落快照（一档一行，覆盖式）。dropped_patterns 由 patterns.ts 维护，本函数原样写回不清零。 */
export function saveStats(db: Database, stats: DossierStats): void {
  const seg = (name: SegmentName): DurationCard =>
    stats.durations.find((d) => d.segment === name)!;
  const arb = seg('仲裁受理→裁决');
  const t1 = seg('一审立案→判决');
  const t2 = seg('二审立案→判决');
  const ex = seg('判决生效→执行立案');
  db.prepare(
    `INSERT INTO company_dossier_stats
       (dossier_id, docs_total, docs_fulltext, docs_outcome_decided, worker_favorable_n,
        applicant_labor_n, applicant_employer_n,
        arb_n, arb_median_days, trial1_n, trial1_median_days,
        trial2_n, trial2_median_days, exec_n, exec_median_days,
        as_of, coverage_note, dropped_patterns, computed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
     ON CONFLICT (dossier_id) DO UPDATE SET
       docs_total = excluded.docs_total,
       docs_fulltext = excluded.docs_fulltext,
       docs_outcome_decided = excluded.docs_outcome_decided,
       worker_favorable_n = excluded.worker_favorable_n,
       applicant_labor_n = excluded.applicant_labor_n,
       applicant_employer_n = excluded.applicant_employer_n,
       arb_n = excluded.arb_n, arb_median_days = excluded.arb_median_days,
       trial1_n = excluded.trial1_n, trial1_median_days = excluded.trial1_median_days,
       trial2_n = excluded.trial2_n, trial2_median_days = excluded.trial2_median_days,
       exec_n = excluded.exec_n, exec_median_days = excluded.exec_median_days,
       as_of = excluded.as_of,
       coverage_note = excluded.coverage_note,
       dropped_patterns = excluded.dropped_patterns,
       computed_at = datetime('now')`,
  ).run(
    stats.dossier_id,
    stats.docs_total,
    stats.docs_fulltext,
    stats.docs_outcome_decided,
    stats.worker_favorable_n,
    stats.applicant_labor_n,
    stats.applicant_employer_n,
    arb.n,
    arb.median_days ?? null,
    t1.n,
    t1.median_days ?? null,
    t2.n,
    t2.median_days ?? null,
    ex.n,
    ex.median_days ?? null,
    stats.as_of,
    stats.coverage_note,
    stats.dropped_patterns,
  );
}
