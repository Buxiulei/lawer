// app/src/lib/capabilities/families/company.ts
// H 族：对方主体（设计稿 §2 H）——登记、免费探测、档案报价与确认、读档、关系图、守望。
import { WATCH_TIER_GONGDAO } from '@/lib/billing/pricing';
import * as cases from '@/lib/cases';
import {
  DOSSIER_MODULES,
  DOSSIER_MODULE_LABEL,
  type DossierModule,
} from '@/lib/company/dossier-billing';
import { confirmDossierOrder, quoteDossierOrder } from '@/lib/company/dossier-order';
import { probeCompany } from '@/lib/company/probe';
import { parseWatchTier, setWatch } from '@/lib/company/watch';
import { LABOR_CAPABILITY_COPY } from '@/lib/domains/labor';
import { getCaseDossier } from '@/lib/dossier/case-dossier';
import { buildCompanyGraph } from '@/lib/graph/build';

import { caseIdProp, num, writeOnce } from '../shared';
import type { Capability } from '../registry';

/**
 * 解析 blocks 入参。**不做「过滤掉未知值」这种宽容处理**：`['graph','graphs']` 被过滤成
 * `['graph']` 后，用户会看到一个他没选的价，而没有任何一处会报错。
 * @returns 合法非空数组 → 该数组；其余一律 null（调用方报 400）。省略也算不合法：买什么必须点名。
 */
function parseBlocks(raw: unknown): DossierModule[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const known = new Set<string>(DOSSIER_MODULES);
  if (!raw.every((b) => typeof b === 'string' && known.has(b))) return null;
  return raw as DossierModule[];
}

export const companyProfileUpsert: Capability = {
  name: 'company_profile_upsert',
  family: 'company',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  idempotency: { clientRef: true, naturalKey: '同案 + 同 name 一条，再写即在这条上补字段' },
  title: '登记公司主体',
  description: LABOR_CAPABILITY_COPY.companyProfileUpsertDescription,
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      name: { type: 'string', description: '公司全称，尽量与营业执照一致' },
      role: {
        type: 'string',
        enum: [...cases.COMPANY_ROLES],
        description:
          '这一方在本案里是哪个角色位。不填时：这个名字在本案已经登记过就沿用它已有的角色，' +
          '是新名字才落本领域声明的缺省角色位——**各领域的缺省不是同一个**，拿不准就点名。',
      },
      uscc: { type: 'string', description: '统一社会信用代码，不知道就不传' },
      legal_rep: { type: 'string', description: '法定代表人' },
      note: { type: 'string', description: '风险点：注册资本、经营异常、关联公司等' },
      sources: { type: 'string', description: '结论出处（用户自述 / 企业信息平台 / 用户回传截图），必须可溯源' },
      client_ref: {
        type: 'string',
        description: '幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库',
      },
    },
    required: ['case_id', 'name'],
  },
  run: (db, identity, args) => {
    const caseId = num(args.case_id);
    return writeOnce(
      db,
      {
        caseId,
        tool: 'company_profile_upsert',
        clientRef: args.client_ref,
        keyId: identity.keyId ?? null,
      },
      () =>
        cases.upsertCompany(db, {
          caseId,
          userId: identity.uid,
          name: args.name,
          role: args.role,
          uscc: args.uscc,
          legalRep: args.legal_rep,
          note: args.note,
          sources: args.sources,
        }),
      (res) => ({ table: 'company_profiles', id: res.id }),
    );
  },
};

// ───────────────── 对方主体情报（设计稿 §2 H）：免费探测 → 报价 → 确认 → 读档 ─────────────────
// 【这一族的措辞从哪来】「对方主体」是谁、怎么称呼，是领域的事（设计稿 §14-1 角色不写死），
// 所以下面每一条的 description 都取自领域包的 parties 拼出来的文案，本文件一个称呼都不写死。
// 写死的形态是：第二个领域接进来时，它的用户在工具清单里读到的仍是上一个领域的那个称呼——
// 工具照常可用、回包照常正确，只是每句话都在跟他讲另一个行当的事，而没有一处会报错。

