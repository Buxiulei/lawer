// app/src/lib/dossier/build.ts
// 库里的档案下挂表 → DossierView（呈现契约见 ./contract，文字版见 docs/contracts/dossier-api.md）。
//
// 【这一层唯一的纪律：不编造】同 lib/graph/build.ts。没算过的统计给 null，不给一份全 0 的快照；
// 没有的采集时点给 null，由呈现层的三件套守卫拦在数字之前。**这里补出来的每一个"合理默认值"，
// 到了界面上都会变成一个看起来完全正常、其实没人算过的数字。**
//
// 【本文件是服务端专用】它 import 了 lib/company/*（运行时会拖进 better-sqlite3）
// 与 lib/knowledge（读文件系统），客户端组件一律只 import ./contract 的类型。
import type { Database } from 'better-sqlite3';

import { BLOCK_NAMES, listBlocks, type BlockName } from '@/lib/company/blocks';
import { queuePosition, type DossierRow } from '@/lib/company/dossier';
import { RELAY_SOURCE } from '@/lib/company/ingest';
import { listPatterns } from '@/lib/company/patterns';
import {
  DEFAULT_MIN_SAMPLE_DURATION,
  DEFAULT_MIN_SAMPLE_OUTCOME,
  readStats,
  type StatsSnapshotRow,
} from '@/lib/company/stats';
import { readConfigInt } from '@/lib/billing/pricing-config';
import type { CompanyProfileRow } from '@/lib/db/company-graph';

import type {
  BlockState,
  DossierBlock,
  DossierPattern,
  DossierView,
  DurationSegment,
  DurationSegmentKey,
  OutcomeStats,
  PatternEvidence,
} from './contract';
import { venueSection } from './venue';

/**
 * 本案的被申请人主体：**签约主体优先，其次用工主体**，同档按 id 取最早的一条。
 *
 * 【为什么不是"第一条 company_profiles"】一案可挂多个主体，`关联` 那些是查出来的
 * 上下游与平行公司（migrate.ts 169-181）。按插入顺序取，很可能取到一家与劳动者
 * 没有合同关系的关联公司——然后整页档案讲的是另一家公司的判例。
 *
 * 【为什么 `关联` 一律不取】仲裁列谁为被申请人由角色判定，而 `关联` 这个角色的含义
 * 恰恰是"不是它"。取不到宁可当作还没确定被申请人（页面走引导态），
 * 也不拿一家关联公司顶上：顶上的那份档案看起来完全正常，用户无从分辨。
 */
const RESPONDENT_ROLES = ['签约主体', '用工主体'] as const;

export function pickRespondent(profiles: readonly CompanyProfileRow[]): CompanyProfileRow | null {
  for (const role of RESPONDENT_ROLES) {
    const hit = profiles
      .filter((p) => p.role === role && p.name.trim() !== '')
      .sort((a, b) => a.id - b.id)[0];
    if (hit) return hit;
  }
  return null;
}

/**
 * 案件的 district（默认「朝阳」）→ 仲裁地名。
 *
 * 【误差方向】认不出来就落到「未覆盖」，界面只出那一句、不出任何风格描述。
 * 反过来（把一个没逐字核实过的辖区认成朝阳）会让用户照着别处的流程去准备材料、算时间。
 * 首发只做北京朝阳，见 ./venue 的 COVERED_VENUES。
 */
export function venueOfDistrict(district: string): string {
  return `北京${district.trim()}`;
}

/**
 * 块状态三态照 migrate.ts：无行=从没排过；有行 finished_at 为空=在跑（或崩了）；
 * 其余按 status 落到有结论的那几档。
 *
 * `expired` 只由档案本身的 `litigation_expired` 状态给，且只落在判例块上——
 * 它与 failed 的区别是**带着退款**，而退款这件事的事实源在档案状态与账本，不在块表。
 */
