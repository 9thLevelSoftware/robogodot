import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parseVariantLiteral, serializeVariant, VariantLiteralError } from "../src/util/type-parser.js";

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
