// app/src/app/skill/[filename]/route.ts
// GET /skill/{filename}  公开取 skill 包的三份文件（SKILL.md / 接入说明.md / 陪跑指南.md）
//
// 【为什么公开无鉴权】与 /api/manifest 同一条理由：对方的 agent 得先读到这里，才知道
// 该怎么接、接进来之后该守哪些规矩。这三份是产品资产，不含任何账号或案件数据。
// 而且话术里那句「第一步：curl <skill_url>」必须在**还没配好密钥**的时候就能跑通——
// 要鉴权的话，第一步就卡在"你得先有 key"，而 skill 里写的正是怎么用 key。
//
// 【文件名走白名单，不拿 URL 段拼路径】见 lib/mcp/setup 的 PUBLIC_SKILL_FILES 注释。
//
// 【不在 (app) 路由组里】那个组套着 AppShell（导航壳），而这条路径返回的是纯 Markdown 文本。
import { PUBLIC_SKILL_FILES, readSkillFile } from '@/lib/mcp/setup';

const ALLOWED: ReadonlySet<string> = new Set<string>(PUBLIC_SKILL_FILES);

export async function GET(_req: Request, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;
  // Next 已对路径段做过一次解码，白名单在解码后的字符串上比对
  const name = decodeURIComponent(filename);
  if (!ALLOWED.has(name)) {
    return new Response(
      `缺什么：/skill/${name} 不存在。\n` +
        `为什么缺：这里只公开 skill 包里的这几份：${PUBLIC_SKILL_FILES.join('、')}。\n` +
        `怎么办：先取 SKILL.md，它会告诉你还该读哪几份。\n`,
      { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  return new Response(readSkillFile(name), {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      // 对方 agent 每次接入都会 curl 一次；内容随发版变，缓存半小时够用又不至于把
      // 改过的红线在对方那边留一整天
      'cache-control': 'public, max-age=1800',
    },
  });
}
