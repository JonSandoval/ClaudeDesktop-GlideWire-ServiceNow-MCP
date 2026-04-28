<div align="center">
  <img src="logo.png" alt="GlideWire ServiceNow MCP" width="250" />

  # GlideWire ServiceNow MCP Server

  [![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](#prerequisites)
  [![Build Status](https://img.shields.io/badge/build-passing-brightgreen.svg)](#step-2-install-and-build)
  [![OAuth 2.0](https://img.shields.io/badge/auth-OAuth_2.0-blue.svg)](#how-authorization-works)
  [![ServiceNow](https://img.shields.io/badge/integration-ServiceNow-green.svg)](#)
</div>

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
git clone https://github.com/JonSandoval/ClaudeDesktop-GlideWire-ServiceNow-MCP.git
cd glidewire-servicenow-mcp
npm install
npm run build
```

This compiles the TypeScript source into `dist/`. Claude Desktop launches the server by running `node dist/index.js` directly, so the build step is required once before you configure Claude — and again any time you update the source.

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
      "args": ["/absolute/path/to/glidewire-servicenow-mcp/dist/index.js"],
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

> **Windows path example:** `"args": ["C:/Users/YourName/glidewire-servicenow-mcp/dist/index.js"]`

Restart Claude Desktop after saving the file.

---

## How Authorization Works

The server uses the **OAuth 2.0 Authorization Code grant** flow as defined in **RFC 6749 (Section 4.1)** for a "Confidential Client". It uses native Node.js libraries to process the authorization and token lifecycle without reliance on external third-party OAuth packages. No credentials are stored on disk.

1. The first time you use a ServiceNow tool in Claude, a **browser window opens** to your ServiceNow instance
2. Log in and click **Allow** to grant access
3. Your browser shows **"Authorization Successful"** — you can close the tab
4. All subsequent tool calls in that session use the token automatically
5. If the token expires, it refreshes silently in the background using the refresh token
6. Tokens are **memory-only** — you'll be prompted to re-authorize when Claude Desktop restarts

---

## Available Tools (38)

> **Note:** Write tools (`create_record`, `update_record`, `add_work_note`, `upload_attachment`) will prompt for your confirmation in Claude Desktop before executing. Read-only tools run without a prompt.

### Core CRUD

| Tool | Description |
|------|-------------|
| `list_records` | List records from any table with filtering, field selection, and pagination |
| `get_record` | Retrieve a single record by its `sys_id` |
| `create_record` | Create a new record in a table |
| `update_record` | Partially update an existing record (only the fields you provide are changed) |

### Access Intelligence

| Tool | Description |
|------|-------------|
| `get_user` | Find a user by username, email, or sys_id |
| `get_user_group_memberships` | List all groups a user belongs to |
| `get_group_members` | List all active users in a group |
| `get_user_direct_roles` | Get roles directly assigned to a user (not via groups) |
| `get_user_effective_roles` | Get all effective roles for a user (direct + group-derived) |
| `get_group_roles` | Get roles assigned to a group |
| `get_roles` | Search and list available roles |
| `get_groups` | Search and list user groups |
| `get_role_contains_roles` | List sub-roles that a role contains (auto-granted roles) |
| `get_role_contained_by` | List parent roles that contain a given role |
| `compare_user_groups` | Compare group memberships of two users |
| `compare_user_direct_roles` | Compare direct role assignments of two users |
| `compare_user_effective_roles` | Compare effective roles (direct + group-derived) of two users |
| `compare_user_access` | **Primary tool** — comprehensive access comparison: groups, direct roles, and effective roles |
| `explain_user_role_source` | Explain how a user has a specific role (direct, group, or role containment) |
| `compare_group_access` | Compare two groups: member overlap and role overlap |

### Admin & Hygiene

| Tool | Description |
|------|-------------|
| `aggregate_records` | Count or aggregate records using the Aggregate API (groupBy, having, sum/avg/min/max) |
| `get_record_by_number` | Get a record by its human-readable number (e.g. INC0001234, CHG0000123) |
| `add_work_note` | Append a work note to a task record (incident, change, problem, etc.) |
| `queue_health` | Snapshot of an assignment group's queue: total count, by priority, by state, by assignee |
| `find_stale_records` | Find records not updated in X days |
| `find_duplicate_users` | Find users with duplicate email or employee number |
| `find_orphaned_groups` | Find groups with no active members |

### Attachments

| Tool | Description |
|------|-------------|
| `list_attachments` | List attachments on a record (metadata only) |
| `upload_attachment` | Upload a file to a record (base64-encoded content) |
| `download_attachment` | Download an attachment's content (returns base64) |

### CMDB

| Tool | Description |
|------|-------------|
| `get_ci` | Get a Configuration Item by name, serial number, asset tag, or sys_id |
| `list_cis_by_class` | List CIs of a specific CMDB class with filtering and pagination |

### Developer & Architect Insights

Read-only tools for understanding platform structure, technical debt, and governance posture.

| Tool | Description |
|------|-------------|
| `get_table_fields` | Return field metadata for a table — types, mandatory flags, reference targets, and which fields are inherited from parent tables |
| `summarize_flow_failures` | Summarize Flow Designer execution failures over a time window, ranked by flow and grouped by error state |
| `summarize_instance_customization` | High-level view of instance customization: custom tables, scoped apps, and custom fields |
| `summarize_access_model` | Summarize users, groups, roles, direct vs. group-inherited assignments, and privileged-role distribution |
| `get_integration_inventory` | Inventory integration touchpoints: connection aliases, REST messages, and SOAP messages (credentials never returned) |
| `find_stale_artifacts` | Find likely stale artifacts for review: open update sets, idle scheduled jobs, old reports, and inactive flows |

---

## API Reference

<details>
<summary><strong>ServiceNow REST Endpoints</strong></summary>

All tools communicate with ServiceNow through these eight REST endpoints. Auth is Bearer token (OAuth 2.0); 401s trigger a one-shot token refresh and 429s use exponential backoff up to 3 retries.

| Endpoint | Method | Used by |
|---|---|---|
| `/api/now/table/{tableName}` | GET | `list_records`, all tools that read table data |
| `/api/now/table/{tableName}/{sysId}` | GET | `get_record`, `get_user` (sys_id path), `get_ci` (sys_id path) |
| `/api/now/table/{tableName}` | POST | `create_record` |
| `/api/now/table/{tableName}/{sysId}` | PATCH | `update_record`, `add_work_note` |
| `/api/now/stats/{tableName}` | GET | `aggregate_records`, `queue_health`, `find_duplicate_users`, `find_orphaned_groups`, `summarize_access_model` |
| `/api/now/attachment` | GET | `list_attachments` |
| `/api/now/attachment/file` | POST | `upload_attachment` |
| `/api/now/attachment/{sysId}/file` | GET | `download_attachment` |

</details>

<details>
<summary><strong>ServiceNow Tables</strong></summary>

| Table | Used by |
|---|---|
| `sys_user` | `get_user`, `find_duplicate_users`, `summarize_access_model` |
| `sys_user_group` | `get_groups`, `get_group_members`, `get_group_roles`, `compare_group_access`, `queue_health`, `find_orphaned_groups` |
| `sys_user_grmember` | `get_user_group_memberships`, `get_group_members`, `get_user_effective_roles`, `compare_user_*`, `explain_user_role_source`, `find_orphaned_groups` |
| `sys_user_has_role` | `get_user_direct_roles`, `get_user_effective_roles`, `compare_user_*`, `explain_user_role_source`, `summarize_access_model` |
| `sys_group_has_role` | `get_group_roles`, `get_user_effective_roles`, `compare_user_*`, `compare_group_access`, `explain_user_role_source`, `summarize_access_model` |
| `sys_user_role` | `get_roles`, `get_role_contains_roles`, `get_role_contained_by`, `explain_user_role_source`, `summarize_access_model` |
| `sys_user_role_contains` | `get_role_contains_roles`, `get_role_contained_by`, `explain_user_role_source` |
| `cmdb_ci` (and subclasses) | `get_ci`, `list_cis_by_class` |
| `sys_dictionary` | `get_table_fields`, `summarize_instance_customization` |
| `sys_db_object` | `get_table_fields`, `summarize_instance_customization` |
| `sys_flow_context` | `summarize_flow_failures` |
| `sys_hub_flow` | `find_stale_artifacts` |
| `sys_connection_alias` | `get_integration_inventory` |
| `sys_rest_message` | `get_integration_inventory` |
| `sys_soap_message` | `get_integration_inventory` |
| `sys_update_set` | `find_stale_artifacts` |
| `sysauto_script` | `find_stale_artifacts` |
| `sys_report` | `find_stale_artifacts` |
| `sys_scope` | `summarize_instance_customization` |

</details>

---

### Example prompts

- *"List the 5 most recent open incidents"*
- *"Get incident INC0010001"*
- *"Create a high priority incident for the login page being down"*
- *"Compare the access of user jsmith and user jdoe"*
- *"Explain how user admin got the itil role"*
- *"Show me the queue health for the Network team"*
- *"Find incidents that haven't been updated in 30 days"*
- *"Find groups with no members"*
- *"List attachments on CHG0000123"*
- *"Look up the server named db-prod-01 in the CMDB"*
- *"What fields are on the incident table, including inherited ones?"*
- *"Which flows have been failing most in the last 7 days?"*
- *"How customized is this ServiceNow instance?"*
- *"Summarize the access model — how many users have the admin role?"*
- *"What integrations are configured on this instance?"*
- *"Find update sets and scheduled jobs that haven't been touched in 6 months"*

---

## Environment Variables

> **Note on `.env` files:** Claude Desktop passes these variables directly via `claude_desktop_config.json` and does **not** use a `.env` file. However, a `.env.example` file is provided in the repository if you want to run or test the MCP server standalone (e.g., using the MCP Inspector).

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

---

## Development & Testing

If you are contributing to this project or modifying the tools, a comprehensive integration test suite is provided. This test suite uses a mocked ServiceNow client to verify that all tools are registered correctly, queries are safely constructed, and they return valid MCP response shapes without needing a live ServiceNow connection.

To run the tests:
```bash
npm run build
node test-tools.mjs
```

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
