// app/src/lib/evidence/categories.ts
// spec §7 evidence.category 枚举的**唯一定义处**。
//
// 【为什么单独一个叶子文件】它同时被两侧要：`lib/evidence/index.ts`（上传校验，那条路带着
// better-sqlite3/fetch/fs 一串依赖）与 `lib/agent/case-facts.ts`（事实卡按类别报数，那边是
// 不许碰 IO 的纯函数）。放在 index 里就得让纯函数去 import 一整条 IO 链；各写一份则会出现
// 「上传认 8 类、事实卡数 7 类」这种谁也发现不了的偏差。本文件零依赖，两边都能安全引。
export const EVIDENCE_CATEGORIES = [
  '合同',
  '工资',
  '社保',
  '考勤',
  '沟通记录',
  '公司文件',
  '录音',
  '其他',
] as const;
