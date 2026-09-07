// app/src/app/(app)/intake/__tests__/handwritten-dispatch.test.ts
// 拼请求体那条分流问的是**「这个领域有没有手写稿」**，不是「是不是缺省领域」。
//
// ─────────────── 为什么这一条必须单独存在 ───────────────
// 首诊有两条路：有手写向导的领域走那份稿子（答案落在 draft 上那些手写字段），
// 没有的按 intakeSchema 排步（答案落在 draft.fields）。**排步**与**拼请求体**
// 是隔着文件的两个读者：前者在 IntakeFlow 的 HANDWRITTEN_FLOWS，后者在 submit。
// 两边各判一次的形态是——第二个领域将来也有人给它写了向导，页面按那份稿子问、
// submit 按 schema 拼，请求体里**每一格都是空的**，而服务端照收、回包 201、
// 页面照常跳进驾驶舱，一处报错都没有。
//
// 【为什么它在别处验不出来】今天注册表里唯一有手写稿的领域**恰好就是缺省领域**，
// 两种判法给出同一个答案，于是这个错误在全部既有判据下都是绿的。
// 这里把那份名单换成「有手写稿的是另一个领域」，两种判法当场分道扬镳。
//
// 【为什么单独一个文件】vi.mock 作用于整个文件，与别的判据同住会把它们一起改口径。
import { describe, expect, it, vi } from 'vitest';

import type { DomainPack } from '@/lib/domains/registry';

/** 有手写稿的那个领域——**故意不是缺省领域**，两种判法的差别全在这里。 */
const FAKE_KEY = '假领域';

vi.mock('../_components/schemaFlow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_components/schemaFlow')>();
  // 只换「哪些领域有手写稿」这一份名单，schemaPayload 等其余导出照旧是真身
  return { ...actual, HANDWRITTEN_DOMAINS: [FAKE_KEY], hasHandwrittenFlow: (k: string) => k === FAKE_KEY };
});

const { EMPTY_DRAFT } = await import('../_components/draft');
const { toIntakePayload } = await import('../_components/submit');
const { DOMAINS, DEFAULT_DOMAIN } = await import('@/lib/domains/registry');

/** 一份**只填了手写那几格**的草稿：schema 那条路读的 fields 是空的，两条路的产物一眼可辨。 */
const DRAFT = { ...EMPTY_DRAFT, companyName: '对面那一方' };

const fakePack = { key: FAKE_KEY, intakeSchema: [] } as unknown as DomainPack;

describe('首诊请求体：走手写映射还是走 schema，认的是那份名单', () => {
  it('名单里的领域 → 手写映射（变异：把 submit 的分流改回 `pack.key !== DEFAULT_DOMAIN` → 红）', () => {
    expect(
      toIntakePayload(DRAFT, fakePack).company_name,
      '有手写稿的领域被按 schema 拼了请求体：用户填的每一格都没交上去，而回包照常 201',
    ).toBe('对面那一方');
  });

  it('不在名单里的领域 → schema（同一次变异下这条也红：它会退回手写映射）', () => {
    const body = toIntakePayload(DRAFT, DOMAINS[DEFAULT_DOMAIN]);
    // schemaPayload 读的是 draft.fields（这份草稿里是空的），手写那几格一格都不该出现
    expect(
      body.company_name,
      '没有手写稿的领域却按手写映射拼：它的用户答在 draft.fields 里的每一格都丢了',
    ).not.toBe('对面那一方');
    // 正对照：这一趟确实拼出了东西（两条路都产出空对象时上面那句同样会绿）
    expect(Object.keys(body).length).toBeGreaterThan(0);
  });
});
