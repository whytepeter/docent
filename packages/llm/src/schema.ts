import { z } from "zod";

type Json = Record<string, unknown>;

/** Draft-07 JSON Schema without the `$schema` marker (Claude Code rejects the 2020-12 one Zod emits by default). */
export function draft7(schema: z.ZodType): Json {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { target: "draft-7" }) as Json;
  return rest;
}

/** Keywords OpenAI's strict structured output refuses; Zod still enforces them after the answer comes back. */
const UNSUPPORTED = new Set(["minLength", "maxLength", "format", "default", "examples", "$schema", "propertyNames", "patternProperties", "uniqueItems"]);

/**
 * The schema in the strict form OpenAI's structured output needs: every object closes
 * (`additionalProperties: false`) and lists every property as required, with optional ones made
 * nullable instead. `parseAnswer` turns those nulls back into missing keys when Zod wants that.
 */
export function strictSchema(schema: z.ZodType): Json {
  return strictNode(draft7(schema)) as Json;
}

function strictNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictNode);
  if (!node || typeof node !== "object") return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node as Json)) {
    if (UNSUPPORTED.has(k)) continue;
    // Maps of name → schema: each value is a schema, the map itself is not.
    if ((k === "properties" || k === "definitions" || k === "$defs") && v && typeof v === "object") out[k] = Object.fromEntries(Object.entries(v as Json).map(([p, s]) => [p, strictNode(s)]));
    else out[k] = strictNode(v);
  }
  if (out.type === "object" || out.properties) {
    const props = (out.properties ?? {}) as Json;
    const required = new Set((out.required as string[] | undefined) ?? []);
    for (const key of Object.keys(props)) if (!required.has(key)) props[key] = { anyOf: [props[key], { type: "null" }] };
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

/**
 * Drops null values from keys the original schema doesn't require: a strict-schema provider sends null
 * for an optional field it leaves out. Required keys keep their nulls (`.nullable()` fields need them).
 */
export function dropOptionalNulls(schema: unknown, value: unknown): unknown {
  const node = (schema ?? {}) as Json;
  if (Array.isArray(value)) return value.map((v) => dropOptionalNulls(node.items, v));
  if (!value || typeof value !== "object") return value;
  const branches = (node.anyOf ?? node.oneOf) as Json[] | undefined;
  const object = branches?.find((b) => b.type === "object" || b.properties) ?? node;
  const props = (object.properties ?? {}) as Json;
  const required = new Set((object.required as string[] | undefined) ?? []);
  return Object.fromEntries(Object.entries(value)
    .filter(([k, v]) => v !== null || required.has(k))
    .map(([k, v]) => [k, dropOptionalNulls(props[k], v)]));
}

/**
 * Pulls one JSON value out of a model's reply: the whole text, else a fenced block, else the outermost
 * braces. Returns undefined when there is none.
 */
export function extractJson(text: string): unknown {
  const tries = [text.trim()];
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  if (fence) tries.push(fence[1]!.trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) tries.push(text.slice(first, last + 1));
  for (const t of tries) {
    try {
      return JSON.parse(t);
    } catch {
      /* next */
    }
  }
  return undefined;
}

/** Checks an answer against the schema, also trying it with nulls dropped (for strict-schema providers). */
export function parseAnswer<T extends z.ZodType>(schema: T, value: unknown): { ok: true; data: z.infer<T> } | { ok: false; issues: string } {
  const first = schema.safeParse(value);
  if (first.success) return { ok: true, data: first.data };
  const second = schema.safeParse(dropOptionalNulls(draft7(schema), value));
  if (second.success) return { ok: true, data: second.data };
  const issues = first.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  return { ok: false, issues };
}
