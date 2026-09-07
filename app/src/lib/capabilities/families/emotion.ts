// app/src/lib/capabilities/families/emotion.ts
// I 族：情绪与危机（设计稿 §2 I）。记一笔情绪 + 危机词表检查。
//
// 【转介的两道频控不在这里判】它们在 lib/cases.logEmotion 里，与站内对话同一个函数：
// 频控写两份的形态是，站内那条路守着「一案最多一次」，用户自己的 agent 这条路每轮都提，
// 而两边看起来都在守规矩。危机这条同理：词表、首段、留痕三样都调既有的那一份。
import * as agent from '@/lib/agent';
import * as cases from '@/lib/cases';
import { recordCrisisHit } from '@/lib/cases/crisis-hits';
import { findOwnedCase } from '@/lib/db/cases';
import { domainPackOrDefault } from '@/lib/domains/registry';

import { bannedPhones, redactBanned } from './knowledge';
import { caseIdProp, num, writeOnce } from '../shared';
import type { Capability } from '../registry';

export const emotionLog: Capability = {
  name: 'emotion_log',
  family: 'emotion',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  idempotency: { clientRef: true },
  title: '记录情绪状态',
  description:
    '记一笔用户当前的情绪档位。识别到低落/焦虑/严重痛苦时都要记——这是长期陪跑看走向的依据，' +
    '不是评价。refer_nbdpsy 只在符合持续焦虑抑郁表现时置 true：档位没到「焦虑」以上、' +
    '或这个案子此前已经转介过一次，服务端都会把它降回 false 并在返回里说明原因（记录照常落库）。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      level: { type: 'string', enum: [...cases.EMOTION_LEVELS], description: '情绪档位' },
      note: { type: 'string', description: '判断依据：用户说了什么（引原话片段）' },
      refer_nbdpsy: { type: 'boolean', description: '本次是否转介心理咨询，默认 false；一个案子最多一次' },
      client_ref: {
        type: 'string',
        description: '幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库',
      },
    },
    required: ['case_id', 'level'],
  },
  run: (db, identity, args) => {
    const caseId = num(args.case_id);
    return writeOnce(
      db,
      { caseId, tool: 'emotion_log', clientRef: args.client_ref, keyId: identity.keyId ?? null },
      () =>
        cases.logEmotion(db, {
          caseId,
          userId: identity.uid,
          level: args.level,
          note: args.note,
          referNbdpsy: args.refer_nbdpsy,
        }),
      (res) => ({ table: 'emotion_log', id: res.id }),
    );
  },
};

/**
 * 危机词表检查（设计稿 §2 I / §4.4）。
 *
 * 【为什么它必须存在于 MCP 面上】危机拦截此前只在站内 chat 那条路上生效（盘点缺口 9）。
 * 用户自己的 agent 那条路上，同一句话过去什么都不会发生——号码不会出现，
 * 留痕不会有，事实卡首行也不会知道。这条工具把那道闸补到对方那一侧：
 * 陪跑指南规定用户每条消息先过它，命中则把 first_segment **原样照抄**在最前面。
 *
 * 【为什么不复制一份词表】词表、否定语境、首段骨架、热线取数，全部调 lib/agent/crisis 的
 * 同一份实现。抄第二份的形态是：两份词表一起活着、慢慢分叉，于是同一句话在网页上触发、
 * 在用户助手里不触发——而两边都跑得通、都不报错。判据钉着这一条（同源守卫）。
 *
 * 【无案也能调】一个还没建档的人也可能正处在那一刻。case_id 是可选的，
 * 给了且是本人的案子才把这一行绑上去；不是本人的（或不存在）不报错、按无案记，
 * 回包里的 case_id 如实写 null——**安全关键路径上不能因为一个填错的编号就不给号码**。
 */
