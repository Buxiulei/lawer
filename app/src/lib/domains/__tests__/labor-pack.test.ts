// 领域包判据：labor 包与它声明的那些东西的**正本**必须是同一份，不是抄来的第二份。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CASE_STAGES } from '@/lib/cases/stages';

import * as knowledge from '@/lib/knowledge';
import { bannedHotlines, crisisHotlines } from '@/lib/agent/crisis-opener';

import { LABOR } from '../labor';
import { DOMAINS, getDomainPack } from '../registry';

const SRC_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)), '..', '..');

describe('labor 领域包', () => {
  it('挂在注册表上，取得到', () => {
    expect(getDomainPack(LABOR.key)).toBe(LABOR);
    expect(DOMAINS[LABOR.key]).toBe(LABOR);
    expect(getDomainPack('没有这个领域')).toBeUndefined();
  });

  /**
   * stages **引用** CASE_STAGES 而不是抄一份。抄一份的形态是：首诊页（客户端引
   * CASE_STAGES）与服务端 stage 校验（读领域包）某天不一致，而两边各自看都正常。
   * `toBe` 而不是 `toEqual`：同一个数组对象才算引用，逐值相等的副本要红。
   */
  it('stages 与 CASE_STAGES 是同一个数组（变异：改成 [...CASE_STAGES] 副本 → 红）', () => {
    expect(LABOR.stages).toBe(CASE_STAGES);
  });

  /**
   * 事实卡渲染器现在**按 key 取抬头**（不再自带中文字面），所以此处比的是
   * 「渲染器用到的键」与「包里声明的键」一一对上。
   * 渲染器多取一个包里没有的键 ⇒ 那一节没有抬头；包里多一个键 ⇒ 有一节永远不渲染。
   * 两个方向都要红。
   */
  it('factsSections 的键与事实卡渲染器取的键一一对上（变异：删包里任一节、或渲染器换一个键 → 红）', () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, 'lib/agent/case-facts.ts'), 'utf-8');
    const used = [...src.matchAll(/heading\(s, '([a-z]+)'\)/g)].map((m) => m[1]);
    // 「当事人」按分支写了多次，去重后比顺序
    const unique = used.filter((k, i) => used.indexOf(k) === i);
    expect(LABOR.factsSections.map((sec) => sec.key)).toEqual(unique);
    expect(unique.length).toBeGreaterThanOrEqual(10); // 空匹配会让上面那条永远绿
  });

  /**
   * 落库的几组种类取的是**已落库那份值集**（migrate.ts 的 DDL 注释）。对着注释比，
   * 免得包里列出一批库里存不进去的种类——那是一份看着像真的假清单。
   *
   * 【为什么 calculatorKinds 不在这里】它是"服务端能替你算的那几项"，与 claims 表能
   * 存哪些 kind 是两件事（算钱器只覆盖其中一部分，另有几项库里根本没有对应值）。
   * 拿 DDL 比它，等于要求「能算的」和「能记账的」永远一样多——那正是本票拆开的那个混淆。
   */
  it('deadlineKinds / docKinds / claimKinds 与 migrate.ts 的 DDL 注释同一份', () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, 'lib/db/migrate.ts'), 'utf-8');
    /** 取某张表 DDL 里 kind 列后面那条 `-- a|b|c` 注释 */
    const kindEnumOf = (table: string): string[] => {
      const from = src.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
      expect(from, `migrate.ts 里找不到表 ${table}`).toBeGreaterThan(-1);
      const block = src.slice(from, src.indexOf(');', from));
      const m = /^\s*kind\s+TEXT NOT NULL,?\s*--\s*(\S+)\s*$/m.exec(block);
      expect(m, `${table} 的 kind 列后面没有 \`-- a|b|c\` 值集注释`).not.toBeNull();
      return m![1].split('|');
    };
    expect(LABOR.deadlineKinds).toEqual(kindEnumOf('deadlines'));
    expect(LABOR.docKinds).toEqual(kindEnumOf('drafts'));
    expect(LABOR.claimKinds).toEqual(kindEnumOf('claims'));
  });

  /**
   * 算钱器与诉求种类**刻意不同**。这条不是在钉具体取值（那由零变化守卫钉），
   * 是在钉「它们不是同一份」这件事——两者一旦被谁改成同一个数组，
   * 本票修掉的那个缺陷就会原样长回来（粘贴回填按算钱器校验诉求种类，
   * 「欠薪」一类根本落不进去，而回包结构完全正常）。
   */
  it('calculatorKinds 与 claimKinds 是两份不同的清单（变异：把其中一处改成引用另一处 → 红）', () => {
    expect(LABOR.calculatorKinds).not.toEqual(LABOR.claimKinds);
    // 各自都有对方没有的项，说明"重叠但不相等"，而不是一个包含另一个
    expect(LABOR.claimKinds.filter((k) => !LABOR.calculatorKinds.includes(k)).length).toBeGreaterThan(0);
    expect(LABOR.calculatorKinds.filter((k) => !LABOR.claimKinds.includes(k)).length).toBeGreaterThan(0);
  });

  /** 对外文书必须是文书种类的子集（否则那道「少了发送后果就拒收」的闸永远命不中） */
  it('outboundDocKinds ⊆ docKinds', () => {
    for (const k of LABOR.outboundDocKinds) expect(LABOR.docKinds).toContain(k);
  });

  /**
   * 低调模式的兜底措辞里不许出现本领域一眼能认出来的词。
   * 这条以前只是 bootstrap.ts 里的一句注释（「硬规则：不得出现『裁员』『仲裁』…」），
   * 靠人记得；现在词表在包里、比对在这里。
   */
  it('NEUTRAL 词典不含本领域的显眼词（变异：把 title 改成带「仲裁」的词 → 红）', () => {
    const { title, appTitle, notice, forbiddenWords } = LABOR.copy.neutral;
    expect(forbiddenWords.length).toBeGreaterThan(0);
    for (const word of forbiddenWords) {
      for (const text of [title, appTitle, notice]) expect(text).not.toContain(word);
    }
  });

  /** 首诊落期限的那条规则必须落在自己的词表里，否则那条期限存不进库而首诊照常成功 */
  it('intakeLimitation 的 kind 与 stages 都在本领域词表里', () => {
    const lim = LABOR.intakeLimitation!;
    expect(LABOR.deadlineKinds).toContain(lim.kind);
    for (const st of lim.stages) expect(LABOR.stages).toContain(st);
    expect(lim.note).toContain('{anchor}'); // 占位符没了 = 锚点日不会被写进去
  });

  /** 本领域主线线性，没有并行轨——空数组是结论，`undefined` 才是漏填 */
  it('tracks 是空数组（不是 undefined）', () => {
    expect(LABOR.tracks).toEqual([]);
  });

  /**
   * 【危机窗内那句话里的号码，与本领域资源卡上的号码不许分叉】
   *
   * repeatCardNote 是从 lib/agent/prompt.ts（共用层）搬过来的（设计稿 §13-6），
   * 搬家这一票**一个字都没改**，所以这一版仍把三个号码写在句子里、不看传进来的入参。
   * 于是多出一条只有判据看得见的风险：**卡上换了号，这句话不会跟着变**——
   * 危机窗内模型照着一个我们自己写下的过期号码重述，而卡与代码各自看都完全正常。
   *
   * 这条就钉这件事：卡上每一个**可用**号码都必须出现在这句话里。
   * （反方向不钉：句子里多一个卡上没有的号码由下一条钉，两件事分开报才知道该改哪边。）
   */
  it('危机窗内那句话里的号码 == 本领域资源卡上的可用号码（变异：卡上换个号 / 句子里改一位 → 红）', () => {
    const card = knowledge.get(LABOR.crisis.resourcePackId);
    expect(card, `资源卡 ${LABOR.crisis.resourcePackId} 取不到`).toBeDefined();
    const usable = crisisHotlines(card!.facts).map((h) => h.phone);
    expect(usable.length, '卡上一个可用号码都没有 ⇒ 下面的循环恒真').toBeGreaterThan(0);
    const note = LABOR.crisis.repeatCardNote(usable);
    for (const phone of usable) {
      expect(note, `资源卡上的 ${phone} 没有出现在危机窗内那句话里`).toContain(phone);
    }
  });

  it('那句话里也没有卡上不认的号码（含卡上标 forbidden 的那些）', () => {
    const card = knowledge.get(LABOR.crisis.resourcePackId)!;
    const usable = new Set(crisisHotlines(card.facts).map((h) => h.phone));
    const note = LABOR.crisis.repeatCardNote([...usable]);
    // 句子里出现的每一串「像电话号码」的东西，都必须是卡上可用的那几个之一
    for (const found of note.match(/\d[\d-]{4,}/g) ?? []) {
      expect(usable, `危机窗内那句话里出现了资源卡不认的号码 ${found}`).toContain(found);
    }
    for (const banned of bannedHotlines(card.facts)) {
      expect(note, `危机窗内那句话里出现了卡上标 forbidden 的号码 ${banned}`).not.toContain(banned);
    }
  });
});
