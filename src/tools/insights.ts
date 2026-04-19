import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ServiceNowClient } from "../servicenow.js";
import { wrapTool } from "./utils.js";

function staleDateString(daysBack: number): string {
  return new Date(Date.now() - daysBack * 86_400_000)
    .toISOString()
    .replace("T", " ")
    .substring(0, 19);
}

function makeResult(
  summary: string,
  findings: string[],
  data: Record<string, unknown>,
  limitations?: string[],
) {
  return { summary, findings, data, limitations };
}

export function registerInsightTools(
  server: McpServer,
  client: ServiceNowClient,
): void {

  // ── get_table_fields ────────────────────────────────────────────────────────

  server.registerTool(
    "get_table_fields",
    {
      description:
        "Return field metadata for a ServiceNow table, including inherited fields from parent tables and reference details.",
      inputSchema: {
        table_name: z.string().describe("ServiceNow table name (e.g. 'incident', 'sc_request')"),
        include_inherited: z
          .boolean()
          .optional()
          .default(true)
          .describe("Walk the super_class chain and include parent-table fields (default true)"),
        include_reference_details: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include reference target table for reference fields (default true)"),
        include_attributes: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include raw attributes string from sys_dictionary (default false)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ table_name, include_inherited, include_reference_details, include_attributes }) => {
      return wrapTool(async () => {
        const MAX_DEPTH = 10;
        const tableChain: string[] = [table_name];
        const visited = new Set<string>([table_name]);

        if (include_inherited !== false) {
          let current = table_name;
          for (let depth = 0; depth < MAX_DEPTH; depth++) {
            const tableRecs = await client.listRecords("sys_db_object", {
              query: `name=${current}`,
              fields: "name,super_class",
              limit: 1,
              displayValue: "all",
            });
            if (tableRecs.length === 0) break;

            const superClass = tableRecs[0].super_class;
            if (!superClass) break;

            let parentName: string | null = null;
            if (typeof superClass === "object" && superClass !== null) {
              const dv = (superClass as Record<string, unknown>).display_value;
              if (typeof dv === "string") parentName = dv;
            } else if (typeof superClass === "string" && superClass.length > 0) {
              parentName = superClass;
            }

            if (!parentName || visited.has(parentName)) break;
            visited.add(parentName);
            tableChain.push(parentName);
            current = parentName;
          }
        }

        const baseFields = "name,element,internal_type,max_length,mandatory,default_value,read_only,active,scope";
        const refPart = include_reference_details ? ",reference" : "";
        const attrPart = include_attributes !== false ? ",attributes" : "";
        const fieldList = baseFields + refPart + attrPart;

        const allFields: Array<Record<string, unknown>> = [];

        for (const tableName of tableChain) {
          const isInherited = tableName !== table_name;
          const dictRecords = await client.listRecords("sys_dictionary", {
            query: `name=${tableName}^elementISNOTEMPTY^active=true`,
            fields: fieldList,
            limit: 500,
            displayValue: "true",
          });

          for (const rec of dictRecords) {
            const element = typeof rec.element === "string" ? rec.element : String(rec.element ?? "");
            const scopeVal =
              typeof rec.scope === "string"
                ? rec.scope
                : typeof rec.scope === "object" && rec.scope !== null
                ? String((rec.scope as Record<string, unknown>).display_value ?? "")
                : "";
            const isCustom =
              element.startsWith("u_") ||
              (scopeVal !== "" && !scopeVal.startsWith("global") && !scopeVal.startsWith("sn_"));

            const entry: Record<string, unknown> = {
              table: tableName,
              element,
              type: rec.internal_type,
              is_custom: isCustom,
              is_inherited: isInherited,
              mandatory: rec.mandatory,
              max_length: rec.max_length,
              default_value: rec.default_value,
              read_only: rec.read_only,
            };
            if (include_reference_details) entry.reference = rec.reference;
            if (include_attributes !== false) entry.attributes = rec.attributes;
            allFields.push(entry);
          }
        }

        const totalCount = allFields.length;
        const inheritedCount = allFields.filter((f) => f.is_inherited).length;
        const customCount = allFields.filter((f) => f.is_custom).length;
        const referenceCount = allFields.filter(
          (f) => String(f.type).toLowerCase() === "reference",
        ).length;

        const findings: string[] = [];
        if (tableChain.length > 1)
          findings.push(`Table inherits from ${tableChain.length - 1} parent(s): ${tableChain.slice(1).join(" → ")}.`);
        if (customCount > 0)
          findings.push(`${customCount} custom field(s) detected (u_ prefix or non-global scope).`);
        if (referenceCount > 0)
          findings.push(`${referenceCount} reference field(s) found.`);

        return makeResult(
          `Table '${table_name}' has ${totalCount} field(s) across ${tableChain.length} table(s) in the inheritance chain.`,
          findings,
          {
            table_chain: tableChain,
            fields: allFields,
            counts: { total: totalCount, inherited: inheritedCount, custom: customCount, reference: referenceCount },
          },
          tableChain.length >= MAX_DEPTH ? ["Inheritance chain may be truncated at depth limit."] : undefined,
        );
      });
    },
  );

  // ── summarize_flow_failures ─────────────────────────────────────────────────

  server.registerTool(
    "summarize_flow_failures",
    {
      description:
        "Summarize Flow Designer execution failures over a time window. Groups by flow name, ranks by count, and highlights patterns.",
      inputSchema: {
        time_window_days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .default(14)
          .describe("Days back to look for failures (default 14)"),
        flow_name_contains: z
          .string()
          .optional()
          .describe("Optional: only include flows whose name contains this string"),
        scope: z
          .string()
          .optional()
          .describe("Optional: only include flows in this scope (e.g. 'global')"),
        max_flows: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(20)
          .describe("Max distinct failing flows to return (default 20)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ time_window_days, flow_name_contains, scope, max_flows }) => {
      return wrapTool(async () => {
        const windowDays = time_window_days ?? 14;
        const cutoff = staleDateString(windowDays);

        const queryParts = [`stateINerror,cancelled`, `sys_created_on>${cutoff}`];
        if (flow_name_contains) queryParts.push(`nameLIKE${flow_name_contains}`);
        if (scope) queryParts.push(`scope=${scope}`);

        const contexts = await client.listRecords("sys_flow_context", {
          query: queryParts.join("^"),
          fields: "name,state,error_message,sys_created_on,scope",
          limit: 500,
          displayValue: "true",
        });

        const byFlow = new Map<string, { count: number; states: Record<string, number>; sample_error?: string }>();
        for (const ctx of contexts) {
          const flowName = typeof ctx.name === "string" ? ctx.name : "unknown";
          const state = typeof ctx.state === "string" ? ctx.state : "unknown";
          const existing = byFlow.get(flowName) ?? { count: 0, states: {} };
          existing.count++;
          existing.states[state] = (existing.states[state] ?? 0) + 1;
          if (!existing.sample_error && ctx.error_message && typeof ctx.error_message === "string") {
            existing.sample_error = ctx.error_message.substring(0, 300);
          }
          byFlow.set(flowName, existing);
        }

        const maxFlows = max_flows ?? 20;
        const failing_flows = Array.from(byFlow.entries())
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, maxFlows)
          .map(([name, stats]) => ({ name, ...stats }));

        const state_counts: Record<string, number> = {};
        for (const ctx of contexts) {
          const s = typeof ctx.state === "string" ? ctx.state : "unknown";
          state_counts[s] = (state_counts[s] ?? 0) + 1;
        }

        const findings: string[] = [];
        if (failing_flows.length > 0) {
          const top = failing_flows[0];
          const pct = Math.round((top.count / contexts.length) * 100);
          findings.push(`Top failing flow: '${top.name}' with ${top.count} failure(s) (${pct}% of total).`);
          if (pct >= 60)
            findings.push(`Single-flow dominance: '${top.name}' accounts for ≥60% of all failures.`);
        }
        if (contexts.length === 500)
          findings.push("Result capped at 500 execution records — actual failure count may be higher.");

        return makeResult(
          `Found ${contexts.length} failure(s) across ${byFlow.size} distinct flow(s) in the last ${windowDays} day(s).`,
          findings,
          { failing_flows, state_counts, total_failures: contexts.length },
          [
            "Results limited to 500 most recent records.",
            "Retention policy may limit historical data — older failures may not appear.",
          ],
        );
      });
    },
  );

  // ── summarize_instance_customization ────────────────────────────────────────

  server.registerTool(
    "summarize_instance_customization",
    {
      description:
        "Summarize the customization footprint of this ServiceNow instance: custom tables, scoped apps, and custom fields.",
      inputSchema: {
        include_table_breakdown: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include per-table classification in output (default true)"),
        include_app_breakdown: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include scoped application inventory (default true)"),
        include_custom_only: z
          .boolean()
          .optional()
          .default(false)
          .describe("When true, only return custom items in breakdown arrays (default false)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ include_table_breakdown, include_app_breakdown, include_custom_only }) => {
      return wrapTool(async () => {
        const OOTB_PREFIXES = ["sys_", "sn_", "com_", "cmdb", "sc_", "task", "incident", "problem", "change_"];

        const classifyTable = (name: string): string => {
          if (name.startsWith("x_")) return "custom_scoped";
          if (name.startsWith("u_")) return "custom_global";
          for (const prefix of OOTB_PREFIXES) {
            if (name.startsWith(prefix)) return "ootb";
          }
          return "unknown";
        };

        const [allTables, scopedApps, customFields] = await Promise.all([
          client.listRecords("sys_db_object", {
            query: "sys_class_name=sys_db_object",
            fields: "name,label,sys_scope",
            limit: 500,
            displayValue: "true",
          }),
          include_app_breakdown !== false
            ? client.listRecords("sys_scope", {
                query: "active=true^scope!=global",
                fields: "name,scope,version,vendor",
                limit: 500,
                displayValue: "true",
              })
            : Promise.resolve([]),
          client.listRecords("sys_dictionary", {
            query: "elementSTARTSWITHu_^active=true",
            fields: "name,element",
            limit: 500,
            displayValue: "true",
          }),
        ]);

        let ootbCount = 0;
        let customScopedCount = 0;
        let customGlobalCount = 0;
        let unknownCount = 0;
        const tableBreakdown: Array<{ name: string; label: string; classification: string }> = [];

        for (const t of allTables) {
          const name = typeof t.name === "string" ? t.name : "";
          const label = typeof t.label === "string" ? t.label : name;
          const cls = classifyTable(name);
          if (cls === "ootb") ootbCount++;
          else if (cls === "custom_scoped") customScopedCount++;
          else if (cls === "custom_global") customGlobalCount++;
          else unknownCount++;

          if (include_table_breakdown !== false) {
            if (include_custom_only && cls === "ootb") continue;
            tableBreakdown.push({ name, label, classification: cls });
          }
        }

        const appBreakdown = include_app_breakdown !== false
          ? scopedApps.map((a) => ({
              name: typeof a.name === "string" ? a.name : "",
              scope: typeof a.scope === "string" ? a.scope : "",
              version: a.version,
              vendor: a.vendor,
            }))
          : undefined;

        const customTableCount = customScopedCount + customGlobalCount;
        const findings: string[] = [];
        if (customTableCount > 0)
          findings.push(`${customTableCount} custom table(s) found (${customScopedCount} scoped, ${customGlobalCount} global).`);
        if (customFields.length >= 500)
          findings.push("Custom field count is at the 500-record cap — actual count may be higher.");
        else
          findings.push(`${customFields.length} custom field(s) with u_ prefix detected.`);
        if (scopedApps.length > 0)
          findings.push(`${scopedApps.length} active scoped application(s) installed.`);

        return makeResult(
          `Instance has ${allTables.length} table(s) total (${ootbCount} OOTB, ${customTableCount} custom) and ${customFields.length}+ custom field(s).`,
          findings,
          {
            table_counts: {
              total: allTables.length,
              ootb: ootbCount,
              custom_scoped: customScopedCount,
              custom_global: customGlobalCount,
              unknown: unknownCount,
            },
            custom_field_count: customFields.length,
            scoped_app_count: scopedApps.length,
            table_breakdown: tableBreakdown,
            app_breakdown: appBreakdown,
          },
          [
            "Table and field counts capped at 500 records each — large instances may be underreported.",
            "Table classification uses name-prefix heuristics and may misclassify some third-party tables.",
          ],
        );
      });
    },
  );

  // ── summarize_access_model ──────────────────────────────────────────────────

  server.registerTool(
    "summarize_access_model",
    {
      description:
        "Summarize user, group, and role counts, direct vs. group-inherited assignments, and privileged-role distribution.",
      inputSchema: {
        include_privileged_roles: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include privileged role breakdown (default true)"),
        include_group_role_analysis: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include group-role assignment count (default true)"),
        sample_limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe("Max records to scan per per-role query (default 500, capped at 500 per API call)"),
        privileged_role_list: z
          .array(z.string())
          .optional()
          .describe("Override default privileged roles (default: admin, security_admin, maint, itil, catalog_admin)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ include_privileged_roles, include_group_role_analysis, sample_limit, privileged_role_list }) => {
      return wrapTool(async () => {
        const privilegedRoles = privileged_role_list ?? [
          "admin", "security_admin", "maint", "itil", "catalog_admin",
        ];

        const extractCount = (result: unknown): number => {
          if (Array.isArray(result) && result.length > 0) {
            const row = result[0] as Record<string, unknown>;
            const stats = row.stats as Record<string, unknown> | undefined;
            return stats ? parseInt(String(stats.count ?? "0"), 10) : 0;
          }
          return 0;
        };

        const [userCountResult, groupCountResult, roleCountResult, directAssignResult] =
          await Promise.all([
            client.aggregateRecords("sys_user", { query: "active=true", count: true }),
            client.aggregateRecords("sys_user_group", { query: "active=true", count: true }),
            client.aggregateRecords("sys_user_role", { count: true }),
            client.aggregateRecords("sys_user_has_role", {
              query: "state=active^inherited=false",
              count: true,
            }),
          ]);

        const userCount = extractCount(userCountResult);
        const groupCount = extractCount(groupCountResult);
        const roleCount = extractCount(roleCountResult);
        const directAssignCount = extractCount(directAssignResult);

        let groupRoleCount = 0;
        if (include_group_role_analysis !== false) {
          const groupRoleResult = await client.aggregateRecords("sys_group_has_role", { count: true });
          groupRoleCount = extractCount(groupRoleResult);
        }

        const privilegedRoleDistribution: Array<{
          role: string;
          direct_user_count: number;
          group_count: number;
        }> = [];

        if (include_privileged_roles !== false) {
          const pageLimit = Math.min(sample_limit ?? 500, 500);
          for (const roleName of privilegedRoles) {
            const [directUsers, groupsWithRole] = await Promise.all([
              client.listRecords("sys_user_has_role", {
                query: `role.name=${roleName}^state=active^inherited=false`,
                fields: "user,role",
                limit: pageLimit,
                displayValue: "true",
              }),
              client.listRecords("sys_group_has_role", {
                query: `role.name=${roleName}`,
                fields: "group,role",
                limit: pageLimit,
                displayValue: "true",
              }),
            ]);
            privilegedRoleDistribution.push({
              role: roleName,
              direct_user_count: directUsers.length,
              group_count: groupsWithRole.length,
            });
          }
        }

        const findings: string[] = [];
        const adminEntry = privilegedRoleDistribution.find((r) => r.role === "admin");
        if (adminEntry && adminEntry.direct_user_count > 5)
          findings.push(`${adminEntry.direct_user_count} users have the 'admin' role directly — consider reviewing.`);
        if (directAssignCount > groupRoleCount && groupRoleCount > 0)
          findings.push("More roles are assigned directly to users than via groups — consider group-based access management.");

        return makeResult(
          `Instance has ${userCount} active user(s), ${groupCount} group(s), and ${roleCount} role(s). ${directAssignCount} direct user-role assignment(s).`,
          findings,
          {
            counts: { users: userCount, groups: groupCount, roles: roleCount },
            direct_vs_inherited: {
              direct_user_role_assignments: directAssignCount,
              group_role_assignments: groupRoleCount,
            },
            privileged_role_distribution: privilegedRoleDistribution,
          },
          [
            "Per-role breakdowns capped at sample_limit (max 500 per API call).",
            "Role containment inheritance is not counted — only direct and group assignments.",
          ],
        );
      });
    },
  );

  // ── get_integration_inventory ───────────────────────────────────────────────

  server.registerTool(
    "get_integration_inventory",
    {
      description:
        "List integration touchpoints: connection aliases, REST message definitions, and SOAP message definitions. Credential fields are never returned.",
      inputSchema: {
        include_aliases: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include sys_connection_alias records (default true)"),
        include_connection_details: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include non-credential connection details such as endpoint URLs (default false)"),
        include_app_context: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include owning application/scope for each integration (default true)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ include_aliases, include_connection_details, include_app_context }) => {
      return wrapTool(async () => {
        const appField = include_app_context !== false ? ",sys_scope" : "";

        const aliasFields = "sys_id,name,type,active" + appField +
          (include_connection_details ? ",default_value" : "");

        const restFields = "sys_id,name,description,active" + appField +
          (include_connection_details ? ",rest_endpoint" : "");

        const soapFields = "sys_id,name,description,active" + appField +
          (include_connection_details ? ",wsdl_url" : "");

        const [aliases, restMessages, soapMessages] = await Promise.all([
          include_aliases !== false
            ? client.listRecords("sys_connection_alias", {
                fields: aliasFields,
                limit: 500,
                displayValue: "true",
              })
            : Promise.resolve([]),
          client.listRecords("sys_rest_message", {
            query: "active=true",
            fields: restFields,
            limit: 500,
            displayValue: "true",
          }),
          client.listRecords("sys_soap_message", {
            query: "active=true",
            fields: soapFields,
            limit: 500,
            displayValue: "true",
          }),
        ]);

        const findings: string[] = [];
        if (aliases.length > 0)
          findings.push(`${aliases.length} connection alias(es) found.`);
        if (restMessages.length > 0)
          findings.push(`${restMessages.length} active REST message definition(s) found.`);
        if (soapMessages.length > 0)
          findings.push(`${soapMessages.length} active SOAP message definition(s) found.`);
        if (aliases.length + restMessages.length + soapMessages.length === 0)
          findings.push("No integration definitions found — instance may have minimal external integrations.");

        return makeResult(
          `Found ${aliases.length} connection alias(es), ${restMessages.length} REST message(s), ${soapMessages.length} SOAP message(s).`,
          findings,
          { aliases, rest_messages: restMessages, soap_messages: soapMessages },
          [
            "Credential, password, token, and secret fields are never returned by this tool.",
            "Results capped at 500 records per category.",
            "MID Server and Integration Hub spoke configurations are not included.",
          ],
        );
      });
    },
  );

  // ── find_stale_artifacts ────────────────────────────────────────────────────

  server.registerTool(
    "find_stale_artifacts",
    {
      description:
        "Find likely stale platform artifacts: open update sets, scheduled jobs, reports, and Flow Designer flows not modified recently.",
      inputSchema: {
        artifact_types: z
          .array(z.enum(["update_sets", "scheduled_jobs", "reports", "flows"]))
          .optional()
          .default(["update_sets", "scheduled_jobs", "reports", "flows"])
          .describe("Artifact types to check (default: all four)"),
        stale_after_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .default(180)
          .describe("Artifacts not modified in this many days are considered stale (default 180)"),
        include_inactive_only: z
          .boolean()
          .optional()
          .default(false)
          .describe("Only return inactive/disabled artifacts (default false — includes active)"),
        max_results_per_type: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(50)
          .describe("Max records to return per artifact type (default 50)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ artifact_types, stale_after_days, include_inactive_only, max_results_per_type }) => {
      return wrapTool(async () => {
        const types = artifact_types ?? ["update_sets", "scheduled_jobs", "reports", "flows"];
        const staleDays = stale_after_days ?? 180;
        const cutoff = staleDateString(staleDays);
        const maxPer = max_results_per_type ?? 50;

        const results: {
          update_sets: unknown[];
          scheduled_jobs: unknown[];
          reports: unknown[];
          flows: unknown[];
        } = { update_sets: [], scheduled_jobs: [], reports: [], flows: [] };

        const fetches: Promise<void>[] = [];

        if (types.includes("update_sets")) {
          fetches.push(
            client.listRecords("sys_update_set", {
              query: `stateINopen,in progress^sys_updated_on<${cutoff}`,
              fields: "name,state,sys_created_on,sys_updated_on,description",
              limit: maxPer,
              displayValue: "true",
            }).then((r) => { results.update_sets = r; }),
          );
        }

        if (types.includes("scheduled_jobs")) {
          const queryParts = [`sys_updated_on<${cutoff}`];
          if (include_inactive_only) queryParts.push("active=false");
          fetches.push(
            client.listRecords("sysauto_script", {
              query: queryParts.join("^"),
              fields: "name,active,run_type,last_action,sys_updated_on",
              limit: maxPer,
              displayValue: "true",
            }).then((r) => { results.scheduled_jobs = r; }),
          );
        }

        if (types.includes("reports")) {
          const queryParts = [`sys_updated_on<${cutoff}`];
          if (include_inactive_only) queryParts.push("active=false");
          fetches.push(
            client.listRecords("sys_report", {
              query: queryParts.join("^"),
              fields: "title,table,type,user,sys_updated_on,active",
              limit: maxPer,
              displayValue: "true",
            }).then((r) => { results.reports = r; }),
          );
        }

        if (types.includes("flows")) {
          const queryParts = [`sys_updated_on<${cutoff}`];
          if (include_inactive_only) queryParts.push("active=false");
          fetches.push(
            client.listRecords("sys_hub_flow", {
              query: queryParts.join("^"),
              fields: "name,active,sys_updated_on,sys_scope",
              limit: maxPer,
              displayValue: "true",
            }).then((r) => { results.flows = r; }),
          );
        }

        await Promise.all(fetches);

        const totalStale =
          results.update_sets.length +
          results.scheduled_jobs.length +
          results.reports.length +
          results.flows.length;

        const findings: string[] = [];
        if (results.update_sets.length > 0)
          findings.push(`${results.update_sets.length} open/in-progress update set(s) not modified in ${staleDays}+ days.`);
        if (results.scheduled_jobs.length > 0)
          findings.push(`${results.scheduled_jobs.length} scheduled job(s) not updated in ${staleDays}+ days.`);
        if (results.reports.length > 0)
          findings.push(`${results.reports.length} report(s) not updated in ${staleDays}+ days.`);
        if (results.flows.length > 0)
          findings.push(`${results.flows.length} Flow Designer flow(s) not updated in ${staleDays}+ days.`);
        if (totalStale === 0)
          findings.push(`No stale artifacts found with a ${staleDays}-day threshold.`);

        return makeResult(
          `Found ${totalStale} stale artifact(s) across ${types.length} checked type(s) (threshold: ${staleDays} days).`,
          findings,
          {
            artifacts_by_type: results,
            stale_threshold_days: staleDays,
            types_checked: types,
          },
          [
            "Results capped at max_results_per_type per artifact type.",
            "sysauto_script covers scripted scheduled jobs only — other job types may not appear.",
            "Stale detection is based on sys_updated_on, not last execution time.",
          ],
        );
      });
    },
  );
}
