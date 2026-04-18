import { TableRecord } from "../types.js";

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
