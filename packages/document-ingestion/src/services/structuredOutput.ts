/**
 * Limits the Anthropic API puts on a structured-output schema
 * (`output_config.format`), checked by tests for every schema we send. The
 * API refuses a schema over them with a 400 `invalid_request_error` on every
 * call, before the model runs, so a schema that grows past one breaks its
 * feature entirely; unit tests with a fake client never see it.
 */

/**
 * Nullable or union-typed parameters (a `type` array or an `anyOf`) in one
 * schema: "limit: 16 parameters with unions" (the API's own message).
 */
export const STRUCTURED_OUTPUT_MAX_UNION_PARAMETERS = 16;

/** How many parameters of `schema`, at any depth, are nullable or union-typed. */
export function unionParameterCount(schema: unknown): number {
  if (Array.isArray(schema)) return schema.reduce((n: number, s) => n + unionParameterCount(s), 0);
  if (typeof schema !== 'object' || schema === null) return 0;
  const node = schema as Record<string, unknown>;
  const own = Array.isArray(node['type']) || Array.isArray(node['anyOf']) ? 1 : 0;
  return own + Object.values(node).reduce((n: number, v) => n + unionParameterCount(v), 0);
}
