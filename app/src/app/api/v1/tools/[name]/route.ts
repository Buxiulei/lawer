// app/src/app/api/v1/tools/[name]/route.ts
// POST /api/v1/tools/{name} —— 通用工具桥：注册表里 exposeTo 含 mcp 的能力，
// 不支持 MCP 的客户端从这里按同样的入参调，请求体就是该能力 inputSchema 的入参 JSON。
//
// 【为什么是「桥」不是又一套端点】判定（暴露面、scope、前置闸、失败归一）全在
// lib/capabilities/invoke.ts，与 MCP 那条路调的是同一份。这里只做 HTTP 外壳：
// 取路径段、读 body、把结果渲染成 { ok, ... } / { ok:false, error_code, message }。
// 在这里补写任何一句判定，就等于给同一条能力立了第二套规矩——而两套都不会报错。
import { resolveIdentity } from '@/lib/auth/identity';
import { invokeCapability } from '@/lib/capabilities/invoke';
import { recordCapabilityWrite } from '@/lib/capabilities/ledger';
import { getCapability } from '@/lib/capabilities/registry';
import { getDb } from '@/lib/db/client';
import { apiJson } from '@/lib/http/json';

export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const identity = resolveIdentity(getDb(), req.headers);
  if (!identity) {
    return apiJson(
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
      return apiJson(
        { ok: false, error_code: 'INVALID_BODY', message: '请求体要是该能力入参的 JSON 对象；无入参可以不发 body' },
        { status: 400 },
      );
    }
  }

  const name = (await params).name;
  const outcome = await invokeCapability(getDb(), identity, name, args);
  if (!outcome.ok) {
    // extra 摊平在同一层，与 MCP 那条路 toolErrorResult 给出的键位逐字相同
    return apiJson(
      { ok: false, error_code: outcome.errorCode, message: outcome.message, ...outcome.extra },
      { status: outcome.status },
    );
  }
  // 【台账记在这道门上】这条桥是一条 api key 够得着的**写路径**：不记的形态是，
  // 同一条能力走 MCP 写进去查得到、走这里写进去查不到，而两边都返回 200
  //（2026-09-07 case 2 的同一个形态，那次漏的是 REST 路由这一面）。
  // 走能力壳（withClientRef / writeOnce）的能力在自己的事务里记过了，
  // recordCapabilityWrite 认注册表上的 ledger 字段、只记该由门记的那些，不会记出第二行。
  const capability = getCapability(name);
  if (capability) {
    recordCapabilityWrite(getDb(), identity, capability, args, outcome.value, 'rest-tools');
  }

  // 能力回包原样摊平，与 MCP tools/call 拿到的那份逐字相同（那边只是多包了一层文本外壳）
  return apiJson({ ok: true, ...outcome.value });
}
