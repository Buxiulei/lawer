import { execFileSync } from 'node:child_process';

import type { NextConfig } from 'next';

/**
 * 构建期读一次 HEAD，内联进产物（供 /api/v1/version）。
 *
 * 【为什么在这里而不是运行时 exec git】产物是 standalone，跑在仓库目录之外；
 * 且不该给应用进程 exec 外部命令的能力。构建期读一次 = 这个值描述的就是**这一份产物**。
 *
 * 【为什么不改服务器上的 build.sh】那个文件不在仓里（只存在于 /data/lawer/build.sh），
 * 改它等于把一个构建事实放进不受版本控制的地方——下一个人 clone 下来构建，
 * 拿到的产物会**静默缺少**这个烙印。放这里，任何人任何环境构建都自带。
 *
 * 【取不到就写 null，绝不编一个】这个端点存在的唯一理由是让哨兵**独立核验**线上是哪一版。
 * 一个编出来的、或上次构建残留的 SHA，会让一次坏的滚更看起来"已核验通过"——
 * **那比没有这个端点更坏**。宁可给 null，让核验方看见"取不到"而不是看见一个假的对上了。
 */
function buildSha(): string | null {
  try {
    return (
      execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

const nextConfig: NextConfig = {
  output: 'standalone',
  env: {
    BUILD_SHA: buildSha() ?? '',
    BUILD_AT: new Date().toISOString(),
  },
  /**
   * OAuth 的两份元数据规范上必须挂在**根域**的 /.well-known/ 下（RFC 8414 / RFC 9728），
   * 而路由文件按目录组织。这两条 rewrite 就是这个接缝，别把它当可有可无的美化——
   * 少了它，客户端在「添加连接器」那一步读不到元数据，整条 OAuth 路走不通，
   * 而我们这边的日志里只会看到一条 404。
   *
   * 第三条是 RFC 9728 的**路径插入**变体：资源在 /api/mcp 上时，客户端会去问
   * /.well-known/oauth-protected-resource/api/mcp。两种问法都得答得上。
   */
  async rewrites() {
    return [
      {
        source: '/.well-known/oauth-authorization-server',
        destination: '/api/oauth/metadata/authorization-server',
      },
      {
        source: '/.well-known/oauth-protected-resource',
        destination: '/api/oauth/metadata/protected-resource',
      },
      {
        source: '/.well-known/oauth-protected-resource/:path*',
        destination: '/api/oauth/metadata/protected-resource',
      },
    ];
  },
};

export default nextConfig;
