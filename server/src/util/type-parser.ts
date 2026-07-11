export class VariantLiteralError extends Error {
  readonly code = "invalid_args" as const;

  constructor(message: string) {
    super(message);
    this.name = "VariantLiteralError";
  }
}

type JsonObject = { [key: string]: unknown };
const TAG = "$type";
export const MAX_VARIANT_DEPTH = 32;
export const MAX_VARIANT_NODES = 10_000;
const CONSTRUCTOR_ARITIES: Record<string, readonly number[]> = {
  Vector2: [2],
  Vector3: [3],
  Color: [3, 4],
  Rect2: [4],
};

function invalid(message: string): never {
  throw new VariantLiteralError(message);
}

function finite(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${context} must be a finite number`);
  return value;
}

function parseNumber(text: string, context: string): number {
  const trimmed = text.trim();
  if (trimmed === "" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    invalid(`${context} must be a finite number`);
  }
  return finite(Number(trimmed), context);
}

function ownKeys(value: JsonObject, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(`${context} must contain exactly ${expected.join(", ")}`);
  }
}

function parseTagged(value: JsonObject): unknown {
  const type = value[TAG];
  if (typeof type !== "string") invalid("tagged Variant $type must be a string");
  if (type === "Vector2") {
    ownKeys(value, [TAG, "x", "y"], type);
    return { [TAG]: type, x: finite(value.x, "Vector2.x"), y: finite(value.y, "Vector2.y") };
  }
  if (type === "Vector3") {
    ownKeys(value, [TAG, "x", "y", "z"], type);
    return { [TAG]: type, x: finite(value.x, "Vector3.x"), y: finite(value.y, "Vector3.y"), z: finite(value.z, "Vector3.z") };
  }
  if (type === "Color") {
    ownKeys(value, [TAG, "r", "g", "b", "a"], type);
    return { [TAG]: type, r: finite(value.r, "Color.r"), g: finite(value.g, "Color.g"), b: finite(value.b, "Color.b"), a: finite(value.a, "Color.a") };
  }
  if (type === "NodePath") {
    ownKeys(value, [TAG, "path"], type);
    if (typeof value.path !== "string") invalid("NodePath.path must be a string");
    return { [TAG]: type, path: value.path };
  }
  if (type === "Rect2") {
    ownKeys(value, [TAG, "x", "y", "width", "height"], type);
    return { [TAG]: type, x: finite(value.x, "Rect2.x"), y: finite(value.y, "Rect2.y"), width: finite(value.width, "Rect2.width"), height: finite(value.height, "Rect2.height") };
  }
  return invalid(`unknown tagged Variant '${type}'`);
}

type TraversalState = { nodes: number };

function countParseNode(state: TraversalState, depth: number): void {
  if (depth > MAX_VARIANT_DEPTH) invalid(`Variant literal exceeds maximum depth ${MAX_VARIANT_DEPTH}`);
  state.nodes += 1;
  if (state.nodes > MAX_VARIANT_NODES) invalid(`Variant literal exceeds node budget ${MAX_VARIANT_NODES}`);
}

function parseStructured(value: unknown, state: TraversalState, depth = 0): unknown {
  countParseNode(state, depth);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return finite(value, "JSON number");
  if (Array.isArray(value)) return value.map((item) => parseStructured(item, state, depth + 1));
  if (typeof value === "object") {
    const object = value as JsonObject;
    if (Object.prototype.hasOwnProperty.call(object, TAG)) return parseTagged(object);
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, parseStructured(item, state, depth + 1)]));
  }
  return invalid(`unsupported Variant literal value of type ${typeof value}`);
}

function parseConstructor(text: string): unknown {
  const open = text.indexOf("(");
  if (open < 1) invalid("unknown constructor or malformed Variant literal");
  const name = text.slice(0, open).trim();
  const close = text.lastIndexOf(")");
  if (close < open) invalid(`${name || "constructor"} is missing ')'`);
  if (text.slice(close + 1).trim() !== "") invalid(`trailing junk after ${name} constructor`);
  const body = text.slice(open + 1, close).trim();
  if (name === "NodePath") {
    let path: unknown;
    try { path = JSON.parse(body); } catch { invalid("NodePath expects one quoted JSON string"); }
    if (typeof path !== "string") invalid("NodePath expects one quoted JSON string");
    return { [TAG]: "NodePath", path };
  }
  const arities = CONSTRUCTOR_ARITIES[name];
  if (!arities) invalid(`unknown constructor '${name}'`);
  const parts = body === "" ? [] : body.split(",");
  if (!arities.includes(parts.length)) {
    const expected = name === "Color" ? "3 or 4" : String(arities[0]);
    invalid(`${name} expects ${expected} arguments, received ${parts.length}`);
  }
  const numbers = parts.map((part, index) => parseNumber(part, `${name} argument ${index + 1}`));
  if (name === "Vector2") return { [TAG]: name, x: numbers[0], y: numbers[1] };
  if (name === "Vector3") return { [TAG]: name, x: numbers[0], y: numbers[1], z: numbers[2] };
  if (name === "Rect2") return { [TAG]: name, x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] };
  return { [TAG]: "Color", r: numbers[0], g: numbers[1], b: numbers[2], a: numbers[3] ?? 1 };
}

export function parseVariantLiteral(value: unknown): unknown {
  const state = { nodes: 0 };
  if (typeof value !== "string") return parseStructured(value, state);
  const text = value.trim();
  if (text.startsWith("(")) invalid("ambiguous tuple syntax; use an explicit Vector2 or other constructor");
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    if (!/^[0-9a-fA-F]+$/.test(hex) || (hex.length !== 6 && hex.length !== 8)) invalid("hex Color expects exactly 6 or 8 hexadecimal digits");
    const channel = (offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return { [TAG]: "Color", r: channel(0), g: channel(2), b: channel(4), a: hex.length === 8 ? channel(6) : 1 };
  }
  if (/^[A-Za-z_]/.test(text) && text.includes("(")) return parseConstructor(text);
  try {
    return parseStructured(JSON.parse(text), state);
  } catch (error) {
    if (error instanceof VariantLiteralError) throw error;
    invalid("invalid JSON or unknown constructor Variant literal");
  }
}

function canonicalColor(value: number): number {
  return Number(value.toFixed(7));
}

function unknownVariant(variantType: string, value: string): JsonObject {
  return { [TAG]: "UnknownVariant", variantType, value };
}

function serializeStructured(value: unknown, state: TraversalState, depth: number, ancestors: Set<object>): unknown {
  if (depth > MAX_VARIANT_DEPTH) return unknownVariant("depth overflow", `maximum depth ${MAX_VARIANT_DEPTH}`);
  state.nodes += 1;
  if (state.nodes > MAX_VARIANT_NODES) return unknownVariant("node budget overflow", `maximum nodes ${MAX_VARIANT_NODES}`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : unknownVariant("nonfinite number", String(value));
  if (typeof value === "object" && ancestors.has(value)) return unknownVariant("cycle", Array.isArray(value) ? "Array" : "Dictionary");
  if (Array.isArray(value)) {
    ancestors.add(value);
    const output = value.map((item) => serializeStructured(item, state, depth + 1, ancestors));
    ancestors.delete(value);
    return output;
  }
  if (typeof value === "object") {
    const object = value as JsonObject;
    ancestors.add(object);
    let output: unknown;
    if (typeof object[TAG] === "string") {
      if (object[TAG] === "Color") output = { [TAG]: "Color", r: canonicalColor(finite(object.r, "Color.r")), g: canonicalColor(finite(object.g, "Color.g")), b: canonicalColor(finite(object.b, "Color.b")), a: canonicalColor(finite(object.a, "Color.a")) };
      else if (["Vector2", "Vector3", "NodePath", "Rect2"].includes(object[TAG])) output = Object.fromEntries(Object.entries(object).map(([key, item]) => [key, key === TAG ? item : serializeStructured(item, state, depth + 1, ancestors)]));
    }
    const prototype = Object.getPrototypeOf(object);
    if (output === undefined && (prototype === Object.prototype || prototype === null && Object.prototype.toString.call(object) === "[object Object]")) {
      output = Object.fromEntries(Object.entries(object).map(([key, item]) => [key, serializeStructured(item, state, depth + 1, ancestors)]));
    }
    if (output === undefined) {
      const rendered = Object.prototype.toString.call(object);
      output = unknownVariant(rendered.slice(8, -1), rendered);
    }
    ancestors.delete(object);
    return output;
  }
  return unknownVariant(typeof value, String(value));
}

export function serializeVariant(value: unknown): unknown {
  return serializeStructured(value, { nodes: 0 }, 0, new Set());
}
