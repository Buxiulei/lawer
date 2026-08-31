// app/src/app/api/v1/cases/route.ts
// GET 名下案件清单，新的在前。「我的案件」到底指哪一个，只由这条接口回答。
//
// 【为什么不经 lib/cases】那一层的职责是「这个案件是不是这个用户的」（assertOwned）；
// 这条查询的条件本身就是 user_id，调用方递不进别人的 id，没有可把的关。
//
// 【空清单是答案，不是错】名下确实没有案件的账号存在（注册中途断了、数据迁移过来的），
// 回 200 + cases: [] 让前端能区分「查不到」和「查了，是空的」——
// 前者该重试，后者该去建档。混成一种，页面就只能猜，猜的结果就是拿演示数据顶。
import { NextResponse } from 'next/server';

import { requireIdentity } from '@/lib/auth/guard';
import { listCasesByUser } from '@/lib/db/cases';
import { getDb } from '@/lib/db/client';

export async function GET(req: Request) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  if (!guard.ok) return guard.response;

  const rows = listCasesByUser(getDb(), guard.identity.uid);
  return NextResponse.json({
    ok: true,
    cases: rows.map((row) => ({
      id: row.id,
      title: row.title,
      stage: row.stage,
      created_at: row.created_at,
    })),
  });
}
