/**
 * 登录 / 公道值 / API key / 存证验证 的 mock 数据与假接口。
 * 字段语义对齐 spec §7 数据模型与 §9 定价草案；接后端后本文件整体换成真实调用，页面签名不变。
 */
import { demoGongdao } from './demo';
import type { GongdaoLedgerEntry } from './types';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/* ── 登录：手机号 + 邮箱双验证（spec D1）────────────────────────── */

export const OTP_LENGTH = 6;
export const OTP_RESEND_SECONDS = 60;

/** spec §10 首屏一次性免责声明，原文照用，不得改写。 */
export const DISCLAIMER_TEXT =
  '平台提供法律信息与行动建议，不构成律师意见、不形成委托代理关系。';

export function isPhone(value: string): boolean {
  return /^1[3-9]\d{9}$/.test(value.trim());
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function maskPhone(phone: string): string {
  return phone.trim().replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
}

export function maskEmail(email: string): string {
  const [name, domain] = email.trim().split('@');
  if (!domain) return email;
  const head = name.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(name.length - head.length, 1))}@${domain}`;
}

/** 假发码：真实实现走 lib/notify（阿里云短信 / DirectMail），限流在服务端。 */
export async function mockSendCode(): Promise<void> {
  await delay(400);
}

/** 假校验：mock 阶段任意 6 位数字都算通过。 */
export async function mockVerifyCode(code: string): Promise<boolean> {
  await delay(400);
  return new RegExp(`^\\d{${OTP_LENGTH}}$`).test(code);
}

/* ── 公道值：套餐与散充（spec D2 / §9）──────────────────────────── */

/** 散充锚点：1 元 = 100 公道值。 */
export const GONGDAO_PER_YUAN = 100;

export interface PlanSku {
  key: '入门' | '中配' | '高配';
  priceFen: number;
  /** 套餐含的当月公道值额度 */
  gongdao: number;
  /** 模型路由策略一句话 */
  routing: string;
  /** 适合谁 */
  fit: string;
}

export const PLANS: PlanSku[] = [
  {
    key: '入门',
    priceFen: 1990,
    gongdao: 1990,
    routing: '全部环节走 DeepSeek / Qwen',
    fit: '情况不复杂，主要要有人陪着把流程走完',
  },
  {
    key: '中配',
    priceFen: 5900,
    gongdao: 5900,
    routing: '关键环节（文件解读、文书、金额核算）走 Claude',
    fit: '手上有通知或协议要签，怕看漏条款',
  },
  {
    key: '高配',
    priceFen: 19900,
    gongdao: 19900,
    routing: '常规环节以上都走 Claude',
    fit: '已经进仲裁，材料多、来回多',
  },
];

export const PLAN_NOTE =
  '套餐含当月公道值额度 + 模型路由策略。以上为草案价，接入支付时按官方实价核定。';

export const TOPUP_PRESETS_YUAN = [10, 30, 50, 100];
export const TOPUP_MIN_YUAN = 1;
export const TOPUP_MAX_YUAN = 2000;

/* ── 公道值：账本（spec §7 gongdao_ledger，只追加不修改）────────── */

/** '退款' 在 spec 的 gongdao_ledger.type 里，_mock/types.ts 的联合还没覆盖，这里就地扩一格。 */
export type LedgerType = GongdaoLedgerEntry['type'] | '退款';

export interface LedgerEntry extends Omit<GongdaoLedgerEntry, 'type'> {
  type: LedgerType;
  /** 这一笔之后的余额；由 delta 累加得出，保证 SUM(ledger) = balance（spec §3 对账口径） */
  balanceAfter: number;
}

/** 按时间正序，最早在前；余额由这里累加，不写死。 */
const LEDGER_SEED: Omit<LedgerEntry, 'balanceAfter'>[] = [
  ...demoGongdao.ledger,
  {
    id: 'gl_7',
    delta: -220,
    type: '消耗',
    feature: 'agent.陪跑',
    meta: '开庭材料清单核对 · claude',
    createdAt: '2026-08-12T21:04:00+08:00',
  },
  {
    id: 'gl_8',
    delta: -1200,
    type: '固化出证',
    feature: 'evidence.attest',
    meta: '存证订单 AT-2026-0812-000517',
    createdAt: '2026-08-12T21:30:00+08:00',
  },
  {
    id: 'gl_9',
    delta: 1200,
    type: '退款',
    feature: 'evidence.attest',
    meta: '订单 AT-2026-0812-000517 时间戳超时，已原路退回',
    createdAt: '2026-08-12T21:41:00+08:00',
  },
  {
    id: 'gl_10',
    delta: -1200,
    type: '固化出证',
    feature: 'evidence.attest',
    meta: '存证订单 AT-2026-0812-000602 重新出证',
    createdAt: '2026-08-12T22:03:00+08:00',
  },
  {
    id: 'gl_11',
    delta: -318,
    type: '消耗',
    feature: 'knowledge.search',
    meta: '北京口径判例检索 12 次 · deepseek',
    createdAt: '2026-08-14T12:40:00+08:00',
  },
  {
    id: 'gl_12',
    delta: 3000,
    type: '兑换码',
    feature: 'redeem.CY-2026-3F7K',
    meta: '兑换码到账',
    createdAt: '2026-08-15T09:02:00+08:00',
  },
  {
    id: 'gl_13',
    delta: -742,
    type: '消耗',
    feature: 'draft.仲裁申请书',
    meta: '仲裁申请书 v1 · claude',
    createdAt: '2026-08-17T22:15:00+08:00',
  },
  {
    id: 'gl_14',
    delta: 1000,
    type: '充值',
    feature: 'order.散充',
    meta: '散充 ¥10',
    createdAt: '2026-08-18T08:31:00+08:00',
  },
  {
    id: 'gl_15',
    delta: -286,
    type: '消耗',
    feature: 'agent.陪跑',
    meta: '开庭流程预演 3 轮 · claude',
    createdAt: '2026-08-19T07:50:00+08:00',
  },
];

/** 正序累加出每笔的余额，再倒过来给页面（列表最新在上）。 */
function withRunningBalance(
  seed: Omit<LedgerEntry, 'balanceAfter'>[],
): LedgerEntry[] {
  let running = 0;
  const ascending = seed.map((entry) => {
    running += entry.delta;
    return { ...entry, balanceAfter: running };
  });
  return ascending.reverse();
}

/** 最新一笔在前。 */
export const mockLedger: LedgerEntry[] = withRunningBalance(LEDGER_SEED);

export const gongdaoBalance = mockLedger[0]?.balanceAfter ?? 0;

export const LEDGER_PAGE_SIZE = 6;

/** 分页取流水，page 从 0 开始。真实实现是游标分页（spec §3 列表全部分页）。 */
export function ledgerPage(page: number): { entries: LedgerEntry[]; hasMore: boolean } {
  const end = (page + 1) * LEDGER_PAGE_SIZE;
  return {
    entries: mockLedger.slice(0, end),
    hasMore: end < mockLedger.length,
  };
}

/* ── API key（spec §7 api_keys / D4）────────────────────────────── */

export interface ApiKeyRecord {
  id: string;
  name: string;
  /** 展示用掩码；完整 key 只在生成那一次给，落库只留 key_hash */
  masked: string;
  scopes: string[];
  lastUsedAt: string | null;
  enabled: boolean;
  createdAt: string;
}

export const API_KEY_SCOPES = [
  { key: 'case:read', label: '读案件档案' },
  { key: 'case:write', label: '写档案与时间线' },
  { key: 'evidence:write', label: '上传与固化证据' },
  { key: 'draft:write', label: '起草文书' },
  { key: 'knowledge:read', label: '检索法条' },
] as const;

export const DEFAULT_SCOPES = ['case:read', 'knowledge:read'];

export const mockApiKeys: ApiKeyRecord[] = [
  {
    id: 'ak_1',
    name: '我的 Claude 桌面端',
    masked: 'sk-lawer-…9f4c',
    scopes: ['case:read', 'case:write', 'evidence:write', 'draft:write', 'knowledge:read'],
    lastUsedAt: '2026-08-19T07:48:00+08:00',
    enabled: true,
    createdAt: '2026-07-20T15:02:00+08:00',
  },
  {
    id: 'ak_2',
    name: '备用（只读）',
    masked: 'sk-lawer-…20be',
    scopes: ['case:read', 'knowledge:read'],
    lastUsedAt: null,
    enabled: false,
    createdAt: '2026-08-02T11:26:00+08:00',
  },
];

const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomKeyBody(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += KEY_ALPHABET[Math.floor(Math.random() * KEY_ALPHABET.length)];
  }
  return out;
}

/** 假签发：secret 只在这次返回里出现一次，页面之后只留 record。 */
export function mockCreateApiKey(
  name: string,
  scopes: string[],
): { record: ApiKeyRecord; secret: string } {
  const body = randomKeyBody(32);
  const now = new Date();
  return {
    record: {
      id: `ak_${now.getTime()}`,
      name,
      masked: `sk-lawer-…${body.slice(-4)}`,
      scopes,
      lastUsedAt: null,
      enabled: true,
      createdAt: now.toISOString(),
    },
    secret: `sk-lawer-${body}`,
  };
}

/* ── MCP 接入（spec D4 / §4）────────────────────────────────────── */

export const MCP_ENDPOINT = 'https://lawer.example.com/api/mcp';

export const MCP_TOOLS = [
  'case_get',
  'case_update',
  'timeline_add',
  'evidence_upload',
  'docs_ocr',
  'claim_calc',
  'draft_write',
  'knowledge_search',
  'action_list',
  'action_done',
  'deadline_list',
];

export const MCP_CLIENT_CONFIG = `{
  "mcpServers": {
    "lawer": {
      "type": "http",
      "url": "${MCP_ENDPOINT}",
      "headers": {
        "Authorization": "Bearer sk-lawer-你的key"
      }
    }
  }
}`;

export const MCP_CURL = `curl -N ${MCP_ENDPOINT} \\
  -H "Authorization: Bearer sk-lawer-你的key" \\
  -H "Content-Type: application/json" \\
  -d '{"method":"tools/list"}'`;

/* ── 存证验证（公开页 /verify/:no）────────────────────────────────
 *
 * 前端红线（DESIGN.md「API 对接约定」，来源 WS2 sidecar 契约）：
 * 后端即使验签不通过也返回 HTTP 200，所以真实对接时
 *   —— 禁止用 `res.ok` / 状态码判断验证结果 ——
 * 裁决只看响应体的 `overall_ok`：true 才是通过，false 必须展示红态「验证未通过」，
 * 字段缺失 / JSON 解析失败 / 请求异常一律按「无法验证」处理，绝不展示为通过。
 * 真实实现形如：
 *   const res = await fetch(`/api/v1/verify/${no}`);   // 不看 res.ok
 *   const body = await res.json().catch(() => null);   // 解析失败 → null → 无法验证
 *   return body;                                       // 交给 readVerdict 裁决
 */

export interface VerifyCheck {
  key: string;
  label: string;
  /** null = 这一项本身没跑出结果 */
  ok: boolean | null;
  detail: string;
}

/** 后端响应体形状；真实响应可能缺字段，所以消费方一律走 readVerdict 兜底。 */
export interface VerifyBody {
  overall_ok: boolean;
  order_no: string;
  sha256: string;
  tsa_gen_time: string;
  tsa_serial: string;
  tsa_url: string;
  cert_chain_ok: boolean;
  /** 实名快照，掩码后下发，公开页不给全名 */
  realname_snapshot: string;
  checks: VerifyCheck[];
}

export type Verdict = 'pass' | 'fail' | 'unknown';

/**
 * 唯一的裁决入口：只认 overall_ok 的布尔值，其余情况一律 unknown。
 * 任何时候都不要拿 HTTP 状态码进来当参数。
 */
export function readVerdict(body: unknown): Verdict {
  if (!body || typeof body !== 'object') return 'unknown';
  const value = (body as { overall_ok?: unknown }).overall_ok;
  if (value === true) return 'pass';
  if (value === false) return 'fail';
  return 'unknown';
}

const VERIFY_SHA256 =
  'a3f1c07b2d9e845610bf3c72e0d418a95c6b7f2318dd40e9b1c58a7f26430ed4';

function passBody(no: string): VerifyBody {
  return {
    overall_ok: true,
    order_no: no,
    sha256: VERIFY_SHA256,
    tsa_gen_time: '2026-07-15T10:31:42+08:00',
    tsa_serial: '0x4C1F8A2E77B0',
    tsa_url: 'http://timestamp.globalsign.com/tsa/r6advanced1',
    cert_chain_ok: true,
    realname_snapshot: '陈**（身份证 1101**********0037）',
    checks: [
      { key: 'hash', label: '文件哈希一致', ok: true, detail: '重算 SHA256 与时间戳请求中的摘要逐位相同' },
      { key: 'tsa', label: '时间戳签名有效', ok: true, detail: 'RFC 3161 令牌验签通过，签发方 GlobalSign TSA' },
      { key: 'chain', label: '证书链可信', ok: true, detail: '链至 AATL 根，签发时刻不在吊销列表内' },
      { key: 'realname', label: '实名快照匹配', ok: true, detail: '出证时的实名信息与存证订单记录一致' },
    ],
  };
}

function failBody(no: string): VerifyBody {
  return {
    ...passBody(no),
    overall_ok: false,
    cert_chain_ok: false,
    checks: [
      { key: 'hash', label: '文件哈希一致', ok: false, detail: '重算 SHA256 与时间戳令牌中的摘要不一致，文件在出证后被改动过' },
      { key: 'tsa', label: '时间戳签名有效', ok: true, detail: 'RFC 3161 令牌本身验签通过' },
      { key: 'chain', label: '证书链可信', ok: false, detail: '签发证书已于 2026-08-01 吊销' },
      { key: 'realname', label: '实名快照匹配', ok: true, detail: '出证时的实名信息与存证订单记录一致' },
    ],
  };
}

/** 缺 overall_ok 的残缺响应：真实场景对应字段缺失 / 上游异常。 */
function brokenBody(no: string): Partial<VerifyBody> {
  return {
    order_no: no,
    sha256: VERIFY_SHA256,
    checks: [
      { key: 'hash', label: '文件哈希一致', ok: null, detail: '未取到时间戳令牌，无法比对' },
      { key: 'tsa', label: '时间戳签名有效', ok: null, detail: '时间戳服务无响应' },
    ],
  };
}

/**
 * 假接口：模拟 GET /api/v1/verify/:no 的响应体（注意返回的是 body，不是 Response）。
 * 演示规则：编号以 FAIL 结尾 → 未通过；以 BAD 结尾 → 残缺响应（无法验证）；其余 → 通过。
 */
export async function fetchVerifyResult(no: string): Promise<unknown> {
  await delay(120);
  const upper = no.toUpperCase();
  if (upper.endsWith('FAIL')) return failBody(no);
  if (upper.endsWith('BAD')) return brokenBody(no);
  return passBody(no);
}
