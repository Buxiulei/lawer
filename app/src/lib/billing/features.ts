// app/src/lib/billing/features.ts
// 用量「功能键 → 中文标签」单一事实源。
// token_usage.feature / gongdao_ledger.feature 里出现的每一个键都须在此登记；
// 用量明细一律经 featureLabel() 取标签，未登记键回退「其他」，绝不把英文内部键直接露给用户。
// 新增计费功能（recordTokenUsage/gongdaoSettle 传入新 feature）时，务必在此补一条中文标签——
// features.test.ts 断言「全部已登记键均为纯中文标签」以防再漏。

/** 全部已知 feature 键 → 中文标签。键须与各 job 里 recordTokenUsage/gongdaoSettle 实际传入者一致。 */
export const FEATURE_LABELS: Record<string, string> = {
  intake: '问诊',
  companion: '陪跑',
  draft: '文书起草',
  ocr: '文件解读',
  asr: '录音分析',
  attest: '证据固化',
  export: '材料导出',
  knowledge: '知识检索',
  companywatch: '公司动态监控', // 守望订阅：按 tier 月度扣费（daily 199 / weekly 60 / archive 0），见 lib/company/watch-billing
  contract_review: '合同审查',  // critical 档计费，费率待 M3 核定
  // 公司档案六模块（拆包按模块计价；价目在 pricing_config，报价流按探测篇数展开 M5/M6）：
  dossier_venue: '仲裁地实操',       // M1 定额 0（信任锚）
  dossier_entity: '主体体检',        // M2 定额
  dossier_graph: '关联谱系',         // M3 定额（高置信边不足自动退款）
  dossier_docs_list: '涉诉清单',     // M4 定额
  dossier_docs_stats: '涉诉深度统计', // M5 每篇（样本不足/超期自动退款）
  // M6 规格里叫「HR 套路归纳」，标签取纯中文写法：本表的每个标签都会直接印在用户的用量明细上，
  // features.test 因此断言「全部标签不含拉丁字母」——那条守卫拦的是「内部英文键漏成标签」，
  // 为一个产品叫法把它放宽，等于把这类漏出的唯一机检口子拆了。改叫法只需改这一行与
  // company/dossier-billing.ts 的 DOSSIER_MODULE_LABEL（两处同名同物，别只改一处）。
  dossier_patterns: '人事套路归纳',  // M6 起价+每篇（保留条目不足自动退款）
};

/**
 * threads.mode → feature 键。**记账侧与回填脚本共用这一份**：
 * 两处各写一份映射，就会出现「实时记 intake、回填记 companion」这种同一轮两个功能名的账。
 */
export const FEATURE_BY_THREAD_MODE: Record<string, string> = {
  问诊: 'intake',
  陪跑: 'companion',
  文书: 'draft',
  录音分析: 'asr',
};

/** 取模式对应的 feature 键；未知模式回落「陪跑」（长期对话的常态，不会把账记到定额端点上）。 */
export function featureOfMode(mode: string): string {
  return FEATURE_BY_THREAD_MODE[mode] ?? 'companion';
}

/** 未登记键的兜底标签（不再直出英文原始键）。 */
export const UNKNOWN_FEATURE_LABEL = '其他';

/** 取功能中文标签；未登记键统一回退「其他」。 */
export function featureLabel(feature: string): string {
  return FEATURE_LABELS[feature] ?? UNKNOWN_FEATURE_LABEL;
}

/** 全部已登记键（供遍历/测试断言用）。 */
export const KNOWN_FEATURE_KEYS = Object.keys(FEATURE_LABELS);
