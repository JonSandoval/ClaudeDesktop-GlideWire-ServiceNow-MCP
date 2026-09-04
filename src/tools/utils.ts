import { TableRecord } from "../types.js";

const QUERY_FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;
const SYS_ID_RE = /^[a-f0-9]{32}$/;

/**
 * Reject characters and expressions that can escape an encoded-query value.
 * Raw encoded queries are accepted only by tools that explicitly expose a
 * `query` or query-fragment argument.
 */
export function assertSafeQueryValue(value: string, label = "query value"): void {
  if (value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (/[\^\r\n\0]/.test(value) || /javascript:/i.test(value)) {
    throw new Error(`${label} contains unsupported ServiceNow encoded-query syntax`);
  }
}

function assertSafeQueryField(field: string): void {
  if (!QUERY_FIELD_RE.test(field)) {
    throw new Error(`Invalid ServiceNow query field: ${field}`);
  }
}

/** Build a safe equality clause for a ServiceNow encoded query. */
export function safeEq(field: string, value: string, label = field): string {
  assertSafeQueryField(field);
  assertSafeQueryValue(value, label);
  return `${field}=${value}`;
}

/** Build a safe LIKE clause for a ServiceNow encoded query. */
export function safeLike(field: string, value: string, label = field): string {
  assertSafeQueryField(field);
  assertSafeQueryValue(value, label);
  return `${field}LIKE${value}`;
}

/** Build an equality clause that also enforces ServiceNow's sys_id format. */
export function safeSysIdEq(field: string, value: string, label = `${field} sys_id`): string {
  assertSafeQueryField(field);
  if (!SYS_ID_RE.test(value)) {
    throw new Error(`${label} must be a 32-character lowercase hexadecimal sys_id`);
  }
  return `${field}=${value}`;
}

/** Build an IN clause from trusted sys_ids returned by ServiceNow. */
export function safeSysIdIn(field: string, values: string[]): string {
  assertSafeQueryField(field);
  if (values.length === 0 || values.some((value) => !SYS_ID_RE.test(value))) {
    throw new Error(`Invalid sys_id list for ${field}`);
  }
  return `${field}IN${values.join(",")}`;
}

/** Shared error-wrapping helper used by all tool handlers. */
export async function wrapTool<T>(
  fn: () => Promise<T>,
): Promise<{ content: [{ type: "text"; text: string }]; isError?: true }> {
  try {
    const data = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
      isError: true as const,
    };
  }
}

/**
 * Extract the raw sys_id from a reference field that may be either a plain
 * string or a ServiceNow displayValue=all object: `{ value, display_value, link }`.
 */
export function extractRefValue(field: unknown): string | null {
  if (typeof field === "string" && field.length === 32) return field;
  if (typeof field === "object" && field !== null) {
    const v = (field as Record<string, unknown>).value;
    if (typeof v === "string") return v;
  }
  return null;
}

/**
 * Extract the human-readable label from a reference field (displayValue).
 */
export function extractRefDisplay(field: unknown): string | null {
  if (typeof field === "string") return field;
  if (typeof field === "object" && field !== null) {
    const dv = (field as Record<string, unknown>).display_value;
    if (typeof dv === "string") return dv;
    const v = (field as Record<string, unknown>).value;
    if (typeof v === "string") return v;
  }
  return null;
}

/** Build a set/map of sys_ids from a list of records using the given field name. */
export function buildRefSet(
  records: TableRecord[],
  field: string,
): Set<string> {
  const set = new Set<string>();
  for (const r of records) {
    const id = extractRefValue(r[field]);
    if (id) set.add(id);
  }
  return set;
}

/** Diff two sets and return three buckets: only in A, shared, only in B. */
export function diffSets(
  setA: Set<string>,
  setB: Set<string>,
): { onlyInA: string[]; shared: string[]; onlyInB: string[] } {
  const all = new Set([...setA, ...setB]);
  const onlyInA: string[] = [];
  const shared: string[] = [];
  const onlyInB: string[] = [];
  for (const id of all) {
    if (setA.has(id) && setB.has(id)) shared.push(id);
    else if (setA.has(id)) onlyInA.push(id);
    else onlyInB.push(id);
  }
  return { onlyInA, shared, onlyInB };
}
