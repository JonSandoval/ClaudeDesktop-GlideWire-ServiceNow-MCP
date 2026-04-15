# ServiceNow MCP Server

A Model Context Protocol (MCP) server that connects Claude Desktop to your ServiceNow instance via the Table API. Authenticate with OAuth 2.0 and interact with any ServiceNow table directly from Claude.

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- A ServiceNow instance ([free developer instance](https://developer.servicenow.com))
- [Claude Desktop](https://claude.ai/download)

---

## Step 1: ServiceNow OAuth Setup

Before installing the server, you need to create an OAuth application in ServiceNow.

1. Log in to your ServiceNow instance
2. In the navigator, search for **Application Registry** (under **System OAuth**)
3. Click **New** → select **Create an OAuth API endpoint for external clients**
4. Fill in the following:
   - **Name**: `Claude MCP` (or any name you like)
   - **Redirect URL**: `http://localhost:8443/callback`
5. Click **Submit**, then open the record you just created
6. Copy the **Client ID** and **Client Secret** — you'll need them in Step 3

---

## Step 2: Install and Build

```bash
git clone <repo-url>
cd servicenow-mcp
npm install
npm run build
```

This compiles the TypeScript source into `dist/`. You only need to run this once (and again after any updates).

---

## Step 3: Configure Claude Desktop

Open your Claude Desktop config file:

- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

Add the `mcpServers` block below, replacing the placeholder values with your own:

```json
{
  "mcpServers": {
    "servicenow": {
      "command": "node",
      "args": ["/absolute/path/to/servicenow-mcp/dist/index.js"],
      "env": {
        "SERVICENOW_INSTANCE_URL": "https://your-instance.service-now.com",
        "SERVICENOW_CLIENT_ID": "your-client-id",
        "SERVICENOW_CLIENT_SECRET": "your-client-secret",
        "SERVICENOW_REDIRECT_PORT": "8443"
      }
    }
  }
}
```

> **Note:** If your config file already has an `mcpServers` key, add `servicenow` inside the existing object — do not create a second `mcpServers` key.

> **Windows path example:** `"args": ["C:/Users/YourName/servicenow-mcp/dist/index.js"]`

Restart Claude Desktop after saving the file.

---

## How Authorization Works

The server uses the OAuth 2.0 Authorization Code flow — no credentials are stored on disk.

1. The first time you use a ServiceNow tool in Claude, a **browser window opens** to your ServiceNow instance
2. Log in and click **Allow** to grant access
3. Your browser shows **"Authorization Successful"** — you can close the tab
4. All subsequent tool calls in that session use the token automatically
5. If the token expires, it refreshes silently in the background using the refresh token
6. Tokens are **memory-only** — you'll be prompted to re-authorize when Claude Desktop restarts

---

## Available Tools

| Tool | Description |
|------|-------------|
| `list_records` | List records from any table with optional filtering, field selection, and pagination |
| `get_record` | Retrieve a single record by its `sys_id` |
| `create_record` | Create a new record in a table |
| `update_record` | Partially update an existing record (only the fields you provide are changed) |

### Example prompts

- *"List the 5 most recent open incidents"*
- *"Get the incident with sys_id abc123..."*
- *"Create a high priority incident for the login page being down"*
- *"Update incident INC0010001 to assign it to the network team"*

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SERVICENOW_INSTANCE_URL` | Yes | — | Your instance URL, e.g. `https://dev12345.service-now.com` |
| `SERVICENOW_CLIENT_ID` | Yes | — | Client ID from the ServiceNow OAuth app |
| `SERVICENOW_CLIENT_SECRET` | Yes | — | Client Secret from the ServiceNow OAuth app |
| `SERVICENOW_REDIRECT_PORT` | No | `8443` | Local port for the OAuth callback server |

---

## Troubleshooting

**"Could not load app settings" on Claude Desktop startup**
JSON syntax error in `claude_desktop_config.json`. Validate the file at [jsonlint.com](https://jsonlint.com) and look for a missing comma or bracket.

**Browser doesn't open automatically**
Check the Claude Desktop MCP logs for a URL starting with `https://your-instance.service-now.com/oauth_auth.do...` and open it manually in your browser.

**Port 8443 is already in use**
Change `SERVICENOW_REDIRECT_PORT` to another port (e.g. `9000`) and update the **Redirect URL** in your ServiceNow OAuth app to match: `http://localhost:9000/callback`.

**"Failed to authenticate" or 401 errors**
- Verify the Client ID and Secret are copied correctly (no extra spaces)
- Confirm the Redirect URL in ServiceNow exactly matches `http://localhost:{port}/callback`
- Ensure the OAuth app in ServiceNow is active
