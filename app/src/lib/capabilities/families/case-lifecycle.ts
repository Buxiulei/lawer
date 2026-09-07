// app/src/lib/capabilities/families/case-lifecycle.ts
// A 族里管「这份档案的去留」的两条：删除与整案导出。
// 另起文件而不是塞进 families/case.ts，理由同 actions-write.ts / evidence-write.ts：
// 并行窗口不动别人在跑的族文件。
//
// 两条都是薄壳：校验入参形状 → 调 lib/lifecycle → 把结果原样 JSON 化。
// 归属校验、二次确认、幂等全在领域层，**不在这里重复实现**——REST 面走的是同一批函数。
import { deleteCase } from '@/lib/lifecycle/case-delete';
import { exportCase } from '@/lib/lifecycle/case-export';
import { RETENTION_DAYS } from '@/lib/lifecycle/retention';

import { caseIdProp, num } from '../shared';
import type { Capability } from '../registry';

export const caseDelete: Capability = {
  name: 'case_delete',
  family: 'case',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  // 【删除不设实名闸】删除是把已经交出去的东西收回来。一个实名状态掉回「待审」的人，
  // 若因此再也删不掉自己的档案，那正是他最想删的时候。同 share_revoke 的理由。
  precondition: [],
  idempotency: { naturalKey: 'case_id（已删除的再删一次原样返回，首次删除时点与到期时点都不变）' },
  rest: { method: 'DELETE', path: '/api/v1/cases/{id}' },
  title: '删除案件档案',
  description:
    '删掉一个案件的整份档案。**两步，且不可撤销**：\n' +
    '第一步不带 confirm_token 调一次，回一份确认单（removes = 会删掉什么、keeps = 什么会留下）' +
    '与一串 confirm_token，**这一步一行都不会删**；\n' +
    '第二步把 removes 与 keeps 逐条念给用户听、得到明确同意后，带上 confirm_token 再调一次才执行。\n' +
    '执行后档案立即从所有页面与接口上消失（免登录分享链接当场失效），' +
    `${RETENTION_DAYS} 日后由后台任务彻底删除。**我们不提供「撤销删除」**，请在确认前就说清这一点。\n` +
    '已经出具过的存证证明与支付记录不在删除范围内（keeps 里逐条写着）。\n' +
    '**幂等**：删过的再删一次照样成功，already_deleted=true，首次删除时点不变。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      confirm_token: {
        type: 'string',
        description:
          '第一步回包里那串确认令牌。不给 = 只出确认单、一行都不删；给了且对得上 = 执行删除。' +
          '不要自己拼一个：它是按案件身份算出来的',
      },
    },
    required: ['case_id'],
  },
  run: (db, identity, args) =>
    deleteCase({
      db,
      caseId: num(args.case_id),
      userId: identity.uid,
      confirmToken: args.confirm_token,
    }),
};

export const caseExport: Capability = {
  name: 'case_export',
  family: 'case',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  // 实名闸沿用现状：包里装的是文书 PDF 与材料原件，而这两样在本站本来就要求已实名
  // （上传材料、导出 PDF 都挂着这道闸）。导出绕开它就等于给未实名的路径开了一个新出口。
  precondition: ['realname'],
  rest: { method: 'GET', path: '/api/v1/cases/{id}/export' },
  title: '导出整案副本',
  description:
    '把一个案件的全部内容打成一个 zip，回一条**一次性、限时**的下载地址' +
    '（浏览器直接打开即可，不必带凭据）。包里有：档案.json（全部数据，逐表原样导出）、' +
    '文书/（每份文书的 PDF）、证据原件/（上传过的材料原件）、清单.json 与 README.txt。\n' +
    '**免费**，不报价、不扣费，也不改动案卷里的任何一行。\n' +
    '回包里的 omissions 是「这次少装了哪几项、为什么少」——**不为空时不要把这次导出说成完整副本**，' +
    '照原因念给用户听。需已完成实名认证。',
  inputSchema: {
    type: 'object',
    properties: { ...caseIdProp },
    required: ['case_id'],
  },
  run: (db, identity, args) =>
    exportCase({ db, caseId: num(args.case_id), userId: identity.uid }),
};
