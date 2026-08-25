/**
 * 【空手感知】判据是「卡够不够格」，不是「有没有卡」。
 *
 * 这一组测试守的核心是：**尘埃形态下 `packs.length` 不为 0，所以旧判据永远不触发**。
 * 真实形态（deployer 实测）：query「上海高温津贴标准」捞到 6 张北京的卡，
 * 没有一张与上海或高温津贴有关，而 notice 帧数 = 0——用户拿到的是一份
 * **看起来有依据、实际全无关**的回答，这比明说"没查到"危险得多。
 */
import { describe, expect, it } from 'vitest';

import { countSubstantiveHits, isSubstantiveHit } from '@/lib/knowledge';

import { buildSystemPrompt, EMPTY_PACK_DIRECTIVE } from '../prompt';
import { loadCaseSnapshot } from '../snapshot';
import { FIXTURE_PACK, makeAgentFixture } from './fixtures';

/** 与真实尘埃形态同构：卡是北京的、query 问的是上海高温津贴 */
const DUST = [
  { keywords: ['失业保险金', '领取条件'], applies_to: ['失业保险'] },
  { keywords: ['最低工资', '北京'], applies_to: ['工资标准'] },
  { keywords: ['生育津贴'], applies_to: ['生育保险'] },
];
const DUST_QUERY = '上海高温津贴标准';

describe('实质命中判定：卡够不够格，而不是有没有卡', () => {
  it('尘埃形态：捞到 3 张但一张都不沾边 → 实质命中 0（而 length 是 3，旧判据不会触发）', () => {
    expect(DUST.length).toBeGreaterThan(0); // 先自证"有卡"——这正是旧判据看到的东西
    expect(countSubstantiveHits(DUST, DUST_QUERY)).toBe(0);
  });

  it('keyword 沾边即算实质命中', () => {
    expect(isSubstantiveHit({ keywords: ['高温津贴'], applies_to: [] }, DUST_QUERY)).toBe(true);
  });

  it('applies_to 沾边即算实质命中', () => {
    expect(isSubstantiveHit({ keywords: [], applies_to: ['高温津贴'] }, DUST_QUERY)).toBe(true);
  });

  it('长度 1 的 keyword 不算命中（与检索打分同一条 MIN_KEYWORD_LEN 规则）', () => {
    expect(isSubstantiveHit({ keywords: ['N'], applies_to: [] }, '经济补偿 N 怎么算')).toBe(false);
  });
});

describe('空包告知指令：只在空包轮出现，且禁令配出路', () => {
  const { db, caseId } = makeAgentFixture();
  const snapshot = loadCaseSnapshot(db, caseId);
  const build = (emptyPack: boolean) =>
    buildSystemPrompt({ snapshot, mode: '问诊', stage: 'done', packs: [], now: new Date('2026-08-25T10:00:00+08:00'), emptyPack });

  it('空包轮：指令进 system prompt', () => {
    expect(build(true)).toContain('【本轮无可引用依据】');
  });

  it('★非空包轮：指令**不得**出现（条件触发不常驻——常驻会把模型训练成什么都不答）', () => {
    expect(build(false)).not.toContain('【本轮无可引用依据】');
  });

  it('★禁令必须配出路：只禁不给替代时，模型只剩编造或沉默两条路', () => {
    // 光有"不要给条号/数字"是不够的，四条可做的事必须同时在场
    expect(EMPTY_PACK_DIRECTIVE).toContain('**不要**给出法条条号');
    expect(EMPTY_PACK_DIRECTIVE).toContain('**可以并且应该**做这些事');
    expect(EMPTY_PACK_DIRECTIVE).toContain('复述确认');
    expect(EMPTY_PACK_DIRECTIVE).toContain('问清楚下一步判断必需的事实');
    expect(EMPTY_PACK_DIRECTIVE).toContain('不依赖具体条文');
    expect(EMPTY_PACK_DIRECTIVE).toContain('我先去核实依据再回答你');
  });

  it('★禁令带理由，而不是光下命令（边界情形靠理由才知道往哪边靠）', () => {
    expect(EMPTY_PACK_DIRECTIVE).toContain('用户都会拿去谈判或写进申请书');
  });

  it('★期限例外：不许用相对时间糊弄，必须"明说要核实"+"按最紧期限准备"两件一起给', () => {
    expect(EMPTY_PACK_DIRECTIVE).toContain('这个期限我必须核实准确了再答');
    expect(EMPTY_PACK_DIRECTIVE).toContain('按最紧的可能期限准备');
    // 理由必须在场：超期不可逆，而提前准备的代价只是白忙
    expect(EMPTY_PACK_DIRECTIVE).toContain('超期是不可逆的');
  });

  it('★指令排在依据纪律之前（放后面会被"法条给条号+逐字原文"稀释成并列建议）', () => {
    // 必须带一张卡：packs 为空时依据纪律那段根本不存在，indexOf 返回 -1，
    // 于是"小于"这个比较会拿 -1 作参照——**测试看起来在比顺序，其实在比一个不存在的东西**。
    const p = buildSystemPrompt({
      snapshot, mode: '问诊', stage: 'done', packs: [FIXTURE_PACK],
      now: new Date('2026-08-25T10:00:00+08:00'), emptyPack: true,
    });
    const directiveAt = p.indexOf('【本轮无可引用依据】');
    const disciplineAt = p.indexOf('引用纪律：法条给条号');
    expect(directiveAt).toBeGreaterThanOrEqual(0);
    expect(disciplineAt).toBeGreaterThanOrEqual(0); // 先自证两个锚点都真的在
    expect(directiveAt).toBeLessThan(disciplineAt);
  });
});
