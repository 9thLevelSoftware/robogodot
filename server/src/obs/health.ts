export type ChannelState = "ready" | "degraded" | "unavailable" | "unknown";

export interface HealthSnapshot {
  at: string;
  mode: string;
  channels: {
    editorBridge: ChannelState;
    lsp: ChannelState;
    runtime: ChannelState;
    filesystem: ChannelState;
  };
  auditRecords: number;
  cacheGeneration: number;
}

export class HealthService {
  constructor(
    private readonly getMode: () => string,
    private readonly probes: {
      editorBridge: () => ChannelState;
      lsp: () => ChannelState;
      runtime: () => ChannelState;
      filesystem: () => ChannelState;
      auditRecords: () => number;
      cacheGeneration: () => number;
    },
  ) {}

  snapshot(): HealthSnapshot {
    return {
      at: new Date().toISOString(),
      mode: this.getMode(),
      channels: {
        editorBridge: this.probes.editorBridge(),
        lsp: this.probes.lsp(),
        runtime: this.probes.runtime(),
        filesystem: this.probes.filesystem(),
      },
      auditRecords: this.probes.auditRecords(),
      cacheGeneration: this.probes.cacheGeneration(),
    };
  }
}
