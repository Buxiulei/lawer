// app/src/app/api/v1/tools/[name]/route.ts
// POST /api/v1/tools/{name} —— 通用工具桥：注册表里 exposeTo 含 mcp 的能力，
// 不支持 MCP 的客户端从这里按同样的入参调，请求体就是该能力 inputSchema 的入参 JSON。
//
// 【为什么是「桥」不是又一套端点】判定（暴露面、scope、前置闸、失败归一）全在
// lib/capabilities/invoke.ts，与 MCP 那条路调的是同一份。这里只做 HTTP 外壳：
// 取路径段、读 body、把结果渲染成 { ok, ... } / { ok:false, error_code, message }。
// 在这里补写任何一句判定，就等于给同一条能力立了第二套规矩——而两套都不会报错。
import { NextResponse } from 'next/server';

import { resolveIdentity } from '@/lib/auth/identity';
import { invokeCapability } from '@/lib/capabilities/invoke';
import { getDb } from '@/lib/db/client';

export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const identity = resolveIdentity(getDb(), req.headers);
  if (!identity) {
    return NextResponse.json(
      { ok: false, error_code: 'UNAUTHORIZED', message: '缺少或无效的凭据' },
      { status: 401 },
    );
  }

  // 空 body 等同 {}：无入参的能力（如 case_list）不该逼调用方发一个 "{}" 才认。
  // 但「发了东西却不是 JSON 对象」是真错，不能悄悄当成无入参跑一遍。
  const raw = (await req.text()).trim();
  let args: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
      args = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { ok: false, error_code: 'INVALID_BODY', message: '请求体要是该能力入参的 JSON 对象；无入参可以不发 body' },
        { status: 400 },
      );
    }
  }

  const outcome = await invokeCapability(getDb(), identity, (await params).name, args);
  if (!outcome.ok) {
    return NextResponse.json(
      { ok: false, error_code: outcome.errorCode, message: outcome.message },
      { status: outcome.status },
    );
  }
  // 能力回包原样摊平，与 MCP tools/call 拿到的那份逐字相同（那边只是多包了一层文本外壳）
  return NextResponse.json({ ok: true, ...outcome.value });
}
