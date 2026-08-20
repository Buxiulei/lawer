// app/src/lib/agent/tools.ts
// 律师 agent 的工具注册表与执行器。
//
// 【第一原则：结构化落库，禁自由文本直写】（charter §9 末条）
// 模型的正文只负责「说给用户听」，凡是要进档案的东西——事件、诉求金额、行动卡、情绪、
// 公司主体、文书——**只能经这里的工具落库**。正文里写「我已经帮你记到时间线了」而没调工具，
// 那就是没记；下一轮读档案读不到，用户第二天回来发现档案是空的。
// 所以本文件是唯一的写入面，orchestrator 不允许自己往这几张表里写一行。
//
// 【第二原则：闸门在工具里，不在提示词里】
// 行动卡 ≤3 张、文书必附发送后果、心理转介一案一次——这些都是 charter 的硬约束。
// 写进 system prompt 只是「请你遵守」，写进工具执行器才是「你做不到违反」。
// 凡是能机械判定的红线，一律在这里挡，并把拒绝原因回喂给模型让它改正。
import type { Database } from 'better-sqlite3';

import * as cases from '@/lib/cases';
import * as store from '@/lib/db/agent';
import type { ToolDef } from '@/lib/llm';
import type { AgentEventSink } from './events';
import * as calc from './calc';
import { citationCorrectionDirective, type CitationGuard } from './citation-guard';
import * as deadline from '@/lib/deadline';
import type { InputSource } from './calc';
import {
  KNOWLEDGE_MISS_DIRECTIVE,
  MAX_INJECTED_PACKS,
  type KnowledgePack,
  type KnowledgeSearcher,
} from './retrieval';

/** charter §2：每次回复 ≤3 张行动卡。超过就不是「现在做什么」，是又一份待办清单。 */
export const MAX_ACTION_CARDS = 3;

/** 与 migrate.ts claims.kind 注释逐字对齐 */
export const CLAIM_KINDS = [
  '2N', 'N', 'N+1', '欠薪', '年假', '加班费', '双倍工资', '年终奖', '竞业补偿', '其他',
] as const;

/** 与 migrate.ts drafts.kind 注释逐字对齐 */
export const DRAFT_KINDS = [
  '异议函', '被迫解除通知', '仲裁申请书', '证据清单', '答辩状', '上诉状', '谈判话术', '其他',
] as const;

/** claim_calc 目前实装的公式（lib/agent/calc）。年假/加班费/双倍工资等后批再加，
 *  加进来之前不列进 enum——列了模型就会调，然后拿到一个「不支持」的错误。 */
export const CALC_KINDS = ['N', 'N+1', '2N'] as const;

/** 与 migrate.ts emotion_log.level 注释逐字对齐 */
export const EMOTION_LEVELS = ['平稳', '低落', '焦虑', '严重'] as const;

/** 与 migrate.ts company_profiles.role 注释逐字对齐 */
export const COMPANY_ROLES = ['签约主体', '用工主体', '关联'] as const;

/**
 * 「会发给公司」的文书类型。charter 红线 5 只对这几类生效——
 * 谈判话术、证据清单是给用户自己用的，附一段「发出前请确认」纯属噪音。
 */
const OUTBOUND_DRAFT_KINDS: ReadonlySet<string> = new Set(['异议函', '被迫解除通知', '仲裁申请书', '答辩状', '上诉状']);

/** 本轮编排的可变状态。orchestrator 建一份，逐个工具调用累加。 */
export interface TurnState {
  /** 本轮已产出的行动卡数（上限 MAX_ACTION_CARDS） */
  actionCards: number;
  /** 本轮调过几次 knowledge_search */
  searches: number;
  /** 本轮累计检索到的 pack（去重，供 orchestrator 判断是否走「无依据」路径） */
  retrieved: KnowledgePack[];
  /** 本轮是否写过文书 */
  drafts: number;
}

export function newTurnState(): TurnState {
  return { actionCards: 0, searches: 0, retrieved: [], drafts: 0 };
}