export const crisisCheck: Capability = {
  name: 'crisis_check',
  family: 'emotion',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  title: '危机信号检查',
  description:
    '把用户刚说的这句话原样传进来，服务端用确定性词表判有没有自伤/求死表述。' +
    'hit=true 时**必须把 first_segment 一字不改地放在你这一轮回复的最前面**，' +
    '然后再说别的——它里面是可以立刻拨打的号码，不要改写、不要缩写、不要挪到末尾。' +
    'hotlines 是同一批号码的结构化版本，只用于你自己核对，不要另外编号码。' +
    'hit=false 时什么都不用做，正常回答即可。',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '用户这条消息的**原文**，不要转述、不要摘要' },
      case_id: { type: 'integer', description: '有案子就带上，命中会记进这个案子的危机留痕；没有就不传' },
    },
    required: ['text'],
  },
  run: (db, identity, args) => {
    const text = typeof args.text === 'string' ? args.text : '';
    if (!text.trim()) {
      return {
        ok: false as const,
        status: 400,
        errorCode: 'INVALID_TEXT',
        message: 'text 不能为空：把用户这条消息的原文原样传进来，不要转述',
      };
    }

    // 【归属查询挪到判定之前，2026-09-06】危机词表与首段按**这个案件所属领域**取，
    // 而词表在判定那一刻就要用上——判完再查等于用缺省领域的词表判了一个别的领域的人：
    // 那句话不在缺省词表里，于是这一次调用什么都没发生，回包结构完全正常。
    // 归属对不上仍按无案处理（不报错、不追问，按缺省领域判）：
    // **安全关键路径上不能因为一个填错的编号就不给号码。**
    const asked = num(args.case_id);
    const owned =
      Number.isInteger(asked) && asked > 0
        ? findOwnedCase(db, asked, identity.uid)
        : undefined;
    const caseId = owned ? owned.id : null;
    const crisisPack = domainPackOrDefault(owned?.domain).crisis;

    const assessment = agent.assessCrisis(text, crisisPack);
    if (!assessment.triggered) {
      return {
        hit: false,
        must_say_first: false,
        first_segment: null,
        hotlines: [],
        case_id: null,
        note: '这句话没有命中危机词表，照常回答就行。',
      };
    }

    // 命中即留痕，走与站内对话同一个入口（lib/cases/crisis-hits.ts）。
    recordCrisisHit(db, { userId: identity.uid, caseId, source: 'mcp', matched: assessment.matched });

    // 【domain: null = 不过领域闸】id 来自上面那个领域包自己的 crisis.resourcePackId。
    // 少这个 null 的形态是：词表按本领域命中了、卡却按缺省域去取，于是 hotlines 回空数组、
    // first_segment 里一个号码都没有，而 hit=true、HTTP 200、没有一处报错——
    // 一个正在处置危机的人拿到的是一段空指引。
    const card = agent.createKnowledgeSearcher().get?.(crisisPack.resourcePackId, { domain: null });
    // 跨库禁用名单再过一道：卡自己声明的 forbidden 由 crisisHotlines 滤掉，
    // 别处声明为禁用的同一个号码由这一道滤掉（设计稿 §4.4：任何回包里都不得出现）。
    const banned = new Set(bannedPhones());
    const usable = agent.crisisHotlines(card?.facts).filter((h) => !banned.has(h.phone));
    // buildCrisisOpener 读的是卡的 facts；这里把已被跨库名单滤掉的那些也从 facts 里拿掉，
    // 免得首段与 hotlines 两处给的号码不是同一批（两处各算一次就会分叉）。
    const firstSegment = redactBanned(agent.buildCrisisOpener({ hotlines: usable }, {}, crisisPack));

    return {
      hit: true,
      must_say_first: true,
      first_segment: firstSegment,
      hotlines: usable.map((h) => ({
        phone: h.phone,
        name: h.name,
        hours: h.hours,
        note: h.note,
        landline_only: agent.isLandlineOnly(h.phone),
      })),
      case_id: caseId,
      note:
        usable.length > 0
          ? 'first_segment 一字不改放在回复最前面，说完它再说别的。'
          : '资源卡里此刻没有可用号码（安全关键资料缺失，已记录）。不要自己编号码，' +
            '如实告诉用户你手上没有可用号码，并请他直接拨打当地急救电话或找身边的人。',
    };
  },
};
