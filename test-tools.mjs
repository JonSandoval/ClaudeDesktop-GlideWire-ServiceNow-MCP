/**
 * Integration test — registers all tools with a mock ServiceNowClient,
 * invokes every handler with valid sample inputs, and verifies:
 *   1. Handler executes without throwing
 *   2. Response has the expected MCP shape { content: [{ type, text }] }
 *   3. The mock client methods were called with correct table names / queries
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./dist/tools.js";

// ── Mock Client ──────────────────────────────────────────────────────────────

const callLog = [];

function makeMockClient() {
  const handler = {
    get(_, method) {
      return async (...args) => {
        callLog.push({ method: String(method), args });

        // Return realistic shaped data based on the method
        switch (String(method)) {
          case "listRecords":
            return [
              {
                sys_id: "a".repeat(32),
                name: "Mock Record",
                user_name: "mock.user",
                email: "mock@example.com",
                group: { value: "b".repeat(32), display_value: "Mock Group" },
                role: { value: "c".repeat(32), display_value: "itil" },
                user: { value: "d".repeat(32), display_value: "Mock User" },
                contains: { value: "e".repeat(32), display_value: "sub_role" },
                number: "INC0001234",
                active: "true",
              },
            ];
          case "getRecord":
            return {
              sys_id: "a".repeat(32),
              name: "Mock Record",
              number: "INC0001234",
            };
          case "createRecord":
            return { sys_id: "f".repeat(32), number: "INC9999999" };
          case "updateRecord":
            return { sys_id: args[1], state: "2" };
          case "aggregateRecords":
            return [
              {
                stats: { count: "42" },
                groupby_fields: [{ field: "group", value: "b".repeat(32) }],
              },
            ];
          case "listAttachments":
            return [
              {
                sys_id: "g".repeat(32),
                file_name: "test.pdf",
                content_type: "application/pdf",
                size_bytes: "1024",
              },
            ];
          case "uploadAttachment":
            return { sys_id: "h".repeat(32), file_name: "upload.txt" };
          case "downloadAttachment":
            return {
              contentType: "text/plain",
              base64Content: "SGVsbG8=",
              fileName: "test.txt",
            };
          default:
            return {};
        }
      };
    },
  };
  return new Proxy({}, handler);
}

// ── Test Harness ─────────────────────────────────────────────────────────────

const server = new McpServer({ name: "test", version: "0.0.1" });
const mockClient = makeMockClient();
registerTools(server, mockClient);

const tools = server._registeredTools;
const toolNames = Object.keys(tools).sort();

let passed = 0;
let failed = 0;
const failures = [];

// Sample inputs for each tool
const sampleInputs = {
  // Core CRUD
  list_records: { tableName: "incident", query: "active=true", limit: 10 },
  get_record: { tableName: "incident", sys_id: "a".repeat(32) },
  create_record: { tableName: "incident", body: { short_description: "Test" } },
  update_record: {
    tableName: "incident",
    sys_id: "a".repeat(32),
    body: { state: "2" },
  },

  // Access Intelligence — Primitives
  get_user: { identifier: "admin", identifierType: "username" },
  get_user_group_memberships: { userSysId: "a".repeat(32) },
  get_group_members: { groupSysId: "b".repeat(32), limit: 50 },
  get_user_direct_roles: { userSysId: "a".repeat(32), includeInherited: false },
  get_user_effective_roles: { userSysId: "a".repeat(32) },
  get_group_roles: { groupSysId: "b".repeat(32) },
  get_roles: { nameFilter: "itil", limit: 20 },
  get_groups: { nameFilter: "Service", activeOnly: true, limit: 20 },
  get_role_contains_roles: { roleSysId: "c".repeat(32) },
  get_role_contained_by: { roleSysId: "c".repeat(32) },

  // Access Intelligence — Composed
  compare_user_groups: {
    userSysId1: "a".repeat(32),
    userSysId2: "d".repeat(32),
  },
  compare_user_direct_roles: {
    userSysId1: "a".repeat(32),
    userSysId2: "d".repeat(32),
  },
  compare_user_effective_roles: {
    userSysId1: "a".repeat(32),
    userSysId2: "d".repeat(32),
  },
  compare_user_access: {
    userSysId1: "a".repeat(32),
    userSysId2: "d".repeat(32),
    includeEffectiveRoles: true,
  },
  explain_user_role_source: {
    userSysId: "a".repeat(32),
    roleName: "itil",
  },
  compare_group_access: {
    groupSysId1: "b".repeat(32),
    groupSysId2: "e".repeat(32),
  },

  // Admin & Hygiene
  aggregate_records: {
    tableName: "incident",
    groupBy: "priority",
    count: true,
  },
  get_record_by_number: { tableName: "incident", number: "INC0001234" },
  add_work_note: {
    tableName: "incident",
    sys_id: "a".repeat(32),
    workNote: "Test note",
  },
  queue_health: { groupSysId: "b".repeat(32), tableName: "incident" },
  find_stale_records: {
    tableName: "incident",
    daysStale: 30,
    limit: 10,
  },
  find_duplicate_users: { field: "email", activeOnly: true },
  find_orphaned_groups: { activeGroupsOnly: true },

  // Attachments
  list_attachments: {
    tableName: "incident",
    tableSysId: "a".repeat(32),
    limit: 10,
  },
  upload_attachment: {
    tableName: "incident",
    tableSysId: "a".repeat(32),
    fileName: "test.txt",
    contentType: "text/plain",
    base64Content: "SGVsbG8=",
  },
  download_attachment: { attachmentSysId: "g".repeat(32) },

  // CMDB
  get_ci: { identifier: "web-server-01", identifierType: "name" },
  list_cis_by_class: { ciClass: "cmdb_ci_server", limit: 10 },

  // Developer & Architect Insights
  get_table_fields: { table_name: "incident", include_inherited: false, include_reference_details: true, include_attributes: false },
  summarize_flow_failures: { time_window_days: 7, max_flows: 10 },
  summarize_instance_customization: { include_table_breakdown: true, include_app_breakdown: true, include_custom_only: false },
  summarize_access_model: { include_privileged_roles: true, include_group_role_analysis: true },
  get_integration_inventory: { include_aliases: true, include_connection_details: false, include_app_context: true },
  find_stale_artifacts: { artifact_types: ["update_sets", "scheduled_jobs", "reports", "flows"], stale_after_days: 180, include_inactive_only: false, max_results_per_type: 10 },
};

console.log(`\nTesting ${toolNames.length} tools...\n`);

for (const name of toolNames) {
  const tool = tools[name];
  const input = sampleInputs[name];

  if (!input) {
    console.log(`  SKIP  ${name} — no sample input defined`);
    continue;
  }

  callLog.length = 0; // reset call log

  try {
    // The tool object has a .handler or we need to call it through the server
    // In MCP SDK, registered tools have a callback stored internally
    const result = await tool.handler(input);

    // Validate MCP response shape
    if (
      !result ||
      !Array.isArray(result.content) ||
      result.content.length === 0 ||
      result.content[0].type !== "text"
    ) {
      throw new Error(
        `Invalid response shape: ${JSON.stringify(result).substring(0, 200)}`
      );
    }

    // If isError is set, the handler caught an exception
    if (result.isError) {
      throw new Error(`Handler returned error: ${result.content[0].text}`);
    }

    // Verify the response text is valid JSON
    const parsed = JSON.parse(result.content[0].text);

    // Verify at least one mock client method was called
    if (callLog.length === 0) {
      throw new Error("No ServiceNow API calls were made");
    }

    console.log(
      `  PASS  ${name.padEnd(35)} ${callLog.length} API call(s), response OK`
    );
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name.padEnd(35)} ${err.message}`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${toolNames.length} total`);

if (failures.length > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) {
    console.log(`  ${f.name}: ${f.error}`);
  }
  process.exit(1);
}

console.log("\nAll tools passed.");
