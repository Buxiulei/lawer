// scripts/approve-passport-realname.ts
// 护照实名的人工审核台。用法：
//   cd app && npx tsx ../scripts/approve-passport-realname.ts --id 3                        # 干跑，只打印
//   cd app && npx tsx ../scripts/approve-passport-realname.ts --id 3 --operator 张三 --apply
//   cd app && DB_PATH=/x/y.db npx tsx ../scripts/approve-passport-realname.ts --id 3 ... --apply
//
// 【为什么是脚本不是端点】实名是身份断言，写它是生产手术。
// 管理后台建成之前，「审核台」= 这个脚本 + 人的眼睛 + 落进流水的留痕；
// 管理后台以后接的就是 approvePassportRealname 这套语义，不必重新定义。
//
// 【默认干跑】同 backfill 的纪律：改身份状态必须是**显式**要求的那一次。
// 干跑打印的是 planPassportApproval 的结果——**与真执行同一个函数**，
// 不是另算一遍给人看的预览（那种预览会和真执行分叉，而没人会发现）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { approvePassportCli } from '../app/src/lib/auth/passport-realname';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? path.join(HERE, '..', 'app', 'data', 'lawer.db');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const id = Number(arg('id'));
if (!Number.isInteger(id) || id <= 0) {
  console.error('用法：--id <流水号> [--operator <审核人>] [--note <备注>] [--apply]');
  process.exit(2);
}

process.exit(
  approvePassportCli(DB_PATH, {
    verificationId: id,
    operator: arg('operator'),
    note: arg('note'),
    apply: process.argv.includes('--apply'),
  }),
);
