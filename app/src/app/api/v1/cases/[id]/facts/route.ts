// app/src/app/api/v1/cases/[id]/facts/route.ts
// GET 读案件事实卡（对应 MCP 工具 case_facts）。
//
// 【为什么补这条 REST】只走 REST 的客户端（ChatGPT Custom GPT Actions、自建脚本）
// 此前拿不到事实卡——那是「回答任何案情问题之前先调它」的那一件。缺了它，
// 这类客户端只能自己把档案各表拼一遍，拼出来的与站内每轮看到的不是同一份。
// 渲染与裁剪一律回到注册表那一条能力，本路由不碰业务。
import { NextResponse } from 'next/server';

import { parseId } from '@/lib/auth/guard';
import { runCapabilityRest } from '@/lib/capabilities/rest-runner';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const caseId = parseId((await params).id);
  if (caseId === null) {
    return NextResponse.json(
      { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' },
      { status: 404 },
    );
  }
  return runCapabilityRest(req, 'case_facts', { case_id: caseId });
}