function blockStateOf(
  row: { status: string; finished_at: string | null } | undefined,
  block: BlockName,
  dossierStatus: string,
): BlockState {
  if (dossierStatus === 'litigation_expired' && block === 'litigation') return 'expired';
  if (!row) return 'queued';
  if (row.finished_at === null) return 'running';
  if (row.status === 'ok') return 'done';
  if (row.status === 'failed') return 'failed';
  if (row.status === 'skipped') return 'skipped';
  // 认不出的值当作"没有结论"而不是当作成功：往严重方向错。
  return 'running';
}

function blocksOf(db: Database, dossier: DossierRow): DossierBlock[] {
  const rows = new Map(listBlocks(db, dossier.id).map((r) => [r.block, r]));
  return BLOCK_NAMES.map((block) => {
    const row = rows.get(block);
    return {
      block,
      state: blockStateOf(row, block, dossier.status),
      startedAt: row?.started_at ?? null,
      finishedAt: row?.finished_at ?? null,
      // 失败原因原样转给用户，不改写、不省略（写它的人已经按三段式写好了）
      errorText: row?.error_text ?? null,
    };
  });
}

function outcomeOf(snap: StatsSnapshotRow, minSample: number): OutcomeStats {
  return {
    docsTotal: snap.docs_total,
    docsFulltext: snap.docs_fulltext,
    docsOutcomeDecided: snap.docs_outcome_decided,
    workerFavorableN: snap.worker_favorable_n,
    minSample,
    byApplicant: {
      worker: snap.applicant_labor_n,
      employer: snap.applicant_employer_n,
      /*
       * 第三档是减出来的，不另存一列：存两处迟早对不上，而对不上时没有任何一处会报错。
       *
       * 【减的是入档全集，不是可判定那一批】库里的 `applicant_labor_n /
       * applicant_employer_n` 是 computeStats 在**全部入档行**上数的（lib/company/stats
       * 的 `rows.filter(r => r.applicant_side === …)`），所以第三档只能相对 `docs_total`
       * 才对得上；卡上那句话也照这个口径写「已入档的 {docsTotal} 篇里……」。
       * 三个数相对同一个分母，屏幕上才不是一道加不起来的算术题。
       *
       * 【为什么不再 clamp】两个 applicant_side 取值互斥、又都在同一批行上各数一次，
       * 所以 X + Y ≤ docs_total 是数法本身保证的，这个减法天然非负。
       * 原先那个 `Math.max(0, docs_outcome_decided − X − Y)` 兜的是"拿可判定篇数当分母"
       * 留下的负数——它兜住了数字的样子，兜不住那句话的错，反而把
       * 「X+Y+Z ≠ 分母」这件唯一看得见的症状抹平了。
       */
      unknown: snap.docs_total - snap.applicant_labor_n - snap.applicant_employer_n,
    },
    // 比率卡的样本量**是它自己的分母**，不是全档案条目数
    sampleN: snap.docs_outcome_decided,
    asOf: snap.as_of,
    source: snap.as_of === null ? null : RELAY_SOURCE,
  };
}

/** 四段各自独立：各带各的 n 与中位数，一段不足不牵连其它段。**没有也不许有"平均时长"。** */
const SEGMENT_COLUMNS: ReadonlyArray<
  [DurationSegmentKey, keyof StatsSnapshotRow, keyof StatsSnapshotRow]
> = [
  ['arbitration', 'arb_n', 'arb_median_days'],
  ['firstInstance', 'trial1_n', 'trial1_median_days'],
  ['secondInstance', 'trial2_n', 'trial2_median_days'],
  ['execution', 'exec_n', 'exec_median_days'],
];

function segmentsOf(snap: StatsSnapshotRow): DurationSegment[] {
  return SEGMENT_COLUMNS.map(([key, nCol, medianCol]) => {
    const n = snap[nCol] as number;
    return {
      key,
      n,
      medianDays: (snap[medianCol] as number | null) ?? null,
      sampleN: n,
      asOf: snap.as_of,
      source: snap.as_of === null ? null : RELAY_SOURCE,
    };
  });
}

