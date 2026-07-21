import type { SafetyMode } from "./config.js";
import { MutationLane } from "./mutation/lane.js";
import { ReadCache } from "./mw/cache.js";
import { AuditLog } from "./obs/audit.js";
import { HealthService, type ChannelState } from "./obs/health.js";

export interface PolicyBundle {
  mode: SafetyMode;
  mutationLane: MutationLane;
  cache: ReadCache;
  audit: AuditLog;
  health: HealthService;
}

export function createPolicyBundle(
  mode: SafetyMode,
  probes?: Partial<{
    editorBridge: () => ChannelState;
    lsp: () => ChannelState;
    runtime: () => ChannelState;
    filesystem: () => ChannelState;
  }>,
): PolicyBundle {
  const mutationLane = new MutationLane();
  const cache = new ReadCache();
  const audit = new AuditLog();
  const health = new HealthService(() => mode, {
    editorBridge: probes?.editorBridge ?? (() => "unknown"),
    lsp: probes?.lsp ?? (() => "unknown"),
    runtime: probes?.runtime ?? (() => "unknown"),
    filesystem: probes?.filesystem ?? (() => "unknown"),
    auditRecords: () => audit.list().length,
    cacheGeneration: () => cache.currentGeneration,
  });
  return { mode, mutationLane, cache, audit, health };
}
