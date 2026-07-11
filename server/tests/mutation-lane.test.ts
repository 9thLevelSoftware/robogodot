import { describe, expect, test } from "vitest";
import { MutationLane } from "../src/mutation/lane.js";

describe("MutationLane", () => {
  test("serializes mutations and emits tags after success", async () => {
    const lane = new MutationLane();
    const order: string[] = [];
    const tags: string[][] = [];
    lane.onInvalidated((value) => tags.push([...value]));
    const first = lane.run(["scene", "node:/root/Main/A"], async () => {
      order.push("first:start");
      await Promise.resolve();
      order.push("first:end");
      return 1;
    });
    const second = lane.run(["scene"], async () => { order.push("second"); return 2; });
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(tags).toEqual([["node:/root/Main/A", "scene"], ["scene"]]);
  });

  test("continues after a failed mutation without emitting invalidations", async () => {
    const lane = new MutationLane();
    const tags: string[][] = [];
    lane.onInvalidated((value) => tags.push([...value]));
    await expect(lane.run(["scene"], async () => { throw new Error("rejected"); })).rejects.toThrow("rejected");
    await expect(lane.run(["signals", "signals"], async () => 2)).resolves.toBe(2);
    expect(tags).toEqual([["signals"]]);
  });
});
