// app/src/app/api/health/route.ts
// 容器健康检查端点（deploy/docker-compose.yml 的 HEALTHCHECK 打这里）。
// 目前只报活；lib/db 落地后由 WS1 在此加 `getDb().prepare('SELECT 1').get()` 探库。
import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ status: 'ok', ts: new Date().toISOString() });
}
