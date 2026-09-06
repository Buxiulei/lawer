// app/src/lib/capabilities/families/report.ts
// 个案报告族（设计稿 §4.3）：读一份整理过的长期记忆，以及在它上面改一节。
//
// 【为什么是两条而不是一条"写整份"】整份覆盖的形态是：agent 读到十节、只想改一节，
// 却要把另外九节原样重发一遍——中间任何一次转述失真都会把它没打算动的部分改掉，
// 而返回 200。按节改，没点名的节一个字都不会动。
import * as report from '@/lib/cases/report';

import { caseIdProp, num, writeOnce } from '../shared';
import type { Capability } from '../registry';

/** 写侧作者标识：走 api key 的记 agent:<key_id>，网页登录态记 web（设计稿 §4.3 updated_by 值集）。 */
function writerOf(identity: { via: string; keyId?: number }): string {
  return identity.via === 'api_key' && identity.keyId ? `agent:${identity.keyId}` : 'web';
}

export const caseReportGet: Capability = {
  name: 'case_report_get',
  family: 'report',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'GET', path: '/api/v1/cases/{id}/report' },
  title: '读个案报告',
  description:
    '读这个案子的**长期记忆**：整理过的分节报告 + 渲染稿 + 最后由谁在什么时候更新 + 过期标记。' +
    '开工先读它——它是历次整理的结论，比现拼一遍档案更完整。第一次读会自动从档案生成初稿。' +
    '回包里的 version 是改写时要回传的那个版本号；stale 非空表示档案在报告之后又变过，' +
    '**这时先整理报告再回答用户**，别拿一份过期的结论去下判断。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      section: {
        type: 'string',
        description: '只要某一节时传它的标题（取值见回包 section_order）；不传即整份',
      },
    },
    required: ['case_id'],
  },
  run: (db, identity, args) =>
    report.getReport(db, {
      caseId: num(args.case_id),
      userId: identity.uid,
      section: typeof args.section === 'string' ? args.section : null,
    }),
};

export const caseReportUpdate: Capability = {
  name: 'case_report_update',
  family: 'report',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  idempotency: { clientRef: true, naturalKey: 'base_version 乐观锁：版本对不上即拒收，不覆盖' },
  // 【没有 REST 映射】本期只开读侧那条 HTTP 口（GET /cases/{id}/report，网页档案页在用）。
  // 写侧登记一条磁盘上不存在的路径，等于在自述清单里给对方一条调不通的端点。
  title: '改写个案报告的一节',
  description:
    '把整理好的内容写进报告的某一节。**必须先 case_report_get 拿到 version，原样回传成 base_version**：' +
    '中间有人改过就回 REPORT_VERSION_CONFLICT（409），这时读回最新版、把你的改动合上去再重试，' +
    '不要重发同一份。reason 会自动记进「变更日志」那一节，所以写清楚这一改是为什么。' +
    '改成功后报告的过期标记一并清掉。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      section: { type: 'string', description: '要改哪一节，写它的标题（取值见 case_report_get 的 section_order）' },
      content: { type: 'string', description: '这一节的**新全文**（Markdown 片段，不含标题行）；不是追加' },
      reason: { type: 'string', description: '这一改是为什么，一句话，会原样进变更日志' },
      base_version: { type: 'integer', description: 'case_report_get 回包里的 version，原样回传' },
      client_ref: {
        type: 'string',
        description: '幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库',
      },
    },
    required: ['case_id', 'section', 'content', 'reason', 'base_version'],
  },
  run: (db, identity, args) => {
    const caseId = num(args.case_id);
    return writeOnce(
      db,
      { caseId, tool: 'case_report_update', clientRef: args.client_ref, keyId: identity.keyId ?? null },
      () =>
        report.updateSection(db, {
          caseId,
          userId: identity.uid,
          section: String(args.section ?? ''),
          content: String(args.content ?? ''),
          reason: String(args.reason ?? ''),
          baseVersion: num(args.base_version),
          updatedBy: writerOf(identity),
        }),
      (result) => ({ table: 'case_reports', id: result.report.case_id }),
    );
  },
};