export interface AgentToolContext {
  db: Database;
  /** 服务端注入，**不来自模型参数**：模型无从把事件写到别人的案子上 */
  caseId: number;
  /** 案件属主。归属校验在进编排循环前已由 lib/cases 做过，这里带着它是为了过 lib/cases 的门 */
  userId: number;
  /** 当前会话线程 id。intake_done 往 threads.intake_stage 落痕要用 */
  threadId: number;
  /** 本轮 assistant 消息的 id，行动卡按它回指「这条为什么要做」 */
  sourceMessageId: number | null;
  /** lib/knowledge 未交付时为 undefined，knowledge_search 走不可用降级 */
  searcher?: KnowledgeSearcher;
  /** 案号运行时闸门。文书落库前过一遍，查无此号的直接拒收 */
  citations: CitationGuard;
  state: TurnState;
  emit: AgentEventSink;
}

/** 工具执行结果：回喂给模型的 role:'tool' 正文。ok=false 时模型应据 content 改正后重试。 */
export interface ToolOutcome {
  ok: boolean;
  content: string;
}

function ok(payload: Record<string, unknown>): ToolOutcome {
  return { ok: true, content: JSON.stringify({ ok: true, ...payload }) };
}

function reject(message: string): ToolOutcome {
  return { ok: false, content: JSON.stringify({ ok: false, error: message }) };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** ISO8601 校验；合法则回 ISO 串（落库时由 SQL 的 datetime() 归一，ADR-002） */
function isoOrNull(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function inEnum(v: unknown, allowed: readonly string[]): string | null {
  const s = str(v);
  return s && allowed.includes(s) ? s : null;
}

// ───────────────────────── 工具 schema（下发给模型）─────────────────────────
//
// 手写 JSON Schema 字面量，与 lib/mcp/tools.ts 同一风格（那边的理由同样适用：
// 工具数量少、参数浅，引 zod 换来两个依赖和一层转换不划算）。
// case_id 不在任何 schema 里——它由服务端注入，见 AgentToolContext。

export const AGENT_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'knowledge_search',
      description:
        '检索知识库，拿到法条/判例/计算规则/流程SOP/文书模板/话术/数据卡的**逐字原文**。' +
        '任何涉法断言、任何数字、任何文书起草之前都必须先调它——你自己记忆里的条号和数字一律不可用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词，用案情关键词而非整句话，如「客观情况重大变化 北京口径」' },
          type: {
            type: 'string',
            enum: ['法条卡', '判例卡', '计算规则', '流程SOP', '文书模板', '话术卡', '情绪指南', '数据卡'],
            description: '只要某一类卡时传，一般不传',
          },
          limit: { type: 'integer', description: `最多几张，默认 ${MAX_INJECTED_PACKS}` },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'timeline_add',
      description:
        '把用户说到的一个**已发生事实**记进案件时间线。时间线只追加不修改，记错了补一条更正事件。' +
        '每轮对话中用户提到的新事件都要落档，不能只留在对话里。',
      parameters: {
        type: 'object',
        properties: {
          happened_at: { type: 'string', description: '事件发生时间，ISO8601。只知道日期就用当天 00:00' },
          kind: { type: 'string', enum: [...cases.TIMELINE_KINDS], description: '谁做的' },
          title: { type: 'string', description: '一句话概括发生了什么' },
          detail: { type: 'string', description: '细节：谁说了什么、给了什么文件、有无书面留痕' },
        },
        required: ['happened_at', 'kind', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'claims_upsert',
      description:
        '登记或更新一项诉求（金额要素）。同一案同一 kind 只有一条，再调即更新。' +
        '金额未经 claim_calc 算出时 amount_fen 传 0 并在 calc_json 里写清缺哪些输入。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...CLAIM_KINDS], description: '诉求类型' },
          amount_fen: {
            type: 'integer',
            description:
              '金额，单位**分**。**N / N+1 / 2N 不许在这里填**——那三项走 claim_calc，它会直接落库；' +
              '这里只用于用户自述的事实性金额（欠薪本金、年终奖数额等），未确定时传 0',
          },
          calc_json: {
            type: 'string',
            description:
              'JSON 字符串：算式与全部输入，每项标注是「用户自述待证」还是「已有证据」。' +
              '未算出时写 {"status":"待计算","missing":[...]}',
          },
          basis: { type: 'string', description: '法律依据，写 pack id + 条号，如 statute-lhtf-38-beipo-jiechu §38' },
          status: { type: 'string', enum: ['draft', 'confirmed'], description: '默认 draft' },
        },
        required: ['kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'action_card',
      description:
        `产出一张行动卡。**每轮回复至少 1 张、最多 ${MAX_ACTION_CARDS} 张**，这是硬性要求。` +
        '建议必须具体到当天与句子级：「注意留存证据」不合格，「今天 18 点前把这三样导出到个人邮箱：…」才合格。',
      parameters: {
        type: 'object',
        properties: {
          what: { type: 'string', description: '做什么。一句祈使句，具体到动作' },
          how: {
            type: 'string',
            description: '怎么做。含**可直接照读/粘贴的原句**；涉及对公司说话的，同时写明哪些话绝不能说',
          },
          why: { type: 'string', description: '为什么，一句话，带依据（pack id / 条号）' },
          due_at: { type: 'string', description: '截止时间，ISO8601。「今天下班前」也要换算成具体时刻' },
          priority: { type: 'integer', description: '优先级，数字越大越急，默认 0' },
        },
        required: ['what', 'how', 'why', 'due_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'emotion_log',
      description:
        '记录用户当前情绪状态。识别到低落/焦虑/严重痛苦时都要记，这是长期陪跑看走向的依据。' +
        'refer_nbdpsy 只在符合持续焦虑抑郁表现时置 true，且一个案子最多一次。',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: [...EMOTION_LEVELS], description: '情绪档位' },
          note: { type: 'string', description: '判断依据：用户说了什么（引原话片段）' },
          refer_nbdpsy: { type: 'boolean', description: '本轮是否转介心理咨询，默认 false' },
        },
        required: ['level'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'company_profile_upsert',
      description:
        '登记或补充公司主体档案。签约主体、发工资主体、实际用工主体可能是三家公司，' +
        '仲裁列谁为被申请人由此判定，所以只要用户提到公司名就要落档。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '公司全称，尽量与营业执照一致' },
          uscc: { type: 'string', description: '统一社会信用代码，不知道就不传' },
          role: { type: 'string', enum: [...COMPANY_ROLES], description: '默认签约主体' },
          legal_rep: { type: 'string', description: '法定代表人' },
          risk_notes: { type: 'string', description: '风险点：注册资本、经营异常、关联公司等' },
          sources: { type: 'string', description: '结论出处（用户自述 / 爱企查 / 用户回传截图），必须可溯源' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_write',
      description:
        '起草一份文书并存进案件档案。模板基底一律先用 knowledge_search 取 type=文书模板 的 pack 原文，' +
        '不要凭记忆写格式。发给公司的文书（异议函/被迫解除通知/仲裁申请书/答辩状/上诉状）' +
        '**必须**同时给 send_consequences，说清发出后会发生什么。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...DRAFT_KINDS], description: '文书类型' },
          title: { type: 'string', description: '文书标题' },
          content: { type: 'string', description: '文书全文。填空位保留【】并附填写说明' },
          send_consequences: {
            type: 'string',
            description:
              '发出后果说明：发出后法律关系会怎么变、对方可能怎么应对、哪些是不可逆的。' +
              '发给公司的文书必填，缺了会被拒绝。',
          },
        },
        required: ['kind', 'title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'intake_done',
      description:
        '标记首诊问诊清单已走完（用户已答复特殊保护情形，无论有没有）。' +
        '只在 D 档问过并拿到答复后调一次；不调的话下一轮还会再问一遍同样的问题。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '用户对特殊保护情形的答复摘要，如「无孕产/工伤/医疗期，司龄 3 年」' },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deadline_set',
      description:
        '登记一条法定期限。**你只给起算锚点日期和期限类型，到期日由系统算**——' +
        '不要自己算「某日 + 15 天是几号」，期限错过即权利灭失，这个数不接受心算。' +
        '返回值带推算依据与提醒，展示时要把「未含节假日顺延」如实告诉用户。',
      parameters: {
        type: 'object',
        properties: {
          rule: {
            type: 'string',
            enum: [...deadline.DEADLINE_RULE_KEYS],
            description: '期限类型。举证期限的天数由仲裁委通知书指定，须一并给 days',
          },
          anchor_date: {
            type: 'string',
            description:
              '起算锚点，YYYY-MM-DD。如裁决书签收日、判决书送达日、起诉状副本收到日、解除日、受理通知书收到日',
          },
          days: { type: 'integer', description: '仅「举证期限」需要：通知书上写明的天数，照抄不要猜' },
        },
        required: ['rule', 'anchor_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deadline_resolve',
      description:
        '把一条期限标记为已履行/已作废，停止后续提醒。用户说「我已经起诉了」「答辩状交了」' +
        '「公司 15 日内没起诉、裁决已生效」时调它——不标记的话系统会一直提醒一件已经做完的事。',
      parameters: {
        type: 'object',
        properties: {
          deadline_id: { type: 'integer', description: '期限 id（档案摘要里的「生效中的法定期限」有列）' },
          note: { type: 'string', description: '怎么了结的，一句话' },
        },
        required: ['deadline_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'claim_calc',
      description:
        '按北京口径计算经济补偿 N / 代通知金 N+1 / 违法解除赔偿金 2N（工龄分段、三倍社平封顶、12 年上限）。' +
        '一切金额必须走本工具，**禁止自己心算**——分段与封顶规则你算不对，而错的金额会直接写进仲裁申请书。' +
        '返回值含算式、分步留痕与法条依据，展示时要把算式和「哪些输入是用户自述待证」一起讲给用户。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...CALC_KINDS], description: '算哪一项' },
          avg_monthly_wage_fen: {
            type: 'integer',
            description:
              '解除前 12 个月平均**应得**工资，单位分。应得=税前、扣个人社保公积金之前，含奖金与加班费；' +
              '用户报的「到手」不是这个数，必须先换算并告诉他差别',
          },
          employed_from: { type: 'string', description: '入职日 YYYY-MM-DD' },
          terminated_at: { type: 'string', description: '解除/终止日 YYYY-MM-DD' },
          last_month_wage_fen: {
            type: 'integer',
            description: '解除前最后一个完整工资月的工资标准（分）。**只有算 N+1 时必填**',
          },
          evidence_backed: {
            type: 'array',
            items: { type: 'string' },
            description:
              '哪些输入已有证据支撑（如 ["avg_monthly_wage_fen"]，依据工资流水）。' +
              '不在这个列表里的一律按「用户自述待证」标注',
          },
        },
        required: ['kind', 'avg_monthly_wage_fen', 'employed_from', 'terminated_at'],
      },
    },
  },
];

// ───────────────────────── 执行器 ─────────────────────────

type Handler = (args: Record<string, unknown>, ctx: AgentToolContext) => ToolOutcome;

const HANDLERS: Record<string, Handler> = {
  knowledge_search(args, ctx) {
    const query = str(args.query);
    if (!query) return reject('query 不能为空');
    ctx.state.searches += 1;

    if (!ctx.searcher) {
      ctx.emit({
        event: 'notice',
        data: { code: 'KNOWLEDGE_UNAVAILABLE', message: '知识库检索暂不可用，本轮回复已按「需要核实」保守路径生成' },
      });
      return ok({ packs: [], note: KNOWLEDGE_MISS_DIRECTIVE });
    }

    const limit = Math.min(Number(args.limit) || MAX_INJECTED_PACKS, MAX_INJECTED_PACKS);
    const packs = ctx.searcher.search(query, { limit, type: str(args.type) ?? undefined });
    // 已经在本轮上下文里的卡只回一个指针，不再重发全文。
    // 预检索已经把最贴题的几张原样放进 system prompt，模型再搜一次往往命中同一批；
    // 把 12000 字的 534 号卡在一轮里发两遍，既拖慢首字也白烧钱，而模型手上并没多任何信息。
    const alreadyInContext = new Set(ctx.state.retrieved.map((r) => r.id));
    for (const p of packs) {
      if (!alreadyInContext.has(p.id)) ctx.state.retrieved.push(p);
    }
    if (packs.length === 0) {
      ctx.emit({
        event: 'notice',
        data: { code: 'KNOWLEDGE_MISS', message: `「${query}」没有检索到依据卡，本轮相关结论按保守路径处理` },
      });
      return ok({ packs: [], note: KNOWLEDGE_MISS_DIRECTIVE });
    }
    // 新卡的 body 原样返回，一个字都不摘要——理由见 retrieval.ts KnowledgePack.body 注释
    return ok({
      packs: packs.map((p) => ({
        id: p.id,
        type: p.type,
        title: p.title,
        region: p.region,
        confidence: p.confidence,
        updated: p.updated,
        ...(alreadyInContext.has(p.id)
          ? { body_omitted: '这张卡的全文已经在你的 system prompt「本轮检索到的依据」里，按 id 往上翻即可，不重复下发。' }
          : { body: p.body }),
      })),
      note: '引用时：法条给条号+逐字原文，判例给案号+来源，数字给值与生效期间；confidence 为「待核实」的必须如实带上这个状态。',
    });
  },

  timeline_add(args, ctx) {
    const happenedAt = isoOrNull(args.happened_at);
    if (!happenedAt) return reject('happened_at 必须是合法 ISO8601 时间串');
    const kind = inEnum(args.kind, cases.TIMELINE_KINDS);
    if (!kind) return reject(`kind 只能是 ${cases.TIMELINE_KINDS.join(' / ')}`);
    const title = str(args.title);
    if (!title) return reject('title 不能为空');

    // 走 lib/cases 而不是直接落库：它带着归属校验与枚举校验，
    // agent 面和网页/MCP 面必须是同一批函数，否则两条入口的行为会悄悄分叉。
    const res = cases.addTimelineEvent(ctx.db, {
      caseId: ctx.caseId,
      userId: ctx.userId,
      happenedAt,
      kind,
      title,
      detail: str(args.detail),
    });
    if (!res.ok) return reject(res.message);
    ctx.emit({ event: 'record', data: { tool: 'timeline_add', id: res.event.id, summary: `${kind}：${title}` } });
    return ok({ id: res.event.id });
  },

  claims_upsert(args, ctx) {
    const kind = inEnum(args.kind, CLAIM_KINDS);
    if (!kind) return reject(`kind 只能是 ${CLAIM_KINDS.join(' / ')}`);
    const amountRaw = Number(args.amount_fen ?? 0);
    if (!Number.isInteger(amountRaw) || amountRaw < 0) return reject('amount_fen 必须是非负整数（单位：分）');

    // 【资金数据不经模型转述】（manager 2026-08-19 项目级范式）
    // N / N+1 / 2N 是**算出来的**数，只能由 claim_calc 直接落库。
    // 放任模型在这里填一个自己算的数，等于给「庭上要被对方复算的金额」开了一条无算式、
    // 无输入快照、无法复算的旁路——而它填错一位没有任何东西拦得住。
    // 其它 kind（欠薪本金、年终奖数额…）是用户陈述的事实而非计算结果，照常允许，
    // 但要求在 calc_json 里写明来源与待证状态。
    if ((CALC_KINDS as readonly string[]).includes(kind) && amountRaw > 0) {
      return reject(
        `${kind} 的金额必须走 claim_calc 计算（它会带算式、输入快照与法条依据直接落库），不要在这里自己填数。` +
          '本工具只用于登记诉求项与补充依据；要改金额请调 claim_calc。',
      );
    }

    const res = store.upsertClaim(ctx.db, {
      caseId: ctx.caseId,
      kind,
      amountFen: amountRaw,
      calcJson: str(args.calc_json),
      basis: str(args.basis),
      status: inEnum(args.status, ['draft', 'confirmed']) ?? 'draft',
    });
    ctx.emit({
      event: 'record',
      data: {
        tool: 'claims_upsert',
        id: res.id,
        summary: amountRaw > 0 ? `诉求 ${kind}：${(amountRaw / 100).toFixed(2)} 元` : `诉求 ${kind}：待计算`,
      },
    });
    return ok({ id: res.id, created: res.created });
  },

  action_card(args, ctx) {
    // 闸门在这里而不在提示词里：第 4 张直接不落库，并把原因回喂让模型自己合并
    if (ctx.state.actionCards >= MAX_ACTION_CARDS) {
      ctx.emit({
        event: 'notice',
        data: { code: 'ACTION_CARD_CAPPED', message: `本轮行动卡已达 ${MAX_ACTION_CARDS} 张上限，多余的卡未采纳` },
      });
      return reject(
        `本轮行动卡已达上限 ${MAX_ACTION_CARDS} 张（charter §2）。不要再调用 action_card；` +
          '如果这一张更重要，请在正文里说明取舍，把最不急的那件留到下一轮。',
      );
    }
    const what = str(args.what);
    const how = str(args.how);
    const why = str(args.why);
    if (!what || !how || !why) return reject('what / how / why 三项都不能为空（charter §2：做什么/怎么做/为什么）');
    const dueAt = isoOrNull(args.due_at);
    if (!dueAt) return reject('due_at 必须是合法 ISO8601 时间串。「今天下班前」也要换算成具体时刻');

    const priority = Number.isInteger(Number(args.priority)) ? Number(args.priority) : 0;
    const detail = `怎么做：${how}\n为什么：${why}`;
    const id = store.insertActionItem(ctx.db, {
      caseId: ctx.caseId,
      title: what,
      detail,
      dueAt,
      priority,
      sourceMessageId: ctx.sourceMessageId,
    });
    ctx.state.actionCards += 1;
    ctx.emit({
      event: 'action',
      data: { id, title: what, detail, due_at: dueAt, priority, index: ctx.state.actionCards },
    });
    return ok({ id, index: ctx.state.actionCards, remaining: MAX_ACTION_CARDS - ctx.state.actionCards });
  },

  emotion_log(args, ctx) {
    const level = inEnum(args.level, EMOTION_LEVELS);
    if (!level) return reject(`level 只能是 ${EMOTION_LEVELS.join(' / ')}`);

    let refer = args.refer_nbdpsy === true;
    let referNote: string | undefined;
    if (refer && (level === '平稳' || level === '低落')) {
      // spec §10 / charter §5：只有持续焦虑抑郁表现才谈转介，情绪一般时提就是趁人之危
      refer = false;
      referNote = '情绪档位未达「焦虑」以上，本次不转介（spec §10 引流红线）。';
    }
    if (refer && store.hasReferredNbdpsy(ctx.db, ctx.caseId)) {
      refer = false;
      referNote = '本案此前已转介过一次，不再重复提示（spec §10：一案最多一次）。';
      ctx.emit({
        event: 'notice',
        data: { code: 'REFERRAL_ALREADY_USED', message: '本案已提示过心理咨询，本次不重复' },
      });
    }

    const id = store.insertEmotionLog(ctx.db, {
      caseId: ctx.caseId,
      level,
      note: str(args.note),
      referredNbdpsy: refer,
    });
    ctx.emit({ event: 'record', data: { tool: 'emotion_log', id, summary: `情绪：${level}` } });
    return ok({ id, referred: refer, ...(referNote ? { note: referNote } : {}) });
  },

  company_profile_upsert(args, ctx) {
    const name = str(args.name);
    if (!name) return reject('name 不能为空');
    const res = store.upsertCompanyProfile(ctx.db, {
      caseId: ctx.caseId,
      name,
      uscc: str(args.uscc),
      role: inEnum(args.role, COMPANY_ROLES) ?? '签约主体',
      legalRep: str(args.legal_rep),
      riskNotes: str(args.risk_notes),
      sourcesJson: str(args.sources) ? JSON.stringify([str(args.sources)]) : null,
    });
    ctx.emit({
      event: 'record',
      data: { tool: 'company_profile_upsert', id: res.id, summary: `公司主体：${name}` },
    });
    return ok({ id: res.id, created: res.created });
  },

  draft_write(args, ctx) {
    const kind = inEnum(args.kind, DRAFT_KINDS);
    if (!kind) return reject(`kind 只能是 ${DRAFT_KINDS.join(' / ')}`);
    const title = str(args.title);
    const content = str(args.content);
    if (!title || !content) return reject('title 与 content 都不能为空');

    // 【案号闸门】文书是要发给公司、要进仲裁卷宗的东西，里面一个编的案号就是事故。
    // 与正文不同，这里**不替它打补丁**：拒收 + 回喂改正指令，让模型自己改对了重写。
    const badCitations = ctx.citations.check(content, `文书《${title}》`);
    if (badCitations.length) {
      ctx.emit({
        event: 'notice',
        data: { code: 'CITATION_BLOCKED', message: `文书里的案号 ${badCitations.join('、')} 知识库中不存在，已拒绝落库` },
      });
      return reject(citationCorrectionDirective(badCitations));
    }

    const consequences = str(args.send_consequences);
    // charter 红线 5：发给公司的文书**必须**附发送后果。缺了就不写库——
    // 这不是提示，是闸门：让模型补齐后重试，而不是我们替它编一段后果说明。
    if (OUTBOUND_DRAFT_KINDS.has(kind) && !consequences) {
      return reject(
        `《${kind}》是要发给公司的文书，charter 红线 5 要求必须同时给出 send_consequences（发出后果说明）。` +
          '请说清：发出后法律关系怎么变、对方可能怎么应对、哪一步是不可逆的，然后重新调用本工具。',
      );
    }

    const body = OUTBOUND_DRAFT_KINDS.has(kind) ? `${content}\n\n${confirmationFooter(consequences!)}` : content;
    // status 恒 draft：本系统不存在「已发出」状态——发不发、什么时候发，只有用户能决定
    const row = store.insertDraft(ctx.db, { caseId: ctx.caseId, kind, title, content: body, status: 'draft' });
    ctx.state.drafts += 1;
    ctx.emit({
      event: 'draft',
      data: { id: row.id, kind, title, version: row.version, requires_confirmation: true },
    });
    return ok({ id: row.id, version: row.version, note: '已存为草稿。正文里必须告诉用户：发不发由他决定，系统不会代发。' });
  },

  intake_done(args, ctx) {
    const summary = str(args.summary);
    if (!summary) return reject('summary 不能为空：写清用户对特殊保护情形答了什么');
    if (!ctx.threadId) return reject('当前会话没有可落痕的线程，无法标记问诊完成');
    store.updateIntakeStage(ctx.db, ctx.threadId, 'done');
    ctx.emit({
      event: 'record',
      data: { tool: 'intake_done', id: ctx.threadId, summary: `首诊清单走完：${summary}` },
    });
    return ok({ intake_stage: 'done' });
  },

  deadline_set(args, ctx) {
    const rule = str(args.rule);
    const anchor = str(args.anchor_date);
    if (!rule || !anchor) return reject('rule 与 anchor_date 都必填');

    let computed: deadline.DeadlineComputation;
    try {
      computed = deadline.computeDeadline(rule, anchor, { days: Number(args.days) });
    } catch (e) {
      return reject(e instanceof Error ? e.message : String(e));
    }

    const row = store.insertDeadline(ctx.db, {
      caseId: ctx.caseId,
      kind: computed.rule.storedKind,
      dueDate: computed.dueDate,
      derivedFrom: computed.derivedFrom,
    });
    ctx.emit({
      event: 'record',
      data: { tool: 'deadline_set', id: row.id, summary: `${computed.rule.label}：${computed.dueDate}` },
    });
    return ok({
      id: row.id,
      due_date: computed.dueDate,
      label: computed.rule.label,
      derived_from: computed.derivedFrom,
      basis: computed.rule.basis,
      caveats: computed.caveats,
      note: '把到期日、推算依据与全部 caveats（尤其「未含节假日顺延」）一起讲给用户，别只报一个日子。',
    });
  },

  deadline_resolve(args, ctx) {
    const id = Number(args.deadline_id);
    if (!Number.isInteger(id) || id <= 0) return reject('deadline_id 必须是正整数');
    // 归属由 case_id 兜底：不是本案的期限一律当不存在
    if (!store.resolveDeadline(ctx.db, ctx.caseId, id)) {
      return reject(`期限 #${id} 不存在、不属于本案，或已经标记过了`);
    }
    ctx.emit({
      event: 'record',
      data: { tool: 'deadline_set', id, summary: `期限 #${id} 已了结${str(args.note) ? `：${str(args.note)}` : ''}` },
    });
    return ok({ id, resolved: true });
  },

  claim_calc(args, ctx) {
    const kind = inEnum(args.kind, CALC_KINDS);
    if (!kind) return reject(`kind 只能是 ${CALC_KINDS.join(' / ')}`);

    const avg = Number(args.avg_monthly_wage_fen);
    if (!Number.isInteger(avg) || avg <= 0) {
      return reject('avg_monthly_wage_fen 必须是正整数（单位：分，且是**应得**工资不是到手工资）');
    }
    const employedFrom = str(args.employed_from);
    const terminatedAt = str(args.terminated_at);
    if (!employedFrom || !terminatedAt) return reject('employed_from 与 terminated_at 都必填，格式 YYYY-MM-DD');

    // 未被显式列为「有证据」的输入一律标 用户自述——charter §3 要求说明哪些输入待证，
    // 默认值往保守那边靠：宁可多标一个待证，也不能让没证据的数字看起来已经坐实。
    const backed = new Set(Array.isArray(args.evidence_backed) ? args.evidence_backed.map(String) : []);
    const sourceOf = (field: string): InputSource => (backed.has(field) ? '证据佐证' : '用户自述');
    const inputSources: Record<string, InputSource> = {
      avgMonthlyWageFen: sourceOf('avg_monthly_wage_fen'),
      employedFrom: sourceOf('employed_from'),
      terminatedAt: sourceOf('terminated_at'),
    };

    let result: calc.CalcResult<object>;
    try {
      if (kind === 'N+1') {
        const lastMonth = Number(args.last_month_wage_fen);
        if (!Number.isInteger(lastMonth) || lastMonth <= 0) {
          return reject('算 N+1 必须给 last_month_wage_fen（解除前最后一个完整工资月的工资标准，单位分）');
        }
        inputSources.lastMonthWageFen = sourceOf('last_month_wage_fen');
        result = calc.calcNPlus1({ avgMonthlyWageFen: avg, employedFrom, terminatedAt, lastMonthWageFen: lastMonth, inputSources });
      } else if (kind === '2N') {
        result = calc.calc2N({ avgMonthlyWageFen: avg, employedFrom, terminatedAt, inputSources });
      } else {
        result = calc.calcN({ avgMonthlyWageFen: avg, employedFrom, terminatedAt, inputSources });
      }
    } catch (e) {
      // 日期非法一类的输入错误：回喂原文让模型改正，不炸掉整轮
      return reject(`计算失败：${e instanceof Error ? e.message : String(e)}`);
    }

    // calc_json 留痕落 claims（charter §3：展示算式与输入）。
    // 由本工具直接落库而不是让模型再调一次 claims_upsert：金额与算式必须同源，
    // 中间隔一次模型转述就有抄错一位的机会，而这个数字要拿到庭上被对方复算。
    const claim = store.upsertClaim(ctx.db, {
      caseId: ctx.caseId,
      kind,
      amountFen: result.amountFen,
      calcJson: JSON.stringify(result),
      basis: result.basis.map((b) => `${b.law}${b.article}`).join('；'),
      status: 'draft',
    });
    ctx.emit({
      event: 'record',
      data: { tool: 'claims_upsert', id: claim.id, summary: `${kind}：${(result.amountFen / 100).toFixed(2)} 元` },
    });

    return ok({
      kind: result.kind,
      amount_fen: result.amountFen,
      amount_yuan: (result.amountFen / 100).toFixed(2),
      formula: result.formula,
      steps: result.steps,
      flags: result.flags,
      basis: result.basis,
      inputs: result.inputs,
      input_sources: inputSources,
      calc_version: result.calcVersion,
      note:
        '展示给用户时必须同时给出 formula 算式与各输入的来源；标「用户自述」的要明说待证据核实。' +
        (result.flags.length ? `本次触发的特殊档位要逐条讲清：${result.flags.join('、')}。` : ''),
    });
  },
};

/** charter §7.5 的固定尾注。措辞写死在代码里，不交给模型每次即兴发挥——
 *  这段话是用户按下「发送」之前看到的最后一道提醒，不能有的轮次强有的轮次弱。 */
function confirmationFooter(consequences: string): string {
  return [
    '────────────────',
    '【发出前必读】',
    `1. 发出后果：${consequences}`,
    '2. 这份文书一旦发出即无法撤回，对方会据此形成书面记录并可能作为证据使用。',
    '3. 发出前请再读一遍全文：核对每个日期、金额与事实描述，删掉任何你并不打算承认的表述。',
    '4. 发不发、什么时候发、用什么方式送达，由**你自己**决定。本系统不会替你发出。',
  ].join('\n');
}

/**
 * 执行一次模型发起的工具调用。
 * 参数解析失败、工具不存在、校验不过——一律**回喂错误让模型改正**，不抛错中断整轮：
 * 用户等在屏幕前，一次参数写错就把整个回复弄丢是不可接受的。
 */
export function executeTool(name: string, rawArguments: string, ctx: AgentToolContext): ToolOutcome {
  const handler = HANDLERS[name];
  if (!handler) return reject(`不存在名为 ${name} 的工具。可用工具：${AGENT_TOOLS.map((t) => t.function.name).join(' / ')}`);

  let args: Record<string, unknown>;
  try {
    args = rawArguments.trim() ? (JSON.parse(rawArguments) as Record<string, unknown>) : {};
  } catch {
    return reject(`${name} 的参数不是合法 JSON，请重新生成`);
  }

  const outcome = handler(args, ctx);
  if (!outcome.ok && name !== 'claim_calc') {
    ctx.emit({ event: 'notice', data: { code: 'TOOL_INPUT_REJECTED', message: `${name}：${outcome.content}` } });
  }
  return outcome;
}
