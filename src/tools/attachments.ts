import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ServiceNowClient } from "../servicenow.js";
import { wrapTool } from "./utils.js";

export function registerAttachmentTools(server: McpServer, client: ServiceNowClient): void {
  server.registerTool(
    "list_attachments",
    {
      description:
        "List attachments on a ServiceNow record. Returns metadata for each attachment (file name, content type, size, sys_id) without downloading the file content.",
      inputSchema: {
        tableName: z
          .string()
          .describe("Table containing the record (e.g. 'incident', 'change_request')"),
        tableSysId: z
          .string()
          .describe("sys_id of the record whose attachments to list"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(50)
          .describe("Max attachments to return (default 50)"),
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
    async ({ tableName, tableSysId, limit, offset }) => {
      return wrapTool(async () => {
        return client.listAttachments(tableName, tableSysId, {
          limit: limit ?? 50,
          offset: offset ?? 0,
        });
      });
    },
  );

  server.registerTool(
    "upload_attachment",
    {
      description:
        "Upload a file as an attachment to a ServiceNow record. The file content must be provided as a base64-encoded string.",
      inputSchema: {
        tableName: z
          .string()
          .describe("Table containing the target record (e.g. 'incident', 'change_request')"),
        tableSysId: z
          .string()
          .describe("sys_id of the record to attach the file to"),
        fileName: z
          .string()
          .describe("Name for the uploaded file (e.g. 'screenshot.png', 'migration-plan.xlsx')"),
        contentType: z
          .string()
          .describe(
            "MIME type of the file (e.g. 'image/png', 'application/pdf', 'text/plain', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')",
          ),
        base64Content: z
          .string()
          .describe("Base64-encoded file contents"),
      },
      annotations: { destructiveHint: false },
    },
    async ({ tableName, tableSysId, fileName, contentType, base64Content }) => {
      return wrapTool(async () => {
        return client.uploadAttachment(tableName, tableSysId, fileName, contentType, base64Content);
      });
    },
  );

  server.registerTool(
    "download_attachment",
    {
      description:
        "Download the content of a specific attachment by its sys_id. Returns the file content as a base64-encoded string along with the content type. Use list_attachments first to find the attachment sys_id.",
      inputSchema: {
        attachmentSysId: z
          .string()
          .describe("32-char sys_id of the attachment record (from list_attachments output)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ attachmentSysId }) => {
      return wrapTool(async () => {
        return client.downloadAttachment(attachmentSysId);
      });
    },
  );
}
