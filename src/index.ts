#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TokenManager } from "./auth.js";
import { ServiceNowClient } from "./servicenow.js";
import { registerTools } from "./tools.js";

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const instanceUrl = getRequiredEnv("SERVICENOW_INSTANCE_URL").replace(/\/+$/, "");
const clientId = getRequiredEnv("SERVICENOW_CLIENT_ID");
const clientSecret = getRequiredEnv("SERVICENOW_CLIENT_SECRET");
const redirectPort = process.env.SERVICENOW_REDIRECT_PORT
  ? parseInt(process.env.SERVICENOW_REDIRECT_PORT, 10)
  : undefined;

if (!instanceUrl.startsWith("https://")) {
  console.error("SERVICENOW_INSTANCE_URL must start with https://");
  process.exit(1);
}

const tokenManager = new TokenManager({ instanceUrl, clientId, clientSecret, redirectPort });
const snClient = new ServiceNowClient(instanceUrl, tokenManager);

const server = new McpServer({
  name: "GlideWire ServiceNow MCP",
  version: "1.0.0",
});

registerTools(server, snClient);

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await server.close();
  process.exit(0);
});
