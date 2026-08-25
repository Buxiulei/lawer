import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    // ../scripts 是仓库根的 scripts/（对账 CLI 与 C04 评测判据）：
    // 评测判据自己也有测试，必须跟主套件一起跑，否则「判据放松了」没人会发现。
    // 注：那些文件在 app 包之外，Node 解析走不到 app/node_modules，所以 tsconfig.json
    // 里给 'vitest' 加了一条 paths 映射，好让它们同样受 tsc 覆盖（vitest 运行时不受影响）。
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.{ts,tsx}', '../scripts/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});
