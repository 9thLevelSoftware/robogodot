import { GodotMcpError } from "../errors.js";

export interface AssetGenerateRequest {
  prompt: string;
  targetResPath: string;
}

export interface AssetGenerateResult {
  path: string;
  bytes: number;
  provider: string;
}

export interface AssetProvider {
  readonly name: string;
  generate(request: AssetGenerateRequest): Promise<{ data: Buffer; contentType?: string }>;
}

export class DisabledAssetProvider implements AssetProvider {
  readonly name = "disabled";
  async generate(): Promise<{ data: Buffer }> {
    throw new GodotMcpError(
      "feature_disabled",
      "Asset generation is not configured.",
      "Set GODOT_MCP_ASSET_PROVIDER=true and register a provider implementation to enable this tool.",
    );
  }
}
