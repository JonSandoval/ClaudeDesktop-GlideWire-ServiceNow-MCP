import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ServiceNowClient } from "../servicenow.js";
import { registerAccessTools } from "./access.js";
import { registerAdminTools } from "./admin.js";
import { registerAttachmentTools } from "./attachments.js";
import { registerCmdbTools } from "./cmdb.js";

export { wrapTool } from "./utils.js";

export function registerTools(server: McpServer, client: ServiceNowClient): void {
  registerCoreTools(server, client);
  registerAccessTools(server, client);
  registerAdminTools(server, client);
  registerAttachmentTools(server, client);
  registerCmdbTools(server, client);
}

/** The original four generic CRUD tools. */
import { z } from "zod";

function registerCoreTools(server: McpServer, client: ServiceNowClient): void {
  function wrapCore<T>(fn: () => Promise<T>) {
    return fn()
      .then((data) => ({
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      }))
      .catch((error: unknown) => ({
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true as const,
      }));
  }

  server.registerTool(
    "list_records",
    {
      description:
        "List records from a ServiceNow table. Supports filtering, field selection, and pagination.",
      inputSchema: {
        tableName: z
          .string()
          .describe("ServiceNow table name (e.g. 'incident', 'sys_user', 'change_request')"),
        query: z
          .string()
          .optional()
          .describe("Encoded query string (e.g. 'active=true^priority=1^ORDERBYnumber')"),
        fields: z
          .string()
          .optional()
          .describe("Comma-separated field names to return (e.g. 'number,short_description,state')"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Max records to return, 1-500 (default 50)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Starting record index for pagination (default 0)"),
        displayValue: z
          .enum(["true", "false", "all"])
          .optional()
          .describe("Return display values instead of raw: 'true', 'false', or 'all' (default 'false')"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ tableName, query, fields, limit, offset, displayValue }) => {
      return wrapCore(() =>
        client.listRecords(tableName, { query, fields, limit, offset, displayValue }),
      );
    },
  );

  server.registerTool(
    "get_record",
    {
      description: "Get a single record from a ServiceNow table by its sys_id.",
      inputSchema: {
        tableName: z
          .string()
          .describe("ServiceNow table name (e.g. 'incident', 'sys_user')"),
        sys_id: z.string().describe("The 32-character sys_id of the record"),
        fields: z
          .string()
          .optional()
          .describe("Comma-separated field names to return"),
        displayValue: z
          .enum(["true", "false", "all"])
          .optional()
          .describe("Return display values instead of raw: 'true', 'false', or 'all'"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ tableName, sys_id, fields, displayValue }) => {
      return wrapCore(() => client.getRecord(tableName, sys_id, { fields, displayValue }));
    },
  );

  server.registerTool(
    "create_record",
    {
      description: "Create a new record in a ServiceNow table. Returns the created record.",
      inputSchema: {
        tableName: z
          .string()
          .describe("ServiceNow table name (e.g. 'incident', 'change_request')"),
        body: z
          .record(z.string(), z.unknown())
          .describe(
            'Field values for the new record (e.g. { "short_description": "New issue", "priority": "1" })',
          ),
      },
      annotations: { destructiveHint: false },
    },
    async ({ tableName, body }) => {
      return wrapCore(() => client.createRecord(tableName, body));
    },
  );

  server.registerTool(
    "update_record",
    {
      description:
        "Update an existing record in a ServiceNow table using PATCH (partial update). Only the provided fields are modified.",
      inputSchema: {
        tableName: z
          .string()
          .describe("ServiceNow table name (e.g. 'incident', 'sys_user')"),
        sys_id: z.string().describe("The 32-character sys_id of the record to update"),
        body: z
          .record(z.string(), z.unknown())
          .describe(
            'Field values to update (e.g. { "state": "2", "assigned_to": "admin" })',
          ),
      },
      annotations: { destructiveHint: false },
    },
    async ({ tableName, sys_id, body }) => {
      return wrapCore(() => client.updateRecord(tableName, sys_id, body));
    },
  );
}