/** 六个可售块的取值与中文名。名字取 lib/company 那份唯一真源，不在这里抄第二份。 */
const BLOCK_ENUM_DESC = DOSSIER_MODULES.map((m) => `${m}=${DOSSIER_MODULE_LABEL[m]}`).join(' / ');

export const companyProbe: Capability = {
  name: 'company_probe',
  family: 'company',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'POST', path: '/api/v1/company/probe' },
  title: '免费探对方主体概况',
  description: LABOR_CAPABILITY_COPY.companyProbeDescription,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: LABOR_CAPABILITY_COPY.companyNameParam },
      uscc: { type: 'string', description: '统一社会信用代码，知道就传（比名字更能锁准主体）' },
    },
    required: ['name'],
  },
  run: async (db, identity, args) => {
    try {
      const probe = await probeCompany(db, {
        name: typeof args.name === 'string' ? args.name : '',
        uscc: typeof args.uscc === 'string' ? args.uscc : null,
        userId: identity.uid,
      });
      return { ok: true as const, probe };
    } catch (err) {
      // 归一化算不出主体键（名字与统一社会信用代码都空）时抛的是那句三段式说明，原样转给对方。
      return {
        ok: false as const,
        status: 400,
        errorCode: 'COMPANY_NAME_EMPTY',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

export const dossierQuote: Capability = {
  name: 'dossier_quote',
  family: 'company',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  // 【没有 REST 映射】网页那条报价端点不发 quote_id（页面把参数原样再发一遍去确认），
  // 与本工具的契约不是同一份。登记成同一条，等于在自述清单里给对方一条形状对不上的端点。
  title: '给对方主体档案报价',
  description: LABOR_CAPABILITY_COPY.dossierQuoteDescription,
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      name: { type: 'string', description: LABOR_CAPABILITY_COPY.companyNameParam },
      uscc: { type: 'string', description: '统一社会信用代码，知道就传' },
      blocks: {
        type: 'array',
        items: { type: 'string', enum: [...DOSSIER_MODULES] },
        description: `要买哪几块：${BLOCK_ENUM_DESC}。可以只买核心几块；深度两块按篇数计价，` +
          '要先有一份新鲜的 company_probe 结果才报得出价。',
      },
    },
    required: ['case_id', 'name', 'blocks'],
  },
  run: (db, identity, args) => {
    const blocks = parseBlocks(args.blocks);
    if (!blocks) {
      return {
        ok: false as const,
        status: 400,
        errorCode: 'INVALID_BLOCKS',
        message:
          `blocks 只能是 ${DOSSIER_MODULES.join(' / ')} 里的非空数组，收到 ${JSON.stringify(args.blocks)}。` +
          '写了别的值说明双方对块名的理解不一致，宁可报错也不静默按默认值报价——' +
          '按默认值报出来的是一个用户没选过的总价。',
      };
    }
    return quoteDossierOrder(db, {
      userId: identity.uid,
      caseId: num(args.case_id),
      name: typeof args.name === 'string' ? args.name : '',
      uscc: typeof args.uscc === 'string' ? args.uscc : null,
      blocks,
    });
  },
};

export const dossierConfirm: Capability = {
  name: 'dossier_confirm',
  family: 'company',
  scope: 'case:write',
  kind: 'spend',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: ['balance'],
  // 幂等长在报价单上（confirmed_at 抢占 + 每块扣费的唯一索引兜底），不另收 client_ref：
  // 一张报价只对应一次扣费，再给一个 ref 等于给同一件事第二把钥匙，两把还会各自过期。
  idempotency: { naturalKey: 'quote_id：同一张报价重复确认只扣一次（回包 deduped=true）' },
  title: '确认档案订单并扣费',
  description: LABOR_CAPABILITY_COPY.dossierConfirmDescription,
  inputSchema: {
    type: 'object',
    properties: {
      quote_id: { type: 'integer', description: 'dossier_quote 回包里的 quote_id，原样回传' },
    },
    required: ['quote_id'],
  },
  run: (db, identity, args) => confirmDossierOrder(db, identity.uid, num(args.quote_id)),
};

export const dossierGet: Capability = {
  name: 'dossier_get',
  family: 'company',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'GET', path: '/api/v1/cases/{id}/dossier' },
  title: '读对方主体档案',
  description: LABOR_CAPABILITY_COPY.dossierGetDescription,
  inputSchema: {
    type: 'object',
    properties: { ...caseIdProp },
    required: ['case_id'],
  },
  run: (db, identity, args) =>
    getCaseDossier(db, { caseId: num(args.case_id), userId: identity.uid }),
};

