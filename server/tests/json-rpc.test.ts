import { describe, expect, it } from "vitest";
import { parseJsonRpcResponse } from "../src/bridge/json-rpc.js";

describe("parseJsonRpcResponse", () => {
  it("accepts strict JSON-RPC results and errors", () => {
    expect(parseJsonRpcResponse('{"jsonrpc":"2.0","id":2,"result":false}')).toEqual({ jsonrpc: "2.0", id: 2, result: false });
    expect(parseJsonRpcResponse('{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"missing","data":{"hint":"upgrade"}}}')).toEqual({
      jsonrpc: "2.0", id: 3, error: { code: -32601, message: "missing", data: { hint: "upgrade" } },
    });
  });

  it.each([
    "nope", "[]", "null", '{"jsonrpc":"1.0","id":1,"result":1}',
    '{"jsonrpc":"2.0","id":"1","result":1}', '{"jsonrpc":"2.0","id":1}',
    '{"jsonrpc":"2.0","id":1,"result":1,"error":{"code":1,"message":"x"}}',
    '{"jsonrpc":"2.0","id":1,"error":{"code":"x","message":"x"}}',
  ])("rejects malformed or ambiguous responses: %s", (frame) => {
    expect(parseJsonRpcResponse(frame)).toBeUndefined();
  });
});
