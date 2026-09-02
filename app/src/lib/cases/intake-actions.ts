// app/src/lib/cases/intake-actions.ts
// 首诊做完给的那三件事：**按阶段的种子表**。
//
// 【为什么在 lib 而不在页面里】这三条既要画在首诊第 6 步的「现在做这三件事」上，
// 又要落成用户案件里的 action_items——两处必须是同一份。此前只有页面那一份，
// 于是它们只是屏幕上的三行字：用户点「进入驾驶舱」，三件事一件都没进库。
//
// 【本文件保持纯】不 import 数据库、不 import 页面 mock：服务端落库与客户端预览都要用它，
// 掺进任何一边的依赖，另一边就得绕路（或者干脆再抄一份，那正是这次要修的病）。
//
// 【dueInDays 是自查提醒，不是法定期限】它算出来的是「几天内自己做完」，
// 与 lib/deadline 的法定期限不是一回事，落库时进 action_items.due_at，不进 deadlines。

import type { CaseStage } from './stages';

export interface IntakeActionSeed {
  title: string;
  detail: string;
  /** 距今天几天到期，null = 不设期限 */
  dueInDays: number | null;
}

export const INTAKE_STAGE_ACTIONS: Record<CaseStage | '', IntakeActionSeed[]> = {
  '': [],
  风声: [
    {
      title: '先把劳动合同和近 12 个月工资流水导出来',
      detail:
        '一旦被收走权限，这些材料就不好拿了。合同拍照存到自己手机，工资流水从银行 App 导出带电子章的 PDF。',
      dueInDays: 3,
    },
    {
      title: '把公司宣布调整的场合记下来',
      detail:
        '开会时间、说了什么、谁说的，写成一句话记到时间线里。将来公司说"和裁员无关"时，这些是最早的印证。',
      dueInDays: 7,
    },
    {
      title: '暂时不要主动提离职，也不要签任何空白表格',
      detail:
        '主动辞职拿不到补偿。在没有书面方案之前，口头答应也可能被当成协商一致的证据。',
      dueInDays: null,
    },
  ],
  约谈中: [
    {
      title: '下次约谈前打开手机录音',
      detail:
        '在北京，当事人对自己参与的谈话录音是合法的，仲裁中可以作为证据。录完不要剪辑，原始文件留在手机里。',
      dueInDays: 2,
    },
    {
      title: '不要当场签《协商解除协议》',
      detail:
        '协议一旦签了，再主张违法解除赔偿金会非常被动。可以说"我要拿回去看看"，这句话不需要任何理由。',
      dueInDays: null,
    },
    {
      title: '用书面方式要公司出具方案',
      detail:
        '发一封工作邮件，请公司写明解除理由、补偿计算方式和支付时间，抄送自己的私人邮箱留底。',
      dueInDays: 5,
    },
  ],
  已收通知: [
    {
      title: '把解除通知原件拍照，传到文件解读',
      detail:
        '通知书上写的解除理由决定了你能主张 N 还是 2N。上传后会逐条标出对你不利的表述。',
      dueInDays: 2,
    },
    {
      title: '书面回复公司，保留异议',
      detail:
        '收到通知后不表态，容易被解读为默认接受。一封写明"不认可解除理由、保留全部权利"的回复就够了。',
      dueInDays: 5,
    },
    {
      title: '办交接可以配合，但别签认可解除理由的字',
      detail:
        '交接清单只写物品和工作，遇到"本人认可公司解除决定"这类表述，划掉再签，或者写明"仅确认交接物品"。',
      dueInDays: null,
    },
  ],
  已解除: [
    {
      title: '确认仲裁时效的起算日',
      detail:
        '劳动争议仲裁时效是一年，从你知道权利被侵害那天起算；欠薪的时效从劳动关系终止之日起算。先把这个日子定下来。',
      dueInDays: 3,
    },
    {
      title: '把工资流水、考勤、聊天记录补齐到证据库',
      detail:
        '离职后公司系统会陆续关闭，钉钉、企业微信里的记录要趁还能登录的时候导出来。',
      dueInDays: 7,
    },
    {
      title: '要求公司出具离职证明并办理退工',
      detail:
        '离职证明是法定义务，不能以"没签协议"为由扣着。拿不到会影响下一家入职，也是可以一并主张的诉求。',
      dueInDays: 10,
    },
  ],
  仲裁准备: [
    {
      title: '核对被申请人主体信息',
      detail:
        '申请书上的公司名称、统一社会信用代码必须和劳动合同上的签约主体一致，写错会被要求补正，白跑一趟。',
      dueInDays: 3,
    },
    {
      title: '按诉求逐条整理证据清单',
      detail:
        '每一条诉求对应哪几份证据、证明什么，列成表。朝阳区仲裁委立案时要提交证据目录。',
      dueInDays: 5,
    },
    {
      title: '把证据固化，拿到存证证明',
      detail:
        '聊天记录和录音这类电子证据，固化后带时间戳和哈希值，公司质疑真实性时能直接复核。',
      dueInDays: 7,
    },
  ],
  已立案: [],
  开庭: [],
  裁决: [],
  一审: [],
  二审: [],
  执行: [],
  结案: [],
};

/**
 * 这条自查提醒的到期时刻（ISO8601）。dueInDays 为 null = 不设期限。
 * 预览与落库共用它，免得屏幕上写「3 天内」而库里存成了别的日子。
 */
export function intakeActionDueAt(seed: IntakeActionSeed, now: Date): string | null {
  return seed.dueInDays === null
    ? null
    : new Date(now.getTime() + seed.dueInDays * 86_400_000).toISOString();
}

/**
 * 种子序号 → action_items.priority。
 *
 * **种子表里越靠前越急，而 action_items 是按 priority 降序取的**（lib/db/cases 的
 * `ORDER BY priority DESC`，tools.ts 也写明「数字越大越急」）。所以第 0 条必须拿最大的数，
 * 直接用 i+1 会让驾驶舱「只推一件事」推出三件里最不急的那件——而它看起来完全正常。
 */
export function intakeActionPriority(total: number, index: number): number {
  return total - index;
}
