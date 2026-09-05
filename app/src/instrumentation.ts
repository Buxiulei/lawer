// app/src/instrumentation.ts
// Next.js 的进程启动钩子（每个 server 进程起来时跑一次 register()）。
//
// 【为什么新建这个文件】仓里此前没有任何进程启动钩子：既没有 instrumentation.ts，
// 也没有自定义 server.js（产物是 next standalone 的默认 server）。内容提取要有一个常驻
// worker 去领队列里的任务，它总得有个地方被起起来——放在某个路由的模块顶层是**不行**的：
// 那样它只在有人第一次访问那条路由时才起，重启后到下一个访客之间队列是停的，
// 而「有没有人访问过那条路由」不是任何人会去想的事。
//
// 【边界】这里只做「起后台常驻」，不做任何一次性数据迁移或修复：register() 在 dev 下会
// 随热更新重跑，把一次性动作放这儿等于让它跑很多次。
export async function register(): Promise<void> {
  // instrumentation 在 nodejs 与 edge 两种运行时都会被调用；worker 要用 better-sqlite3
  // 与文件系统，只能在 nodejs 那一份里起。edge 那次直接返回，不是错误。
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { getDb } = await import('@/lib/db/client');
  const { startExtractionWorker } = await import('@/lib/jobs/extraction-worker');
  startExtractionWorker(getDb());
}
