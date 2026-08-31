// app/src/lib/company/ingest.ts
// 外勤取证产物（JSONL）→ company_litigation 的导入面。
//
// 【形态前提，别按别的形态设计】采集器跑在外勤工作站，不跑在服务器：
// 接力脚本的前置探活要真人在场过验证码，工商查询走住宅代理，采集状态是本地文件。
// ⇒ **app 侧永远没有「去抓文书」这个动作**，只有「外勤开窗产出 JSONL → 导入 → 入库」。
// 任何「T+X 小时出全档」的承诺在这个形态下都是假的。
//
// 【字段契约】JSONL 的中文键**照外勤现有格式原样收**，映射写在这一侧
// （docs/contracts/dossier-ingest.md）。不去改外勤的输出格式：那是另一个人的工具链，
// 改它意味着每次它升级我们都要跟着改，而映射放在导入侧只需要改一处。
//
// 【本文件最重要的一条：不推断】判决日期、立案日期、结果、程序位置、判付金额——
// 现有 JSONL 里没有的就是 NULL，**不从年份推日期、不从检索式推案由、不从标题推结果**。
// 推断出来的值会以一个精确的样子落库，读的人无从分辨它其实是猜的；
// 而这些字段正是统计层用来算比率和时长的那几个。宁可样本不足退款，不可拿猜的数出结论。
import type { Database } from 'better-sqlite3';

/** 入库来源标签，与统计卡上的 `source` 同一个串（改这里就是改用户看到的出处）。 */
export const RELAY_SOURCE = '裁判文书网·人机接力取证';

