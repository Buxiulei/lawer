// app/src/lib/capabilities/families/evidence.ts
// B 族：证据（设计稿 §2 B）。清单 + 详情（含提取文本）+ 内容提取（报价/确认）+ 简报读写。
//
// 【本文件只做壳】归属判定、实名闸、报价与扣费、乐观锁全在 lib/evidence/extraction 里，
// 网页的 REST 路由调的是同一批函数（P1）。壳里放判断 = 同一个闸门有两份实现。
import * as cases from '@/lib/cases';
import {
  EXTRACTION_MODES,
  getEvidenceBrief,
  getEvidenceExtraction,
  quoteExtraction,
  startExtraction,
  updateEvidenceBrief,
} from '@/lib/evidence/extraction';
import { briefSummary, parseBrief, validateBrief } from '@/lib/evidence/brief';
import type { ExtractionMode } from '@/lib/jobs/extraction-worker';

import { caseIdProp, num } from '../shared';
import type { Capability } from '../registry';

const evidenceIdProp = {
  evidence_id: { type: 'integer', description: '证据 id（取自 evidence_list）' },
} as const;

/** 写工具身份串，落进 brief_updated_by：一张卡片是谁改的，事后要查得出来。 */
function author(keyId: number | null | undefined): string {
  return keyId === undefined || keyId === null ? 'agent' : `agent:${keyId}`;
}

function asMode(raw: unknown): ExtractionMode | null {
  return (EXTRACTION_MODES as readonly string[]).includes(raw as string)
    ? (raw as ExtractionMode)
    : null;
}

export const evidenceList: Capability = {
  name: 'evidence_list',
  family: 'evidence',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'GET', path: '/api/v1/cases/{id}/evidence' },
  title: '列出证据',
  description:
    '列出案件下已登记的证据条目（名称、分类、证明目的、固化状态、提取状态，以及有简报时的一句话摘要）。' +
    '要读全文或整份简报用 evidence_get / evidence_brief_get。',
  inputSchema: {
    type: 'object',
    properties: { ...caseIdProp },
    required: ['case_id'],
  },
  run: (db, identity, args) => {
    const result = cases.listEvidence(db, { caseId: num(args.case_id), userId: identity.uid });
    if (!result.ok) return result;
    return {
      ok: true as const,
      // brief_json 整份不进清单（一条几百字，二十条就把上下文占满了）：
      // 这里只给一句摘要，要整份的按 id 单取。
      evidence: result.evidence.map(({ brief_json, ...row }) => ({
        ...row,
        brief_summary: briefSummary(parseBrief(brief_json)),
      })),
    };
  },
};

export const evidenceGet: Capability = {
  name: 'evidence_get',
  family: 'evidence',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'GET', path: '/api/v1/evidence/{id}' },
  title: '读一件证据',
  description:
    '读一件证据的元数据、提取状态与简报；include_text 为真时附上已提取的文本' +
    '（超 8000 字截断并标 truncated，要全文去网页详情页）。文件二进制不经本接口。',
  inputSchema: {
    type: 'object',
    properties: {
      ...evidenceIdProp,
      include_text: {
        type: 'boolean',
        description: '是否带上已提取的文本正文（默认不带，省上下文）',
      },
    },
    required: ['evidence_id'],
  },
  run: (db, identity, args) =>
    getEvidenceExtraction(db, {
      evidenceId: num(args.evidence_id),
      userId: identity.uid,
      includeText: args.include_text === true,
    }),
};

export const evidenceExtract: Capability = {
  name: 'evidence_extract',
  family: 'evidence',
  scope: 'case:write',
  kind: 'spend',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: ['realname', 'balance'],
  rest: { method: 'POST', path: '/api/v1/evidence/{id}/extract' },
  title: '提取证据内容',
  description:
    '把一件材料的内容提取成文字：ocr（图片/PDF 认字）、asr（录音转写，带说话人与时间轴）、' +
    'video（抽音轨转写 + 关键帧识别）。**两步**：不带 quote_id 调一次得到报价（免费，不扣任何费用）；' +
    '把报价里的 quote_id 带回来再调一次才确认扣费并排队。完成后 evidence_get 能读到文本，' +
    '并自动附一份简报（不额外收费）。',
  inputSchema: {
    type: 'object',
    properties: {
      ...evidenceIdProp,
      mode: {
        type: 'string',
        enum: [...EXTRACTION_MODES],
        description: 'ocr = 图片/PDF 认字；asr = 录音转写；video = 视频',
      },
      quote_id: {
        type: 'integer',
        description: '不填 = 只报价不扣费；填上一次报价回的 quote_id = 确认扣费并开始提取',
      },
    },
    required: ['evidence_id', 'mode'],
  },
  run: (db, identity, args) => {
    const mode = asMode(args.mode);
    if (!mode) {
      return {
        ok: false as const,
        status: 400,
        errorCode: 'INVALID_MODE',
        message: `mode 只能是 ${EXTRACTION_MODES.join(' / ')}，收到 ${JSON.stringify(args.mode)}。`,
      };
    }
    const evidenceId = num(args.evidence_id);
    if (args.quote_id === undefined || args.quote_id === null) {
      return quoteExtraction(db, { evidenceId, userId: identity.uid, mode });
    }
    return startExtraction(db, {
      evidenceId,
      userId: identity.uid,
      mode,
      quoteId: num(args.quote_id),
    });
  },
};