export const companyGraphGet: Capability = {
  name: 'company_graph_get',
  family: 'company',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'GET', path: '/api/v1/cases/{id}/company-graph' },
  title: '读对方主体关系图',
  description: LABOR_CAPABILITY_COPY.companyGraphGetDescription,
  inputSchema: {
    type: 'object',
    properties: { ...caseIdProp },
    required: ['case_id'],
  },
  run: (db, identity, args) => {
    const caseId = num(args.case_id);
    // 归属校验走 lib/cases 的既有入口（同网页那条路由），不在这里另写一遍 user_id 比对。
    const owned = cases.getCase(db, { caseId, userId: identity.uid, timelineLimit: 1 });
    if (!owned.ok) return owned;
    return { ok: true as const, graph: buildCompanyGraph(db, caseId) };
  },
};

export const companyWatchSet: Capability = {
  name: 'company_watch_set',
  family: 'company',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  // 余额：这一次不扣钱，但它会让这个账号在下个月产生一笔月费，与「会花钱的动作」同级。
  precondition: ['balance'],
  idempotency: { naturalKey: '同案同主体只有一条活跃盯梢；再调即命中已有那条，且不改它的档位' },
  rest: { method: 'POST', path: '/api/v1/cases/{id}/watch' },
  title: '把对方主体挂进守望',
  description: LABOR_CAPABILITY_COPY.companyWatchSetDescription,
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      name: { type: 'string', description: LABOR_CAPABILITY_COPY.companyNameParam },
      uscc: { type: 'string', description: '统一社会信用代码，知道就传' },
      tier: {
        type: 'string',
        enum: Object.keys(WATCH_TIER_GONGDAO),
        description: `盯多勤：${Object.entries(WATCH_TIER_GONGDAO)
          .map(([t, fee]) => `${t}=${fee} 公道值/月`)
          .join(' / ')}。不传按最勤那档（daily）建，**别靠默认值**：说清楚再传。`,
      },
      company_profile_id: {
        type: 'integer',
        description: 'company_graph_get 里那个节点的 id；给了就按节点去重（比按名字更准）',
      },
    },
    required: ['case_id', 'name', 'tier'],
  },
  run: (db, identity, args) => {
    const tier = parseWatchTier(args.tier);
    if (!tier) {
      return {
        ok: false as const,
        status: 400,
        errorCode: 'INVALID_WATCH_TIER',
        message:
          `tier 只能是 ${Object.keys(WATCH_TIER_GONGDAO).join(' / ')}，收到 ${JSON.stringify(args.tier)}。` +
          '认不出的档位宁可报错也不静默按默认档建——默认是最勤那档，' +
          '会让用户以为自己挑的是不收费那档，下个月却收到月费。',
      };
    }
    const profileId = args.company_profile_id;
    return setWatch(db, {
      caseId: num(args.case_id),
      userId: identity.uid,
      name: typeof args.name === 'string' ? args.name : '',
      uscc: typeof args.uscc === 'string' ? args.uscc : null,
      companyProfileId:
        typeof profileId === 'number' && Number.isInteger(profileId) && profileId > 0
          ? profileId
          : null,
      tier,
    });
  },
};
