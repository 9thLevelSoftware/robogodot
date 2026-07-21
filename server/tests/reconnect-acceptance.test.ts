import { describe, expect, it } from "vitest";
import { RECONNECT_ACCEPTANCE_MS, RECONNECT_BACKOFF_MS } from "../src/bridge/ws-client.js";

describe("reconnect acceptance window (ADR 0006 / Q-016)", () => {
  it("is the max backoff plus a 5 second handshake margin", () => {
    const maxBackoff = Math.max(...RECONNECT_BACKOFF_MS);
    expect(maxBackoff).toBe(60_000);
    expect(RECONNECT_ACCEPTANCE_MS).toBe(maxBackoff + 5_000);
  });

  it("uses the documented exponential schedule", () => {
    expect([...RECONNECT_BACKOFF_MS]).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000]);
  });
});