export const evidenceBriefGet: Capability = {
  name: 'evidence_brief_get',
  family: 'evidence',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'GET', path: '/api/v1/evidence/{id}/brief' },
  title: '读证据简报',
  description:
    '读一件证据的简报：能证明什么、关键事实（时间/人物/事项/原话/位置）、与诉求的关系、' +
    '弱点与补强建议、引用位置。要改写就把回包里的 version 原样带给 evidence_brief_update。',
  inputSchema: {
    type: 'object',
    properties: { ...evidenceIdProp },
    required: ['evidence_id'],
  },
  run: (db, identity, args) =>
    getEvidenceBrief(db, { evidenceId: num(args.evidence_id), userId: identity.uid }),
};

export const evidenceBriefUpdate: Capability = {
  name: 'evidence_brief_update',
  family: 'evidence',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  idempotency: { naturalKey: '证据 id + base_version（乐观锁：版本对不上即拒，不覆盖）' },
  rest: { method: 'PUT', path: '/api/v1/evidence/{id}/brief' },
  title: '改写证据简报',
  description:
    '整份替换一件证据的简报。base_version 必须是你刚用 evidence_brief_get 读到的那个版本号——' +
    '对不上会返回 409 并告诉你库里现在是第几版，重读、把你的改动合进去再提交。' +
    'brief 必须含 proves，其余分节可为空。',
  inputSchema: {
    type: 'object',
    properties: {
      ...evidenceIdProp,
      brief: {
        type: 'object',
        description:
          '固定 schema：{proves, key_facts:[{when,who,what,quote,where}], relation_to_claims, ' +
          'weaknesses[], suggested_followups[], citations[]}。key_facts 里的 quote 必须是提取文本里的原话，' +
          '引不到就留空字符串。',
        properties: {
          proves: { type: 'string', description: '这件材料能证明什么（必填）' },
          key_facts: { type: 'array', items: { type: 'object' } },
          relation_to_claims: { type: 'string' },
          weaknesses: { type: 'array', items: { type: 'string' } },
          suggested_followups: { type: 'array', items: { type: 'string' } },
          citations: { type: 'array', items: { type: 'string' } },
        },
        required: ['proves'],
      },
      reason: { type: 'string', description: '为什么改（留痕，回包原样带回）' },
      base_version: { type: 'integer', description: '你读到的版本号；0 = 之前没有简报' },
    },
    required: ['evidence_id', 'brief', 'reason', 'base_version'],
  },
  run: (db, identity, args) => {
    const checked = validateBrief(args.brief);
    if (!checked.ok) {
      return {
        ok: false as const,
        status: 400,
        errorCode: 'INVALID_BRIEF',
        message: `简报不合 schema：${checked.problems.join('；')}`,
      };
    }
    if (!Number.isInteger(args.base_version)) {
      return {
        ok: false as const,
        status: 400,
        errorCode: 'INVALID_BASE_VERSION',
        message:
          'base_version 必须是整数，且必须是你刚读到的那一版。' +
          '为什么：没有它就没法判断中间有没有别人改过，写下去会静默盖掉那次改动。' +
          '怎么办：先调 evidence_brief_get，把回包里的 version 原样传进来。',
      };
    }
    return updateEvidenceBrief(db, {
      evidenceId: num(args.evidence_id),
      userId: identity.uid,
      brief: checked.brief!,
      reason: typeof args.reason === 'string' ? args.reason : '',
      baseVersion: args.base_version as number,
      updatedBy: author(identity.keyId),
    });
  },
};
