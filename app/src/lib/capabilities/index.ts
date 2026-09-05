// app/src/lib/capabilities/index.ts
// 能力注册表的对外门面。调用方一律从这里引，不要直接引 families/*。
export {
  CAPABILITIES,
  getCapability,
  listCapabilities,
  type Capability,
  type CapabilityFamily,
  type CapabilityKind,
  type CapabilityPrecondition,
  type CapabilitySurface,
} from './registry';
export { withClientRef, type AgentWriteTarget } from './idempotent';
