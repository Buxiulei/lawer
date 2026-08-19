// app/src/lib/evidence/index.ts
// 证据上传/SHA256 去重/加密落盘/TSA 固化编排（调 sidecar）。
// 骨架占位：实现由对应工作窗口填充，跨模块只经本文件导出的函数接口（spec §3.2）。
//
// ── sidecar 调用契约（WS2 提供，详见 sidecar/README.md）──
// 基址取 env SIDECAR_URL（容器内 http://sidecar:8100，不映射宿主端口）。
// 出证链路顺序：/tsa 取时间戳 → /evidence-pdf 渲染未签名证明 → /pades 施加签名 → 落 files 表。
// 状态码：入参不合法 400/422；依赖未配置（无 key/无证书）503；上游 TSA/DashScope 报错 502。
//
// ⚠ /verify 是例外：验签**不通过也返回 200**，裁决在响应体的 `overall_ok` 字段。
//   把 200 当成"验过了"会让无效证据静默通过——这是仲裁场上会直接害到用户的错误，
//   调用方必须显式读 overall_ok，绝不能只判 res.ok。
export {};