/** 结果三值。NULL ≠ 输了，NULL = 判不出来。 */
export const OUTCOMES = [
  '劳动者全部获支持',
  '劳动者部分获支持',
  '劳动者未获支持',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** 程序位置四段，与统计层的四段时长一一对应。 */
export const STAGES = ['仲裁', '一审', '二审', '执行'] as const;
export type Stage = (typeof STAGES)[number];

/** 谁把谁告上去的。与 outcome 分开看：「公司赢了」和「劳动者输了」不是同一件事。 */
export const APPLICANT_SIDES = ['劳动者', '单位'] as const;
export type ApplicantSide = (typeof APPLICANT_SIDES)[number];

/** 外勤 JSONL 的一行。必填只有案号；其余键缺了就是缺了，导入侧不补。 */
export interface RelayDoc {
  案号: string;
  审理机关?: string;
  程序?: string;
  标题?: string;
  案由?: string;
  裁判主文_逐字摘录?: string;
  原文获取状态?: string;
  主体归属?: string;
  /** 以下为契约里声明的**可选扩展键**：外勤取到全文并逐字读过之后才会有 */
  立案日期?: string;
  裁判日期?: string;
  结果?: string;
  结果依据_逐字?: string;
  申请人方?: string;
  判付金额_分?: number;
  全文文件路径?: string;
  [k: string]: unknown;
}

/** 外勤的「程序」字段 → 我们的四段。表里没有的值一律 NULL，不猜。 */
const STAGE_MAP: Record<string, Stage> = {
  民事一审: '一审',
  民事二审: '二审',
  一审: '一审',
  二审: '二审',
  仲裁: '仲裁',
  执行: '执行',
  // 民事再审刻意不映射：再审不是上面四段中的任何一段，硬塞进「二审」会污染二审时长样本
};

/** 全文取到没有。未知值一律按 0（保守方向：宁可少喂给模型，也不把没核实的东西当全文）。 */
const FULLTEXT_YES = '已取全文';

export interface IngestReport {
  /** JSONL 里读到几行 */
  total: number;
  /** 真正新增几行（据 INSERT OR IGNORE 的 changes 判定，不是「尝试了几行」） */
  inserted: number;
  /** 已存在、被唯一键挡下的行数 */
  duplicated: number;
  /** 主体归属未命中、按契约跳过的行数 */
  skippedNotSubject: number;
  /** 缺必填字段被拒的行：{ line, reason }，reason 写清缺什么/为什么/怎么办 */
  rejected: { line: number; reason: string }[];
  /** 值不认识但没到拒收程度的（如未知的原文获取状态）——必须报出来，不许静默兜底 */
  warnings: string[];
}

/**
 * 导入一批外勤产物。
 *
 * @param dossierId        档案 id（统计按它聚合）
 * @param companyProfileId 案件维度的主体 id。**为什么必填**：company_litigation.company_profile_id
 *   是 NOT NULL 的既有列，改成可空要重建表——卡在「迁移框架无事务」那笔债上。
 *   去重靠 uq_company_litigation_dossier（dossier_id, case_no）这条档案维度的唯一键兜住，
 *   所以同一份 JSONL 挂在同一档案的不同 profile 下重复导入也不会翻倍。
 * @param fetchedAt        本批的采集时点（ISO 串）。**必填、不取 now()**：
 *   统计卡的 as_of 是「数据截止到哪天」，拿导入那一刻冒充采集时点，
 *   会把一份三个月前的旧数据显示成今天的。
 *
 * 幂等：同一批重复导入，inserted=0、库里行数不变（A7）。
 */
export function ingestDocs(
  db: Database,
  input: {
    dossierId: number;
    companyProfileId: number;
    rows: RelayDoc[];
    fetchedAt: string;
    source?: string;
  },
): IngestReport {
  const report: IngestReport = {
    total: input.rows.length,
    inserted: 0,
    duplicated: 0,
    skippedNotSubject: 0,
    rejected: [],
    warnings: [],
  };
  const source = input.source ?? RELAY_SOURCE;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO company_litigation
       (company_profile_id, dossier_id, case_no, court, judged_at, cause, is_labor, role,
        doc_url, summary, source, fetched_at,
        has_fulltext, fulltext_path, outcome, outcome_basis, filed_at, stage,
        applicant_side, amount_awarded_fen)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  const unknownFetchStates = new Set<string>();
  const unknownOutcomes = new Set<string>();

  input.rows.forEach((row, i) => {
    const line = i + 1;
    const caseNo = (row.案号 ?? '').trim();
    if (!caseNo) {
      report.rejected.push({
        line,
        reason:
          '缺「案号」。案号是这条判例在库里的唯一标识，没有它就无法去重、' +
          '也无法在套路归纳时逐条核验证据。请让外勤补齐该行的案号后重新导出这一行。',
      });
      return;
    }

    // 主体归属：外勤已经把「命中/未命中」判过了，这一侧只执行，不重判。
    // 未命中的行**不入库**——把疑同名公司的判例混进档案，比少几条严重得多。
    const belong = (row.主体归属 ?? '').trim();
    if (belong && !belong.startsWith('命中')) {
      report.skippedNotSubject += 1;
      return;
    }

    const fetchState = (row.原文获取状态 ?? '').trim();
    let hasFulltext = 0;
    if (fetchState === FULLTEXT_YES) hasFulltext = 1;
    else if (fetchState && !fetchState.startsWith('仅列表项')) unknownFetchStates.add(fetchState);

    const excerpt = (row.裁判主文_逐字摘录 ?? '').trim();
    // has_fulltext=1 却没有逐字摘录：这行进不了归纳白名单也没法核验引文，降回 0 并报出来。
    if (hasFulltext === 1 && !excerpt) {
      hasFulltext = 0;
      report.warnings.push(
        `第 ${line} 行（${caseNo}）标为「${FULLTEXT_YES}」但「裁判主文_逐字摘录」是空的：` +
          '没有逐字原文就无法逐条核验模型引文，已按「未取全文」入档（不进归纳白名单）。',
      );
    }

    const outcomeRaw = (row.结果 ?? '').trim();
    let outcome: string | null = null;
    if (outcomeRaw) {
      if ((OUTCOMES as readonly string[]).includes(outcomeRaw)) outcome = outcomeRaw;
      else unknownOutcomes.add(outcomeRaw);
    }

    const sideRaw = (row.申请人方 ?? '').trim();
    const applicantSide = (APPLICANT_SIDES as readonly string[]).includes(sideRaw)
      ? sideRaw
      : null;

    const cause = (row.案由 ?? '').trim() || null;
    const info = stmt.run(
      input.companyProfileId,
      input.dossierId,
      caseNo,
      (row.审理机关 ?? '').trim() || null,
      (row.裁判日期 ?? '').trim() || null, // 只收文书上载明的日期；年份不是日期，不拿它顶
      cause,
      cause?.includes('劳动争议') ? 1 : 0,
      null, // role：现有 JSONL 判不出原告/被告，留空
      null, // doc_url：同上
      excerpt || null,
      source,
      input.fetchedAt,
      hasFulltext,
      (row.全文文件路径 ?? '').trim() || null,
      outcome,
      (row.结果依据_逐字 ?? '').trim() || null,
      (row.立案日期 ?? '').trim() || null,
      STAGE_MAP[(row.程序 ?? '').trim()] ?? null,
      applicantSide,
      typeof row.判付金额_分 === 'number' && Number.isInteger(row.判付金额_分)
        ? row.判付金额_分
        : null,
    );
    if (info.changes === 1) report.inserted += 1;
    else report.duplicated += 1;
  });

  for (const s of unknownFetchStates) {
    report.warnings.push(
      `不认识的「原文获取状态」取值：${s}。已按「未取全文」入档（保守方向：` +
        '不把没核实的东西当全文喂给模型）。若外勤新增了状态值，请同步 docs/contracts/dossier-ingest.md。',
    );
  }
  for (const s of unknownOutcomes) {
    report.warnings.push(
      `不认识的「结果」取值：${s}。已按「判不出来」入档（outcome=NULL），不计入比率分母。` +
        `合法取值只有 ${OUTCOMES.join(' / ')} 三个；` +
        '若外勤改了口径，请同步 docs/contracts/dossier-ingest.md 后重导。',
    );
  }
  return report;
}

/** 解析 JSONL 文本。坏行不静默跳过——报到 rejected 里，由调用方决定要不要继续。 */
export function parseJsonl(text: string): { rows: RelayDoc[]; bad: { line: number; reason: string }[] } {
  const rows: RelayDoc[] = [];
  const bad: { line: number; reason: string }[] = [];
  text.split('\n').forEach((raw, i) => {
    const s = raw.trim();
    if (!s) return;
    try {
      rows.push(JSON.parse(s) as RelayDoc);
    } catch (e) {
      bad.push({
        line: i + 1,
        reason:
          `第 ${i + 1} 行不是合法 JSON（${(e as Error).message}）：` +
          'JSONL 要求每行一个独立 JSON 对象，多半是导出时换行被截断了。' +
          '请让外勤重导这一行，或手工修好该行后重跑。',
      });
    }
  });
  return { rows, bad };
}
