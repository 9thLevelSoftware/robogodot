import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { MAX_VARIANT_DEPTH, MAX_VARIANT_NODES, parseVariantLiteral, serializeVariant, VariantLiteralError } from "../src/util/type-parser.js";

type Vector = { name: string; input: unknown; expected?: unknown; contains?: string };
const vectors = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../tests/fixtures/variant-vectors.json"), "utf8")) as {
  valid: Vector[];
  invalid: Vector[];
};

describe("shared Variant literal vectors", () => {
  for (const vector of vectors.valid) {
    test(vector.name, () => {
      expect(serializeVariant(parseVariantLiteral(vector.input))).toEqual(vector.expected);
    });
  }

  for (const vector of vectors.invalid) {
    test(`rejects ${vector.name} as invalid_args`, () => {
      expect(() => parseVariantLiteral(vector.input)).toThrow(VariantLiteralError);
      try {
        parseVariantLiteral(vector.input);
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_args" });
        expect((error as Error).message.toLowerCase()).toContain(vector.contains!.toLowerCase());
      }
    });
  }
});

test("serializer describes unsupported values instead of dropping them", () => {
  const value = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(value, Symbol.toStringTag, { value: "MysteryVariant" });
  expect(serializeVariant(value)).toEqual({ $type: "UnknownVariant", variantType: "MysteryVariant", value: "[object MysteryVariant]" });
});

test("parse enforces exact shared depth and node boundaries", () => {
  let atDepth: unknown = 1;
  for (let index = 0; index < MAX_VARIANT_DEPTH; index += 1) atDepth = [atDepth];
  expect(parseVariantLiteral(atDepth)).toEqual(atDepth);
  expect(() => parseVariantLiteral([atDepth])).toThrow(/depth.*32/i);
  expect(parseVariantLiteral(Array(MAX_VARIANT_NODES - 1).fill(null))).toHaveLength(MAX_VARIANT_NODES - 1);
  expect(() => parseVariantLiteral(Array(MAX_VARIANT_NODES).fill(null))).toThrow(/node.*10000/i);
});

test("serializer describes cycles and limits while preserving repeated references", () => {
  const repeated = { value: 1 };
  expect(serializeVariant([repeated, repeated])).toEqual([{ value: 1 }, { value: 1 }]);
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  expect(serializeVariant(cyclic)).toEqual([{ $type: "UnknownVariant", variantType: "cycle", value: "Array" }]);
  const cyclicDictionary: Record<string, unknown> = {};
  cyclicDictionary.self = cyclicDictionary;
  expect(serializeVariant(cyclicDictionary)).toEqual({ self: { $type: "UnknownVariant", variantType: "cycle", value: "Dictionary" } });
  let deep: unknown = 1;
	for (let index = 0; index < MAX_VARIANT_DEPTH; index += 1) deep = [deep];
	expect(serializeVariant(deep)).toEqual(deep);
	deep = [deep];
  expect(JSON.stringify(serializeVariant(deep))).toContain('"variantType":"depth overflow"');
	expect(JSON.stringify(serializeVariant(Array(MAX_VARIANT_NODES - 1).fill(null)))).not.toContain("overflow");
  expect(JSON.stringify(serializeVariant(Array(MAX_VARIANT_NODES).fill(null)))).toContain('"variantType":"node budget overflow"');
});

test("dictionary keys cannot mutate result prototypes", () => {
  const parsed = parseVariantLiteral('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}') as Record<string, unknown>;
  expect(Object.prototype).not.toHaveProperty("polluted");
  expect(Object.keys(parsed)).toEqual(["__proto__", "constructor"]);
  expect(serializeVariant(parsed)).toEqual(parsed);
});