function patternsOf(db: Database, dossierId: number): DossierPattern[] {
  return listPatterns(db, dossierId)
    .map((row) => {
      let evidence: PatternEvidence[] = [];
      try {
        const parsed: unknown = JSON.parse(row.evidence_json);
        if (Array.isArray(parsed)) {
          evidence = (parsed as Array<{ case_no?: unknown; quote?: unknown }>)
            .filter((e) => typeof e?.case_no === 'string' && typeof e?.quote === 'string')
            .map((e) => ({
              caseNo: e.case_no as string,
              quote: e.quote as string,
              // 文书链接不在 evidence_json 里（落库的证据只有案号与逐字引文）。
              // 按案号回查 company_litigation 拼一个链接出来是**另一件事**：
              // 同案号可能有多行，拼错的链接会指向另一篇判决，而它看起来完全正常。
              docUrl: null,
            }));
        }
      } catch {
        // 坏 JSON ⇒ 这条没有证据 ⇒ 下面整条丢掉。不猜、不修补：
        // 修补出来的证据没有任何人核过。
      }
      return {
        id: String(row.id),
        pattern: row.pattern,
        evidence,
        model: row.model ?? '',
        generatedAt: row.generated_at,
      };
    })
    .filter((p) => p.evidence.length > 0);
}

/**
 * 组一份档案的呈现视图。
 *
 * @param refundedGongdao 本用户在这份档案上已被退回的公道值合计（事实源在账本，
 *        由调用方从计费视图取）。0 ⇒ 不出退款那一节。
 */
export function buildDossierView(
  db: Database,
  input: { dossier: DossierRow; venue: string; refundedGongdao: number },
): DossierView {
  const { dossier, venue, refundedGongdao } = input;
  const snap = readStats(db, dossier.id);
  const blocks = blocksOf(db, dossier);

  return {
    id: String(dossier.id),
    companyName: dossier.name,
    blocks,
    // 位次只在还排着队的时候有意义。跑起来之后报一个"第 3 位"是句假话。
    queuePosition: dossier.status === 'queued' ? queuePosition(db, dossier.id) : null,
    // 统计还没算过 ⇒ null（不是一份全 0 的快照）：界面据此出「等它跑完」，不出数字。
    outcome: snap
      ? outcomeOf(snap, readConfigInt(db, 'dossier.min_sample_outcome', DEFAULT_MIN_SAMPLE_OUTCOME))
      : null,
    duration: snap
      ? {
          minSample: readConfigInt(
            db,
            'dossier.min_sample_duration',
            DEFAULT_MIN_SAMPLE_DURATION,
          ),
          segments: segmentsOf(snap),
        }
      : null,
    patterns: patternsOf(db, dossier.id),
    droppedPatterns: snap?.dropped_patterns ?? 0,
    venue: venueSection(venue),
    // 覆盖度声明由统计层写好落库。还没算过就是还没有这句话——不拿一句通用话术顶上。
    coverageNote: snap?.coverage_note ?? '',
    // 在职年限是用户在别处填的、只用于判例排序的输入，档案侧没有它的事实源。
    // 给 null ⇒ 界面连那句免责声明都不出（出一句"你填的年限不参与计算"，
    // 而用户根本没在这条路径上填过年限，只会让他去找那个不存在的输入框）。
    tenureYears: null,
    // 【退款事由没有落库】refund.ts 只把 reason 回给巡检 job 去写通知，库里留下的是
    // 账本上那笔退款流水与档案状态。所以这里只说得出两种：超期（档案状态说得出来）
    // 与"未达交付门槛"（其余三条退款路径 sample_insufficient / graph_low_confidence /
    // patterns_insufficient 的共同说法）。要说得更细，得先给退款事由一个事实源。
    refund:
      refundedGongdao > 0
        ? {
            refunded: true,
            reason:
              dossier.status === 'litigation_expired'
                ? '文书取证超过承诺期限仍未交付'
                : '有模块未达交付门槛',
            amountGongdao: refundedGongdao,
          }
        : null,
    // 谱系块给不给点，看**块表**而不是档案总状态：档案整体还在跑的时候，
    // 谱系可能早就交付了（graph_done 之后还有判例、统计、套路三块要跑）。
    graphReady: blocks.find((b) => b.block === 'graph')?.state === 'done',
  };
}
