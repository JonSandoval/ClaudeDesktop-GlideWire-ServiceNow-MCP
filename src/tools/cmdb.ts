import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ServiceNowClient } from "../servicenow.js";
import { wrapTool } from "./utils.js";

export function registerCmdbTools(server: McpServer, client: ServiceNowClient): void {
  server.registerTool(
    "get_ci",
    {
      description:
        "Get a Configuration Item (CI) from the CMDB by name, serial number, asset tag, or sys_id. Searches cmdb_ci by default; specify a ciClass for more precise results (e.g. 'cmdb_ci_server', 'cmdb_ci_computer').",
      inputSchema: {
        identifier: z
          .string()
          .describe("The value to search for (name, serial number, asset tag, or sys_id)"),
        identifierType: z
          .enum(["name", "serial_number", "asset_tag", "sys_id"])
          .optional()
          .default("name")
          .describe("How to interpret the identifier (default: name)"),
        ciClass: z
          .string()
          .optional()
          .describe(
            "CMDB class table to search (e.g. 'cmdb_ci_server', 'cmdb_ci_linux_server', 'cmdb_ci_computer'). Defaults to 'cmdb_ci' which searches the base CMDB table.",
          ),
        fields: z
          .string()
          .optional()
          .describe("Comma-separated fields to return"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ identifier, identifierType, ciClass, fields }) => {
      return wrapTool(async () => {
        const table = ciClass ?? "cmdb_ci";
        if (identifierType === "sys_id") {
          return client.getRecord(table, identifier, {
            fields,
            displayValue: "true",
          });
        }
        const fieldMap: Record<string, string> = {
          name: "name",
          serial_number: "serial_number",
          asset_tag: "asset_tag",
        };
        const field = fieldMap[identifierType ?? "name"] ?? "name";
        const records = await client.listRecords(table, {
          query: `${field}=${identifier}`,
          fields,
          limit: 5,
          displayValue: "true",
        });
        if (records.length === 0) {
          return { message: `No CI found with ${field}=${identifier} in table ${table}` };
        }
        return records.length === 1 ? records[0] : records;
      });
    },
  );

  server.registerTool(
    "list_cis_by_class",
    {
      description:
        "List Configuration Items of a specific CMDB class. Use this to browse servers, computers, network devices, or any other CI type. Supports filtering and pagination.",
      inputSchema: {
        ciClass: z
          .string()
          .describe(
            "CMDB class table name (e.g. 'cmdb_ci_server', 'cmdb_ci_linux_server', 'cmdb_ci_computer', 'cmdb_ci_netgear'). Use 'cmdb_ci' for the base class.",
          ),
        query: z
          .string()
          .optional()
          .describe(
            "Encoded query to filter CIs (e.g. 'operational_status=1^u_environment=Production')",
          ),
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
          .describe("Max CIs to return (default 50)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe("Pagination offset (default 0)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ciClass, query, fields, limit, offset }) => {
      return wrapTool(async () => {
        return client.listRecords(ciClass, {
          query,
          fields,
          limit: limit ?? 50,
          offset: offset ?? 0,
          displayValue: "true",
        });
      });
    },
  );
}
