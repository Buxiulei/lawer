// app/src/lib/db/index.ts
// SQLite 唯一 SQL 层：client.ts + migrate.ts + 各表封装（spec §6、§7）。
// 骨架占位：其余实现由对应工作窗口填充，跨模块只经本文件导出的函数接口（spec §3.2）。

// 时间戳助手（ADR-002）：应用层写时间列一律经这两个函数，禁止 toISOString() 直落。
export { nowSql, toSql } from './time';
