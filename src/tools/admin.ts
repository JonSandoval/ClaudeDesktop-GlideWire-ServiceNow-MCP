import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ServiceNowClient } from "../servicenow.js";
import { wrapTool, extractRefValue } from "./utils.js";

export function registerAdminTools(server: McpServer, client: ServiceNowClient): void {
  server.registerTool(
    "aggregate_records",
    {
      description:
        "Count or aggregate records in a ServiceNow table using the Aggregate API. Supports groupBy, having filters, and stat functions (sum, avg, min, max). Great for queue snapshots, hygiene counts, and dashboard metrics.",
      inputSchema: {
        tableName: z
          .string()
          .describe("ServiceNow table name (e.g. 'incident', 'sys_user', 'alm_asset')"),
        query: z
          .string()
          .optional()
          .describe("Encoded query string to filter records (e.g. 'active=true^priority=1')"),
        groupBy: z
          .string()
          .optional()
          .describe("Field to group results by (e.g. 'priority', 'state', 'assignment_group')"),
        count: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include COUNT in results (default true)"),
        having: z
          .string()
          .optional()
          .describe("HAVING clause for grouped results (e.g. 'COUNT > 5') — requires Tokyo+"),
        sumFields: z.string().optional().describe("Comma-separated fields to SUM"),
        avgFields: z.string().optional().describe("Comma-separated fields to AVERAGE"),
        minFields: z.string().optional().describe("Comma-separated fields to find MIN of"),
        maxFields: z.string().optional().describe("Comma-separated fields to find MAX of"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Max result groups to return"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ tableName, query, groupBy, count, having, sumFields, avgFields, minFields, maxFields, limit }) => {
      return wrapTool(async () => {
        return client.aggregateRecords(tableName, {
          query,
          groupBy,
          count: count ?? true,
          having,
          sumFields,
          avgFields,
          minFields,
          maxFields,
          limit,
        });
      });
    },
  );

  server.registerTool(
    "get_record_by_number",
    {
      description:
        "Get a record by its human-readable number field (e.g. INC0001234, CHG0000123, RITM0012345, PRB0000456). Searches the number field of the specified table.",
      inputSchema: {
        tableName: z
          .string()
          .describe(
            "ServiceNow table name (e.g. 'incident', 'change_request', 'problem', 'sc_req_item')",
          ),
        number: z
          .string()
          .describe("Record number (e.g. INC0001234, CHG0000123)"),
        fields: z
          .string()
          .optional()
          .describe("Comma-separated fields to return"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ tableName, number, fields }) => {
      return wrapTool(async () => {
        const records = await client.listRecords(tableName, {
          query: `number=${number}`,
          fields,
          limit: 1,
          displayValue: "true",
        });
        if (records.length === 0) {
          return { message: `No record found with number=${number} in table ${tableName}` };
        }
        return records[0];
      });
    },
  );

  server.registerTool(
    "add_work_note",
    {
      description:
        "Append a work note to a task record (incident, change, problem, request, etc.). Work notes are internal — not visible to end users. ServiceNow appends to the journal; it never overwrites.",
      inputSchema: {
        tableName: z
          .string()
          .default("incident")
          .describe("Table name (default: incident)"),
        sys_id: z.string().describe("32-char sys_id of the record"),
        workNote: z.string().describe("Work note text to append"),
      },
      annotations: { destructiveHint: false },
    },
    async ({ tableName, sys_id, workNote }) => {
      return wrapTool(async () => {
        return client.updateRecord(tableName, sys_id, { work_notes: workNote });
      });
    },
  );

  server.registerTool(
    "queue_health",
    {
      description:
        "Get a snapshot of an assignment group's open ticket queue: total count, breakdown by priority, breakdown by state, and per-assignee workload. Provide groupSysId or groupName.",
      inputSchema: {
        groupSysId: z.string().optional().describe("sys_id of the assignment group"),
        groupName: z
          .string()
          .optional()
          .describe("Name of the assignment group (used when groupSysId not provided)"),
        tableName: z
          .string()
          .optional()
          .default("incident")
          .describe("Table to query (default: incident)"),
        openStateQuery: z
          .string()
          .optional()
          .describe(
            "Encoded query fragment for 'open' states (default: 'state!=6^state!=7' — excludes Resolved and Closed for incidents)",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ groupSysId, groupName, tableName, openStateQuery }) => {
      return wrapTool(async () => {
        let resolvedSysId = groupSysId;
        if (!resolvedSysId) {
          if (!groupName) throw new Error("Either groupSysId or groupName must be provided");
          const groups = await client.listRecords("sys_user_group", {
            query: `name=${groupName}`,
            fields: "sys_id,name",
            limit: 1,
          });
          if (groups.length === 0) throw new Error(`No group found with name: ${groupName}`);
          resolvedSysId = groups[0].sys_id as string;
        }

        const table = tableName ?? "incident";
        const stateFilter = openStateQuery ?? "state!=6^state!=7";
        const baseQuery = `assignment_group=${resolvedSysId}^${stateFilter}`;

        const [totalResult, byPriority, byState, byAssignee] = await Promise.all([
          client.aggregateRecords(table, {
            query: baseQuery,
            count: true,
          }),
          client.aggregateRecords(table, {
            query: baseQuery,
            count: true,
            groupBy: "priority",
          }),
          client.aggregateRecords(table, {
            query: baseQuery,
            count: true,
            groupBy: "state",
          }),
          client.aggregateRecords(table, {
            query: baseQuery,
            count: true,
            groupBy: "assigned_to",
          }),
        ]);

        return {
          group_sys_id: resolvedSysId,
          group_name: groupName,
          table,
          state_filter: stateFilter,
          total: totalResult,
          by_priority: byPriority,
          by_state: byState,
          by_assignee: byAssignee,
        };
      });
    },
  );

  server.registerTool(
    "find_stale_records",
    {
      description:
        "Find records in a table that have not been updated in the specified number of days. Useful for identifying abandoned tickets, stale assets, or inactive records needing attention.",
      inputSchema: {
        tableName: z
          .string()
          .describe("ServiceNow table name (e.g. 'incident', 'alm_asset', 'knowledge')"),
        daysStale: z
          .number()
          .int()
          .min(1)
          .describe("Records not updated in this many days will be returned"),
        additionalQuery: z
          .string()
          .optional()
          .describe("Additional encoded query to narrow results (e.g. 'active=true^state=1')"),
        fields: z
          .string()
          .optional()
          .describe("Comma-separated fields to return"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(50)
          .describe("Max records to return (default 50)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ tableName, daysStale, additionalQuery, fields, limit }) => {
      return wrapTool(async () => {
        const cutoff = new Date(Date.now() - daysStale * 24 * 60 * 60 * 1000);
        // ServiceNow expects UTC in "YYYY-MM-DD HH:mm:ss" format
        const dateString = cutoff.toISOString().replace("T", " ").substring(0, 19);
        const parts = [`sys_updated_on<${dateString}`];
        if (additionalQuery) parts.push(additionalQuery);
        const query = parts.join("^");

        return client.listRecords(tableName, {
          query,
          fields,
          limit: limit ?? 50,
          displayValue: "true",
        });
      });
    },
  );

  server.registerTool(
    "find_duplicate_users",
    {
      description:
        "Find sys_user records with duplicate values in the email or employee_number field. Returns the duplicate field values and their counts. Requires ServiceNow Tokyo or later for the HAVING clause. Note: only the first 500 groups are checked.",
      inputSchema: {
        field: z
          .enum(["email", "employee_number"])
          .describe("Field to check for duplicates"),
        activeOnly: z
          .boolean()
          .optional()
          .default(true)
          .describe("Check only active users (default true)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ field, activeOnly }) => {
      return wrapTool(async () => {
        const parts: string[] = [`${field}!=EMPTY`];
        if (activeOnly) parts.push("active=true");
        const query = parts.join("^");

        const aggregateResult = await client.aggregateRecords("sys_user", {
          query,
          groupBy: field,
          count: true,
          having: "COUNT > 1",
          limit: 500,
        });

        return {
          field,
          duplicates: aggregateResult,
          note: `Records shown have more than one active user sharing the same ${field}. HAVING clause requires ServiceNow Tokyo+.`,
        };
      });
    },
  );

  server.registerTool(
    "find_orphaned_groups",
    {
      description:
        "Find groups that have no active members. These may be inactive or stale groups that can be cleaned up. Checks up to 500 groups.",
      inputSchema: {
        activeGroupsOnly: z
          .boolean()
          .optional()
          .default(true)
          .describe("Check only active groups (default true)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ activeGroupsOnly }) => {
      return wrapTool(async () => {
        const groupQuery = activeGroupsOnly ? "active=true" : "";

        // Step 1: Get all groups (up to 500)
        const allGroups = await client.listRecords("sys_user_group", {
          query: groupQuery,
          fields: "sys_id,name,description,manager",
          limit: 500,
          displayValue: "true",
        });

        // Step 2: Get all groups that have at least one active member
        const groupsWithMembers = await client.aggregateRecords("sys_user_grmember", {
          query: "user.active=true",
          groupBy: "group",
          count: true,
        });

        // Extract sys_ids of groups that have members
        const groupsWithMemberIds = new Set<string>();
        if (Array.isArray(groupsWithMembers)) {
          for (const row of groupsWithMembers as Array<Record<string, unknown>>) {
            const groupFields = row.groupby_fields as Array<{ field: string; value: string }> | undefined;
            if (groupFields) {
              for (const gf of groupFields) {
                if (gf.field === "group" && gf.value) {
                  groupsWithMemberIds.add(gf.value);
                }
              }
            }
          }
        }

        // Step 3: Filter groups not in the "has members" set
        const orphaned = allGroups.filter((g) => {
          const id = extractRefValue(g.sys_id) ?? (typeof g.sys_id === "string" ? g.sys_id : null);
          return id && !groupsWithMemberIds.has(id);
        });

        return {
          orphaned_groups: orphaned,
          count: orphaned.length,
          total_groups_checked: allGroups.length,
          note: "Groups with no active members. Only the first 500 groups were evaluated.",
        };
      });
    },
  );
}
