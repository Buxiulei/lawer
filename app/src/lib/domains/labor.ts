// app/src/lib/domains/labor.ts
// 劳动争议领域包（设计稿 §13）。本文件是**领域内容**该待的地方：词表、阶段名、
// 文书与期限种类、以及带领域措辞的对外文案，全部只在这里写一次。
import { CASE_STAGES } from '@/lib/cases/stages';

import type { DomainPack } from './registry';

export const LABOR: DomainPack = {
  key: 'labor',
  label: '劳动争议',

  // 阶段枚举**搬过来引用**，不在这里复制第二份：CASE_STAGES 还被首诊页（客户端）
  // 直接引着，抄一份的形态是两处枚举某天不一致，而 stage 校验只看得见其中一处。
  stages: CASE_STAGES,

  // 事实卡分节，顺序即 lib/agent/case-facts.ts 的渲染顺序。
  // 渲染器目前仍自带这份标题（P1 不动渲染器），两处一致由
  // __tests__/domain-pack-labor.test.ts 机检——它对着 case-facts.ts 源码逐条比。
  factsSections: [
    '当事人',
    '案件抬头',
    '本案对话',
    '法定期限',
    '用工基本盘（首诊四项）',
    '公司主体',
    '未完成的行动卡',
    '诉求（claims）',
    '时间线',
    '证据',
  ],

  // 下面三组取的是**已落库那份值集**（migrate.ts 里 deadlines.kind / drafts.kind /
  // claims.kind 三条 DDL 注释），不是设计稿 §2 D/E/F 的规划清单：写工具还没落地之前，
  // 列一批库里存不进去的种类等于给后来的人一份看着像真的假清单。
  deadlineKinds: ['仲裁时效', '起诉15日', '上诉15日', '举证期限', '开庭', '申请执行2年', '答辩期', '自定义'],
  docKinds: ['异议函', '被迫解除通知', '仲裁申请书', '证据清单', '答辩状', '上诉状', '谈判话术', '其他'],
  calculatorKinds: ['2N', 'N', 'N+1', '欠薪', '年假', '加班费', '双倍工资', '年终奖', '竞业补偿', '其他'],
};

/**
 * 能力注册表里那几处**带领域措辞**的对外文案。
 *
 * 【为什么在这里而不在 lib/capabilities】共用层不许出现领域字面量（见 registry.ts 头注释），
 * 而这四句是逐字对外的——工具清单会原样展示给用户的 agent，改一个字就是接口变更
 * （既有判据钉着 tools/list 的 description）。所以字还是这些字，位置搬到领域包里。
 *
 * 【已知未完】tools/list 没有案件上下文，拿不到「这次该用哪个领域的文案」。P1 只有一个
 * 领域，先由本包直供；第二个领域接进来时，「工具描述按领域变」还是「描述保持中性、
 * 领域细节退到 case_facts」需要单独裁决，不要在这里默默选一个。
 */
export const LABOR_CAPABILITY_COPY = {
  knowledgeSearchTitle: '检索劳动法知识库',
  knowledgeGetTitle: '按 id 取一张劳动法知识卡',
  deadlineListDescription:
    '列出案件的法定期限（仲裁时效、起诉 15 日、开庭等），默认只列生效中的，按到期时间升序。',
  intakeCompanyName: '公司名称，就是仲裁里的被申请人',
  intakeTerminationNotice: '《解除劳动合同通知书》',
  companyProfileUpsertDescription:
    '登记或补充公司主体档案。签约主体、发工资主体、实际用工主体可能是三家公司，' +
    '仲裁列谁为被申请人由此判定，所以只要用户提到公司名就要落档。同案同名只有一条，反复补充即更新。',
  draftListDescription:
    '列出案件名下已有的文书（类型、标题、版本、状态、时间），**不含正文**——' +
    '正文用 draft_get 按 draft_id 单取。仲裁材料一般会改好几稿，同一题的多版都在这里。',
} as const;
