// app/src/lib/capabilities/rest-runner.ts
// 「按注册表跑一条能力」的 REST 外壳：鉴权 → scope → precondition → run → 回包。
//
// 【为什么要有它】REST 面上有几条端点与 MCP 工具是**同一件事**（事实卡、诉求清单、
// 新建行动卡、检索知识库）。照着工具的 run 在路由里重抄一遍业务逻辑的形态是：
// 同一个案子在 agent 那边和在 REST 这边算出两套结果，而两边都返回 200。
// 所以这些路由只做「取参数」，执行一律回到注册表那一份。
//
// 【为什么闸门也在这里，而不在各路由里各写一句】precondition 是能力条目上的字段，
// 拦在唯一入口就等于「凡是声明了前置的能力，一条也漏不掉」。让各路由自觉抄一句的形态是：
// 新开一条路由时忘了抄——它照常工作、照常返回 200，只是闸门没了，没有任何一处会报错。
// 这与 api/mcp 那侧 tools/call 的判定是同一批字段、同一个顺序。
import { NextResponse } from 'next/server';

import { domainFailure, isRealnameVerified, requireIdentity } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';

import { getCapability } from './registry';

/** run 的失败形状（lib/cases 的 DomainFailure） */
interface RunFailure {
  ok: false;
  status: number;
  errorCode: string;
  message: string;
}

function isFailure(value: unknown): value is RunFailure {
  return !!value && typeof value === 'object' && (value as { ok?: unknown }).ok === false;
}

/**
 * 按能力名跑一条 REST 请求。
 *
 * 能力名写错时**当场抛**而不是回 404：那是本仓代码里的笔误，不是调用方能改正的事，
 * 静默 404 会让人以为是自己路径写错了。
 */
export async function runCapabilityRest(
  req: Request,
  name: string,
  args: Record<string, unknown>,
): Promise<NextResponse> {
  const cap = getCapability(name);
  if (!cap) {
    throw new Error(
      `能力注册表里没有 ${name}：这条路由挂的能力名与 lib/capabilities 对不上。` +
        '改路由里的名字，或先在 families/ 下登记这条能力。',
    );
  }

  const db = getDb();
  const guard = requireIdentity(db, req, cap.scope);
  if (!guard.ok) return guard.response;

  if (cap.precondition.includes('realname') && !isRealnameVerified(db, guard.identity.uid)) {
    return NextResponse.json(
      {
        ok: false,
        error_code: 'REALNAME_REQUIRED',
        message:
          `${cap.name} 需要账号先完成实名认证，本次调用没有产生任何写入。` +
          '请到网页「设置 → 实名认证」完成后再调一次；不要改用别的端点绕开这一步。',
      },
      { status: 403 },
    );
  }

  const outcome = await cap.run(db, guard.identity, args);
  if (isFailure(outcome)) return domainFailure(outcome);
  return NextResponse.json({ ok: true, ...(outcome as Record<string, unknown>) });
}
