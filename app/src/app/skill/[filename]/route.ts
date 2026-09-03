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

export async function GET(req: Request, { params }: { params: Promise<{ filename: string }> }) {
  // 白名单在**解码后**的字符串上比对（中文文件名在 URL 里是一串 %E6…）。
  //
  // 【解不开就拿原样去比】decodeURIComponent 对畸形百分号（'%'、'%zz'）抛 URIError。
  // 抛出去是 500 加一屏框架堆栈，而这跟「你要的这份不存在」是同一件事——那串东西不在
  // 白名单里。接住它，落到下面同一句 404 自述：对方 agent 拿到「服务器炸了」会重试，
  // 拿到「这份不存在」才会掉头去读 SKILL.md。
  //
  // ⚠️【这条挡不住真正的畸形 URL，别以为挡住了】实测（2026-09-03，next 16.2.9 生产模式）：
  // 直接请求 /skill/% 时 Next 在**匹配动态段那一步**就 500 了，这个 handler 一次都没进
  //（服务端日志无任何记录，返回体是框架自己的 "Internal Server Error"）。
  // 而且这不是本路由的事：/verify/%、/case/%/ask、/api/v1/keys/%/secret 一律 500，
  // 全站每条动态路由同形。要让它变成 404 得改唯一入口（middleware 或反代那一层），
  // 不在本单授权范围内，已上报。这里接住的是「解得开但仍非法」以及日后 Next 改行为
  // 把原样串交进来的那一档。
  let name: string;
  try {
    name = decodeURIComponent((await params).filename);
  } catch {
    name = new URL(req.url).pathname.split('/').pop() ?? '';
  }
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
