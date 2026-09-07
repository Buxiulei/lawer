// app/src/lib/domains/__tests__/default-domain-ddl.test.ts
// 缺省领域这一个值，三处必须同值：**建表时落进存量行的那个**、**代码里的 DEFAULT_DOMAIN**、
// **知识卡没声明 domain 时算出来的那个**。
//
// 【为什么补这条判据】DEFAULT_DOMAIN（lib/domains/registry.ts）是本支新加的常量，
// 它的文档注释写着"取值与 lib/db/migrate.ts 给 cases.domain 的 DDL 默认值同源"，
// 而这句话**此前只是一句注释**：两处分叉时没有任何一处会报错。
// 分叉后的形态（注释自己描述的那个）：同一个存量案件按 A 包校验阶段、按 B 域检索知识——
// 阶段校验回 200、检索回 200 与一个"看起来正常、只是短一点"的列表，
// 而那个案子从此拿不到自己那批卡。闸要写在判据里，不写在注释里。
//
// 【为什么读的是真跑过迁移的库，不是 migrate.ts 的源码文本】要盯的是**落到存量行上的那个值**。
// 按源码文本比对的形态是：哪天默认值改由别的语句给（触发器、后续 UPDATE、建表语句重写），
// 文本比对照样绿，而行里的值早就换了。
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from '@/lib/db/migrate';
import { DEFAULT_DOMAIN, getDomainPack } from '@/lib/domains/registry';
import { packDomain } from '@/lib/knowledge';

/** 建一个跑过全部迁移的空库，插一条**不写 domain** 的案件（= 存量案件的形状），回它落库的 domain */
function domainOfLegacyCase(): string {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const uid = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('h').lastInsertRowid);
    const caseId = Number(
      db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(uid, '存量案件').lastInsertRowid,
    );
    const row = db.prepare('SELECT domain FROM cases WHERE id = ?').get(caseId) as { domain: string };
    return row.domain;
  } finally {
    db.close();
  }
}

describe('缺省领域三处同值（变异：改 migrate.ts 的 DDL 默认值或改 DEFAULT_DOMAIN → 红）', () => {
  it('判据自身不空跑：没写 domain 的案件确实被补上了一个非空的域', () => {
    // 【为什么先要这一条】哪天 cases.domain 变成可空、或那句 addColumnIfMissing 被删，
    // 取回来的会是 null/undefined；下面两条若只写 `toBe(DEFAULT_DOMAIN)`，
    // 红是会红，但红的理由会被读成"默认值改了"，而真相是这一列没了。
    const stored = domainOfLegacyCase();
    expect(typeof stored, 'cases.domain 没有落到存量行上 ⇒ 下面两条测的不是同值，是这一列在不在').toBe(
      'string',
    );
    expect(stored.length).toBeGreaterThan(0);
  });

  it('库里落给存量案件的域 === 代码里的 DEFAULT_DOMAIN', () => {
    expect(
      domainOfLegacyCase(),
      '建表默认值与 DEFAULT_DOMAIN 分叉了：存量案件会按前者校验阶段、按后者检索知识，两边都回 200。' +
        '改了其中一个就要同时改另一个（lib/db/migrate.ts 的 cases.domain 一行 / lib/domains/registry.ts 的 DEFAULT_DOMAIN）。',
    ).toBe(DEFAULT_DOMAIN);
  });

  it('知识卡没声明 domain 时算出来的域，也是同一个值', () => {
    // 检索侧的缺省来自 lib/knowledge 的 packDomain / loadIndex 补齐。它与案件侧的缺省
    // 分叉的形态是：存量案件属于 A 域，而存量卡片全被算成 B 域 ⇒ 那个案子检索回空列表 + 200。
    expect(
      packDomain({}),
      '知识侧的缺省域与案件侧的缺省域分叉了 ⇒ 存量案件检索自己那批存量卡会回空列表，而回包 200',
    ).toBe(domainOfLegacyCase());
  });

  it('这个缺省值指向一个**真的挂上了**的领域包，不是一个谁也不认识的字符串', () => {
    // 【为什么这条不能省】上面三条只保证三处"一样"。三处一起改成同一个错字同样全绿，
    // 而那时每一个案件的阶段校验都会取不到包。
    expect(
      getDomainPack(domainOfLegacyCase()),
      `缺省域「${domainOfLegacyCase()}」在 lib/domains 的 DOMAINS 里没有对应的包`,
    ).toBeDefined();
  });
});
