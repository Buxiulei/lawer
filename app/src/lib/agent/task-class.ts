// app/src/lib/agent/task-class.ts
// task_class 判定（spec §8 llm 路由：task_class × 套餐 → 模型）。
//
// 判定错的代价不对称，所以规则是**刻意偏向 critical** 的：
//   判成 critical 而实际不值得 → 多花几分钱；
//   判成 standard 而实际是「签不签这份协议」 → 用户拿一个便宜模型的答案去做不可逆决定。
// 后者是产品事故，前者是成本波动。有疑问时一律往上判。
//
// 纯函数、无 IO：15 个评测剧本的路由档位可以离线逐条断言。

import type { TaskClass } from '@/lib/llm';
import { assessCrisis } from './crisis';

export interface TaskClassInput {
  /** 用户本轮的原话 */
  message: string;
  /** threads.mode：问诊 | 陪跑 | 文书 | 录音分析 */
  mode: string;
}

/**
 * critical 触发词表。四类各自对应 manager 圈定的四种「错了会伤到用户」的判断：
 * 签不签 / 金额 / 期限 / 文书定稿，另加一类危机信号。
 *
 * 用词表而不是让小模型先分类一次：分类调用本身要花时间与钱，而且它判错的方式
 * （把「我明天就把辞职信一交」判成闲聊）恰恰是最致命的那种。词表看得见、可逐条测、可审。
 */
const CRITICAL_PATTERNS: { name: string; re: RegExp }[] = [
  {
    // 签不签 / 不可逆动作（charter §7.2）。含「辞职」「离职」是因为 S07 那类
    // 「明天我就把辞职信一交」——一个字之差把 N 清零，这是全集最重的拦截样本。
    name: '不可逆动作',
    // 「签」一个字就够触发：签字/签收/签不签/要不要签，全都是同一件不可逆的事，
    // 而漏判的代价是用户拿便宜模型的答案去按手印。宁可多判。
    re: /签|确认书|同意书|协议|解除|辞职|离职信|主动离职|接受(方案|条件)|放弃|承诺书|和解/,
  },
  {
    // 解除定性：这次解除算合法(N)还是违法(2N)，是全案金额与策略的分水岭。
    // 用户说「被辞退了」时，接下来 24 小时给的证据固定建议决定他日后拿不拿得出举证，
    // 所以这一类与「金额」同档，不能因为用词口语化就掉到 standard。
    name: '解除定性',
    re: /辞退|开除|裁员|劝退|解雇|被优化|不用来了|不让我去|违法解除|通知书|约谈|谈话/,
  },
  {
    // 金额：诉求金额算错会直接写进仲裁申请书
    name: '金额',
    re: /赔(偿|多少|不赔)|补偿|多少钱|拿多少|金额|工资基数|应发|2N|N\+1|双倍|封顶|社平|计算|算一?下/,
  },
  {
    // 期限：错过即权利灭失（migrate.ts deadlines 注释：全产品最不能出错的地方）
    name: '期限',
    // 「裁决下来 20 天了公司还没给钱」这类话里没有「期限」二字，但它问的正是
    // 15 日起诉期有没有过、能不能申请执行——所以裁决/执行/裸的「N 天」也算这一档。
    re: /时效|期限|截止|过期|几天|多久|多长时间|\d+\s*天|15\s*日|十五日|一年内|届满|逾期|开庭|排期|裁决|生效|强制执行|申请执行|传票|应诉|答辩/,
  },
  {
    // 文书定稿与发出
    name: '文书',
    re: /起草|拟一?份|写(一)?[份封]|文书|申请书|通知书|异议函|答辩状|上诉状|定稿|发给公司|寄出|EMS|送达|提交/,
  },
];

/**
 * 判本轮该用哪一档模型。
 *
 * 注意本函数**永不返回 bulk**：bulk 是分类/摘要/OCR 清洗那类内部小调用的档位
 * （routing.config.ts 注释），面向用户的对话轮里没有便宜到可以走 bulk 的东西。
 */
export function classifyTask(input: TaskClassInput): TaskClass {
  // 文书模式整条线都是定稿路径，逐轮都算 critical，不看用户说了什么
  if (input.mode === '文书') return 'critical';
  // 危机判据复用 lib/agent/crisis 那一层，不在这里另写一份正则：
  // 一处认得出、另一处认不出，是最难查的那种不一致（会表现为「给了危机资源卡，
  // 但这一轮用的是便宜模型」）。
  if (assessCrisis(input.message).triggered) return 'critical';
  if (CRITICAL_PATTERNS.some((p) => p.re.test(input.message))) return 'critical';
  return 'standard';
}

/** 命中了哪些 critical 触发类别（调试与评测断言用；没命中返回空数组） */
export function criticalReasons(input: TaskClassInput): string[] {
  const hit = CRITICAL_PATTERNS.filter((p) => p.re.test(input.message)).map((p) => p.name);
  if (assessCrisis(input.message).triggered) hit.unshift('危机');
  if (input.mode === '文书' && !hit.includes('文书')) hit.unshift('文书');
  return hit;
}
