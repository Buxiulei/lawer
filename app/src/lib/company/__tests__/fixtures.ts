// app/src/lib/company/__tests__/fixtures.ts
// 档案管线测试的共用夹具。**一律用真迁移建库**（不手搓表结构）——
// 教训「判据夹具绝对路径」：夹具自己造一份表结构，验的就不是产线那份表了。
import Database from 'better-sqlite3';

import { runMigrations } from '../../db/migrate';
import { createDossier } from '../dossier';

export function newDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** phone_hash 有唯一索引，默认值随行数递增——同一份库里建第二个用户不该炸在夹具上。 */
export function mkUser(db: Database.Database, phoneHash?: string): number {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  return Number(
    db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run(phoneHash ?? `h-${n + 1}`)
      .lastInsertRowid,
  );
}

export function mkCase(db: Database.Database, userId: number): number {
  return Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(userId, '测试案件')
      .lastInsertRowid,
  );
}

export function mkProfile(db: Database.Database, caseId: number, name = '某某科技有限公司'): number {
  return Number(
    db.prepare('INSERT INTO company_profiles (case_id, name) VALUES (?,?)').run(caseId, name)
      .lastInsertRowid,
  );
}

/** 建一条「用户→案件→主体→档案」的完整链，测试里最常用的起点。 */
export function mkChain(
  db: Database.Database,
  name = '某某科技有限公司',
): { userId: number; caseId: number; profileId: number; dossierId: number } {
  const userId = mkUser(db);
  const caseId = mkCase(db, userId);
  const profileId = mkProfile(db, caseId, name);
  const dossierId = createDossier(db, { name, orderedByUserId: userId }).id;
  return { userId, caseId, profileId, dossierId };
}

export interface DocSeed {
  case_no: string;
  has_fulltext?: 0 | 1;
  summary?: string | null;
  outcome?: string | null;
  applicant_side?: string | null;
  stage?: string | null;
  filed_at?: string | null;
  judged_at?: string | null;
  fetched_at?: string | null;
}

/** 直接塞一行判例（绕开 ingest，让统计/归纳的测试只测自己那一层）。 */
export function seedDoc(
  db: Database.Database,
  profileId: number,
  dossierId: number,
  d: DocSeed,
): void {
  db.prepare(
    `INSERT INTO company_litigation
       (company_profile_id, dossier_id, case_no, has_fulltext, summary, outcome,
        applicant_side, stage, filed_at, judged_at, fetched_at, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    profileId,
    dossierId,
    d.case_no,
    d.has_fulltext ?? 0,
    d.summary ?? null,
    d.outcome ?? null,
    d.applicant_side ?? null,
    d.stage ?? null,
    d.filed_at ?? null,
    d.judged_at ?? null,
    d.fetched_at ?? '2026-08-28',
    '裁判文书网·人机接力取证',
  );
}
