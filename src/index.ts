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

function getInstanceOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    console.error("SERVICENOW_INSTANCE_URL must be a valid HTTPS URL");
    process.exit(1);
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    console.error("SERVICENOW_INSTANCE_URL must be an HTTPS origin without credentials, path, query, or fragment");
    process.exit(1);
  }

  return parsed.origin;
}

function getRedirectPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    console.error("SERVICENOW_REDIRECT_PORT must be an integer from 1 to 65535");
    process.exit(1);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("SERVICENOW_REDIRECT_PORT must be an integer from 1 to 65535");
    process.exit(1);
  }
  return port;
}

const instanceUrl = getInstanceOrigin(getRequiredEnv("SERVICENOW_INSTANCE_URL"));
const clientId = getRequiredEnv("SERVICENOW_CLIENT_ID");
const clientSecret = getRequiredEnv("SERVICENOW_CLIENT_SECRET");
const redirectPort = getRedirectPort(process.env.SERVICENOW_REDIRECT_PORT);

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
