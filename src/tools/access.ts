import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ServiceNowClient } from "../servicenow.js";
import { wrapTool, extractRefValue, extractRefDisplay, buildRefSet, diffSets } from "./utils.js";

export function registerAccessTools(server: McpServer, client: ServiceNowClient): void {
  // ─── Primitive Tools ─────────────────────────────────────────────────────────

  server.registerTool(
    "get_user",
    {
      description:
        "Find a ServiceNow user by username, email address, or sys_id. Returns user profile fields.",
      inputSchema: {
        identifier: z.string().describe("Username, email address, or 32-char sys_id"),
        identifierType: z
          .enum(["username", "email", "sys_id"])
          .optional()
          .default("username")
          .describe("How to interpret the identifier (default: username)"),
        fields: z
          .string()
          .optional()
          .describe("Comma-separated fields to return (default: common profile fields)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ identifier, identifierType, fields }) => {
      return wrapTool(async () => {
        const defaultFields =
          "sys_id,user_name,email,first_name,last_name,active,title,department,manager,location";
        if (identifierType === "sys_id") {
          return client.getRecord("sys_user", identifier, {
            fields: fields ?? defaultFields,
            displayValue: "true",
          });
        }
        const field = identifierType === "email" ? "email" : "user_name";
        const records = await client.listRecords("sys_user", {
          query: `${field}=${identifier}`,
          fields: fields ?? defaultFields,
          limit: 5,
          displayValue: "true",
        });
        if (records.length === 0) {
          return { message: `No user found with ${field}=${identifier}` };
        }
        return records.length === 1 ? records[0] : records;
      });
    },
  );

  server.registerTool(
    "get_user_group_memberships",
    {
      description: "List all groups a user belongs to.",
      inputSchema: {
        userSysId: z.string().describe("sys_id of the user"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ userSysId }) => {
      return wrapTool(async () => {
        return client.listRecords("sys_user_grmember", {
          query: `user=${userSysId}`,
          fields: "group",
          limit: 500,
          displayValue: "all",
        });
      });
    },
  );

  server.registerTool(
    "get_group_members",
    {
      description: "List all active users in a group. Provide either groupSysId or groupName.",
      inputSchema: {
        groupSysId: z.string().optional().describe("sys_id of the group"),
        groupName: z
          .string()
          .optional()
          .describe("Exact name of the group (used when groupSysId not provided)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(100)
          .describe("Max members to return (default 100)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ groupSysId, groupName, limit }) => {
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
        return client.listRecords("sys_user_grmember", {
          query: `group=${resolvedSysId}^user.active=true`,
          fields: "user",
          limit: limit ?? 100,
          displayValue: "all",
        });
      });
    },
  );

  server.registerTool(
    "get_user_direct_roles",
    {
      description:
        "Get roles directly assigned to a user (not via group membership). Set includeInherited=true to also see role-containment assignments.",
      inputSchema: {
        userSysId: z.string().describe("sys_id of the user"),
        includeInherited: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include inherited role records (default false — direct only)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ userSysId, includeInherited }) => {
      return wrapTool(async () => {
        const query = includeInherited
          ? `user=${userSysId}^state=active`
          : `user=${userSysId}^state=active^inherited=false`;
        return client.listRecords("sys_user_has_role", {
          query,
          fields: "role,inherited",
          limit: 500,
          displayValue: "all",
        });
      });
    },
  );

  server.registerTool(
    "get_user_effective_roles",
    {
      description:
        "Get all effective roles for a user: direct assignments plus roles from all group memberships. One level of group expansion is performed. Role containment chains are not recursively expanded — use get_role_contains_roles for that.",
      inputSchema: {
        userSysId: z.string().describe("sys_id of the user"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ userSysId }) => {
      return wrapTool(async () => {
        const [directRoles, groupMemberships] = await Promise.all([
          client.listRecords("sys_user_has_role", {
            query: `user=${userSysId}^state=active`,
            fields: "role,inherited",
            limit: 500,
            displayValue: "all",
          }),
          client.listRecords("sys_user_grmember", {
            query: `user=${userSysId}`,
            fields: "group",
            limit: 500,
            displayValue: "all",
          }),
        ]);

        // Collect unique group sys_ids
        const groupSysIds: string[] = [];
        for (const m of groupMemberships) {
          const id = extractRefValue(m.group);
          if (id) groupSysIds.push(id);
        }

        let groupRoles: typeof directRoles = [];
        if (groupSysIds.length > 0) {
          groupRoles = await client.listRecords("sys_group_has_role", {
            query: `groupIN${groupSysIds.join(",")}`,
            fields: "role,group",
            limit: 500,
            displayValue: "all",
          });
        }

        return {
          direct_roles: directRoles,
          group_derived_roles: groupRoles,
          groups_evaluated: groupMemberships.length,
          summary: {
            direct_role_count: directRoles.length,
            group_derived_role_count: groupRoles.length,
            note: "Role containment chains (roles that grant other roles) are not expanded here. Use get_role_contains_roles to inspect containment.",
          },
        };
      });
    },
  );

  server.registerTool(
    "get_group_roles",
    {
      description: "Get roles assigned to a group. Provide either groupSysId or groupName.",
      inputSchema: {
        groupSysId: z.string().optional().describe("sys_id of the group"),
        groupName: z
          .string()
          .optional()
          .describe("Exact name of the group (used when groupSysId not provided)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ groupSysId, groupName }) => {
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
        return client.listRecords("sys_group_has_role", {
          query: `group=${resolvedSysId}`,
          fields: "role,group",
          limit: 500,
          displayValue: "all",
        });
      });
    },
  );

  server.registerTool(
    "get_roles",
    {
      description: "Search and list available ServiceNow roles.",
      inputSchema: {
        nameFilter: z
          .string()
          .optional()
          .describe("Filter roles whose name contains this string"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(50)
          .describe("Max roles to return (default 50)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ nameFilter, limit }) => {
      return wrapTool(async () => {
        const query = nameFilter ? `nameLIKE${nameFilter}` : "";
        return client.listRecords("sys_user_role", {
          query,
          fields: "sys_id,name,description,can_delegate",
          limit: limit ?? 50,
        });
      });
    },
  );

  server.registerTool(
    "get_groups",
    {
      description: "Search and list ServiceNow user groups.",
      inputSchema: {
        nameFilter: z
          .string()
          .optional()
          .describe("Filter groups whose name contains this string"),
        activeOnly: z
          .boolean()
          .optional()
          .default(true)
          .describe("Return only active groups (default true)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(50)
          .describe("Max groups to return (default 50)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ nameFilter, activeOnly, limit }) => {
      return wrapTool(async () => {
        const parts: string[] = [];
        if (activeOnly) parts.push("active=true");
        if (nameFilter) parts.push(`nameLIKE${nameFilter}`);
        const query = parts.join("^");
        return client.listRecords("sys_user_group", {
          query,
          fields: "sys_id,name,description,manager,active,type",
          limit: limit ?? 50,
          displayValue: "true",
        });
      });
    },
  );

  server.registerTool(
    "get_role_contains_roles",
    {
      description:
        "List the sub-roles that a given role contains (i.e. roles automatically granted when this role is assigned). Provide either roleSysId or roleName.",
      inputSchema: {
        roleSysId: z.string().optional().describe("sys_id of the role"),
        roleName: z
          .string()
          .optional()
          .describe("Name of the role (e.g. 'itil', 'admin')"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ roleSysId, roleName }) => {
      return wrapTool(async () => {
        let resolvedSysId = roleSysId;
        if (!resolvedSysId) {
          if (!roleName) throw new Error("Either roleSysId or roleName must be provided");
          const roles = await client.listRecords("sys_user_role", {
            query: `name=${roleName}`,
            fields: "sys_id,name",
            limit: 1,
          });
          if (roles.length === 0) throw new Error(`No role found with name: ${roleName}`);
          resolvedSysId = roles[0].sys_id as string;
        }
        const containedRoles = await client.listRecords("sys_user_role_contains", {
          query: `role=${resolvedSysId}`,
          fields: "contains",
          limit: 500,
          displayValue: "all",
        });
        return {
          role_sys_id: resolvedSysId,
          role_name: roleName,
          contains_roles: containedRoles,
          count: containedRoles.length,
          note: "These are the roles automatically granted when the parent role is assigned.",
        };
      });
    },
  );

  server.registerTool(
    "get_role_contained_by",
    {
      description:
        "List the parent roles that contain a given role (i.e. which roles, when assigned, would also grant this role). Provide either roleSysId or roleName.",
      inputSchema: {
        roleSysId: z.string().optional().describe("sys_id of the role"),
        roleName: z
          .string()
          .optional()
          .describe("Name of the role (e.g. 'itil', 'catalog')"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ roleSysId, roleName }) => {
      return wrapTool(async () => {
        let resolvedSysId = roleSysId;
        if (!resolvedSysId) {
          if (!roleName) throw new Error("Either roleSysId or roleName must be provided");
          const roles = await client.listRecords("sys_user_role", {
            query: `name=${roleName}`,
            fields: "sys_id,name",
            limit: 1,
          });
          if (roles.length === 0) throw new Error(`No role found with name: ${roleName}`);
          resolvedSysId = roles[0].sys_id as string;
        }
        const parentRoles = await client.listRecords("sys_user_role_contains", {
          query: `contains=${resolvedSysId}`,
          fields: "role",
          limit: 500,
          displayValue: "all",
        });
        return {
          role_sys_id: resolvedSysId,
          role_name: roleName,
          contained_by_roles: parentRoles,
          count: parentRoles.length,
          note: "Assigning any of these parent roles would also grant the queried role.",
        };
      });
    },
  );

  // ─── Composed Tools ───────────────────────────────────────────────────────────

  server.registerTool(
    "compare_user_groups",
    {
      description:
        "Compare the group memberships of two users. Returns groups only user1 has, groups only user2 has, and groups they share.",
      inputSchema: {
        userSysId1: z.string().describe("sys_id of the first user"),
        userSysId2: z.string().describe("sys_id of the second user"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ userSysId1, userSysId2 }) => {
      return wrapTool(async () => {
        const [memberships1, memberships2] = await Promise.all([
          client.listRecords("sys_user_grmember", {
            query: `user=${userSysId1}`,
            fields: "group",
            limit: 500,
            displayValue: "all",
          }),
          client.listRecords("sys_user_grmember", {
            query: `user=${userSysId2}`,
            fields: "group",
            limit: 500,
            displayValue: "all",
          }),
        ]);

        const set1 = buildRefSet(memberships1, "group");
        const set2 = buildRefSet(memberships2, "group");
        const diff = diffSets(set1, set2);

        const buildList = (ids: string[], source: typeof memberships1) =>
          ids.map((id) => {
            const rec = source.find((r) => extractRefValue(r.group) === id);
            return { sys_id: id, name: extractRefDisplay(rec?.group) };
          });

        return {
          only_user1: buildList(diff.onlyInA, memberships1),
          shared: buildList(diff.shared, memberships1),
          only_user2: buildList(diff.onlyInB, memberships2),
          summary: {
            user1_total: set1.size,
            user2_total: set2.size,
            shared_count: diff.shared.length,
            only_user1_count: diff.onlyInA.length,
            only_user2_count: diff.onlyInB.length,
          },
        };
      });
    },
  );

  server.registerTool(
    "compare_user_direct_roles",
    {
      description:
        "Compare direct role assignments of two users. Returns roles only user1 has, roles only user2 has, and shared roles.",
      inputSchema: {
        userSysId1: z.string().describe("sys_id of the first user"),
        userSysId2: z.string().describe("sys_id of the second user"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ userSysId1, userSysId2 }) => {
      return wrapTool(async () => {
        const [roles1, roles2] = await Promise.all([
          client.listRecords("sys_user_has_role", {
            query: `user=${userSysId1}^state=active^inherited=false`,
            fields: "role",
            limit: 500,
            displayValue: "all",
          }),
          client.listRecords("sys_user_has_role", {
            query: `user=${userSysId2}^state=active^inherited=false`,
            fields: "role",
            limit: 500,
            displayValue: "all",
          }),
        ]);

        const set1 = buildRefSet(roles1, "role");
        const set2 = buildRefSet(roles2, "role");
        const diff = diffSets(set1, set2);

        const buildList = (ids: string[], source: typeof roles1) =>
          ids.map((id) => {
            const rec = source.find((r) => extractRefValue(r.role) === id);
            return { sys_id: id, name: extractRefDisplay(rec?.role) };
          });

        return {
          only_user1: buildList(diff.onlyInA, roles1),
          shared: buildList(diff.shared, roles1),
          only_user2: buildList(diff.onlyInB, roles2),
          summary: {
            user1_total: set1.size,
            user2_total: set2.size,
            shared_count: diff.shared.length,
            only_user1_count: diff.onlyInA.length,
            only_user2_count: diff.onlyInB.length,
          },
        };
      });
    },
  );

  server.registerTool(
    "compare_user_effective_roles",
    {
      description:
        "Compare the effective roles (direct + group-derived) of two users. Returns roles only user1 has, roles only user2 has, and shared roles.",
      inputSchema: {
        userSysId1: z.string().describe("sys_id of the first user"),
        userSysId2: z.string().describe("sys_id of the second user"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ userSysId1, userSysId2 }) => {
      return wrapTool(async () => {
        async function getEffectiveRoleIds(userSysId: string): Promise<Map<string, string>> {
          const [directRoles, groupMemberships] = await Promise.all([
            client.listRecords("sys_user_has_role", {
              query: `user=${userSysId}^state=active`,
              fields: "role",
              limit: 500,
              displayValue: "all",
            }),
            client.listRecords("sys_user_grmember", {
              query: `user=${userSysId}`,
              fields: "group",
              limit: 500,
              displayValue: "all",
            }),
          ]);

          const roleMap = new Map<string, string>();
          for (const r of directRoles) {
            const id = extractRefValue(r.role);
            const name = extractRefDisplay(r.role);
            if (id) roleMap.set(id, name ?? id);
          }

          const groupIds = groupMemberships
            .map((m) => extractRefValue(m.group))
            .filter((id): id is string => Boolean(id));

          if (groupIds.length > 0) {
            const groupRoles = await client.listRecords("sys_group_has_role", {
              query: `groupIN${groupIds.join(",")}`,
              fields: "role",
              limit: 500,
              displayValue: "all",
            });
            for (const r of groupRoles) {
              const id = extractRefValue(r.role);
              const name = extractRefDisplay(r.role);
              if (id && !roleMap.has(id)) roleMap.set(id, name ?? id);
            }
          }

          return roleMap;
        }

        const [map1, map2] = await Promise.all([
          getEffectiveRoleIds(userSysId1),
          getEffectiveRoleIds(userSysId2),
        ]);

        const diff = diffSets(new Set(map1.keys()), new Set(map2.keys()));

        return {
          only_user1: diff.onlyInA.map((id) => ({ sys_id: id, name: map1.get(id) })),
          shared: diff.shared.map((id) => ({ sys_id: id, name: map1.get(id) ?? map2.get(id) })),
          only_user2: diff.onlyInB.map((id) => ({ sys_id: id, name: map2.get(id) })),
          summary: {
            user1_effective_total: map1.size,
            user2_effective_total: map2.size,
            shared_count: diff.shared.length,
            only_user1_count: diff.onlyInA.length,
            only_user2_count: diff.onlyInB.length,
          },
        };
      });
    },
  );

  server.registerTool(
    "compare_user_access",
    {
      description:
        "Comprehensive access comparison between two users: groups, direct roles, and optionally effective roles (direct + group-derived). This is the primary access-review tool.",
      inputSchema: {
        userSysId1: z.string().describe("sys_id of the first user"),
        userSysId2: z.string().describe("sys_id of the second user"),
        includeEffectiveRoles: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include effective role comparison (default true; set false to skip group-role resolution)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ userSysId1, userSysId2, includeEffectiveRoles }) => {
      return wrapTool(async () => {
        // Run the four base fetches in parallel
        const [groups1, groups2, directRoles1, directRoles2] = await Promise.all([
          client.listRecords("sys_user_grmember", {
            query: `user=${userSysId1}`,
            fields: "group",
            limit: 500,
            displayValue: "all",
          }),
          client.listRecords("sys_user_grmember", {
            query: `user=${userSysId2}`,
            fields: "group",
            limit: 500,
            displayValue: "all",
          }),
          client.listRecords("sys_user_has_role", {
            query: `user=${userSysId1}^state=active^inherited=false`,
            fields: "role",
            limit: 500,
            displayValue: "all",
          }),
          client.listRecords("sys_user_has_role", {
            query: `user=${userSysId2}^state=active^inherited=false`,
            fields: "role",
            limit: 500,
            displayValue: "all",
          }),
        ]);

        // Helper to diff a field across two record lists
        function buildDiff(list1: typeof groups1, list2: typeof groups1, field: string) {
          const map1 = new Map<string, string>();
          const map2 = new Map<string, string>();
          for (const r of list1) {
            const id = extractRefValue(r[field]);
            const name = extractRefDisplay(r[field]);
            if (id) map1.set(id, name ?? id);
          }
          for (const r of list2) {
            const id = extractRefValue(r[field]);
            const name = extractRefDisplay(r[field]);
            if (id) map2.set(id, name ?? id);
          }
          const d = diffSets(new Set(map1.keys()), new Set(map2.keys()));
          return {
            only_user1: d.onlyInA.map((id) => ({ sys_id: id, name: map1.get(id) })),
            shared: d.shared.map((id) => ({ sys_id: id, name: map1.get(id) ?? map2.get(id) })),
            only_user2: d.onlyInB.map((id) => ({ sys_id: id, name: map2.get(id) })),
            counts: {
              user1_total: map1.size,
              user2_total: map2.size,
              only_user1: d.onlyInA.length,
              shared: d.shared.length,
              only_user2: d.onlyInB.length,
            },
          };
        }

        const result: Record<string, unknown> = {
          groups: buildDiff(groups1, groups2, "group"),
          direct_roles: buildDiff(directRoles1, directRoles2, "role"),
        };

        if (includeEffectiveRoles) {
          // Collect group ids for both users to fetch group roles
          const getGroupIds = (memberships: typeof groups1) =>
            memberships
              .map((m) => extractRefValue(m.group))
              .filter((id): id is string => Boolean(id));

          const gids1 = getGroupIds(groups1);
          const gids2 = getGroupIds(groups2);

          const [groupRoles1, groupRoles2] = await Promise.all([
            gids1.length > 0
              ? client.listRecords("sys_group_has_role", {
                  query: `groupIN${gids1.join(",")}`,
                  fields: "role",
                  limit: 500,
                  displayValue: "all",
                })
              : Promise.resolve([]),
            gids2.length > 0
              ? client.listRecords("sys_group_has_role", {
                  query: `groupIN${gids2.join(",")}`,
                  fields: "role",
                  limit: 500,
                  displayValue: "all",
                })
              : Promise.resolve([]),
          ]);

          // Merge direct + group roles for effective view
          const mergeRoles = (direct: typeof directRoles1, fromGroups: typeof directRoles1) => {
            const map = new Map<string, string>();
            for (const r of [...direct, ...fromGroups]) {
              const id = extractRefValue(r.role);
              const name = extractRefDisplay(r.role);
              if (id && !map.has(id)) map.set(id, name ?? id);
            }
            return map;
          };

          const eff1 = mergeRoles(directRoles1, groupRoles1);
          const eff2 = mergeRoles(directRoles2, groupRoles2);
          const d = diffSets(new Set(eff1.keys()), new Set(eff2.keys()));

          result.effective_roles = {
            only_user1: d.onlyInA.map((id) => ({ sys_id: id, name: eff1.get(id) })),
            shared: d.shared.map((id) => ({ sys_id: id, name: eff1.get(id) ?? eff2.get(id) })),
            only_user2: d.onlyInB.map((id) => ({ sys_id: id, name: eff2.get(id) })),
            counts: {
              user1_total: eff1.size,
              user2_total: eff2.size,
              only_user1: d.onlyInA.length,
              shared: d.shared.length,
              only_user2: d.onlyInB.length,
            },
          };
        }

        return result;
      });
    },
  );

  server.registerTool(
    "explain_user_role_source",
    {
      description:
        "Explain exactly how a user has (or doesn't have) a specific role: direct assignment, which group grants it, or role containment chain.",
      inputSchema: {
        userSysId: z.string().describe("sys_id of the user"),
        roleName: z.string().describe("Name of the role to explain (e.g. 'itil', 'admin')"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ userSysId, roleName }) => {
      return wrapTool(async () => {
        // Resolve role sys_id
        const roleRecords = await client.listRecords("sys_user_role", {
          query: `name=${roleName}`,
          fields: "sys_id,name,description",
          limit: 1,
        });
        if (roleRecords.length === 0) {
          return { role: roleName, found: false, message: `Role '${roleName}' does not exist in this instance.` };
        }
        const roleSysId = roleRecords[0].sys_id as string;

        // Check all three sources in parallel
        const [directAssignment, groupMemberships] = await Promise.all([
          client.listRecords("sys_user_has_role", {
            query: `user=${userSysId}^role.name=${roleName}^state=active`,
            fields: "role,inherited",
            limit: 5,
            displayValue: "all",
          }),
          client.listRecords("sys_user_grmember", {
            query: `user=${userSysId}`,
            fields: "group",
            limit: 500,
            displayValue: "all",
          }),
        ]);

        const sources: unknown[] = [];

        // Direct assignment
        if (directAssignment.length > 0) {
          sources.push({
            type: "direct",
            inherited: directAssignment[0].inherited,
            detail: "Role is directly assigned to the user.",
          });
        }

        // Group-derived
        const groupIds = groupMemberships
          .map((m) => extractRefValue(m.group))
          .filter((id): id is string => Boolean(id));

        if (groupIds.length > 0) {
          const groupsWithRole = await client.listRecords("sys_group_has_role", {
            query: `groupIN${groupIds.join(",")}^role=${roleSysId}`,
            fields: "group,role",
            limit: 50,
            displayValue: "all",
          });
          for (const g of groupsWithRole) {
            sources.push({
              type: "group",
              group_name: extractRefDisplay(g.group),
              group_sys_id: extractRefValue(g.group),
              detail: `Role is granted via membership in group '${extractRefDisplay(g.group)}'.`,
            });
          }
        }

        // Role containment — check if any directly-assigned role contains this role
        if (sources.length === 0) {
          // No direct or group source found; check if any of the user's roles contain the target role
          const userDirectRoles = await client.listRecords("sys_user_has_role", {
            query: `user=${userSysId}^state=active^inherited=false`,
            fields: "role",
            limit: 500,
            displayValue: "all",
          });
          const directRoleIds = userDirectRoles
            .map((r) => extractRefValue(r.role))
            .filter((id): id is string => Boolean(id));

          if (directRoleIds.length > 0) {
            const containmentRecords = await client.listRecords("sys_user_role_contains", {
              query: `roleIN${directRoleIds.join(",")}^contains=${roleSysId}`,
              fields: "role,contains",
              limit: 50,
              displayValue: "all",
            });
            for (const c of containmentRecords) {
              sources.push({
                type: "role_containment",
                via_role_name: extractRefDisplay(c.role),
                via_role_sys_id: extractRefValue(c.role),
                detail: `Role '${roleName}' is contained within directly-assigned role '${extractRefDisplay(c.role)}'.`,
              });
            }
          }
        }

        return {
          role: roleName,
          role_sys_id: roleSysId,
          user_sys_id: userSysId,
          has_role: sources.length > 0,
          sources,
          summary:
            sources.length === 0
              ? `User does not have role '${roleName}' via any known assignment path.`
              : `User has role '${roleName}' via ${sources.length} source(s): ${(sources as Array<{ type: string }>).map((s) => s.type).join(", ")}.`,
        };
      });
    },
  );

  server.registerTool(
    "compare_group_access",
    {
      description:
        "Compare two groups: their member overlap and role overlap. Provide groupSysId or groupName for each.",
      inputSchema: {
        groupSysId1: z.string().optional().describe("sys_id of the first group"),
        groupName1: z.string().optional().describe("Name of the first group"),
        groupSysId2: z.string().optional().describe("sys_id of the second group"),
        groupName2: z.string().optional().describe("Name of the second group"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ groupSysId1, groupName1, groupSysId2, groupName2 }) => {
      return wrapTool(async () => {
        async function resolveGroup(sysId?: string, name?: string): Promise<string> {
          if (sysId) return sysId;
          if (!name) throw new Error("Provide either groupSysId or groupName for each group");
          const groups = await client.listRecords("sys_user_group", {
            query: `name=${name}`,
            fields: "sys_id,name",
            limit: 1,
          });
          if (groups.length === 0) throw new Error(`No group found with name: ${name}`);
          return groups[0].sys_id as string;
        }

        const [id1, id2] = await Promise.all([
          resolveGroup(groupSysId1, groupName1),
          resolveGroup(groupSysId2, groupName2),
        ]);

        const [members1, members2, roles1, roles2] = await Promise.all([
          client.listRecords("sys_user_grmember", {
            query: `group=${id1}^user.active=true`,
            fields: "user",
            limit: 500,
            displayValue: "all",
          }),
          client.listRecords("sys_user_grmember", {
            query: `group=${id2}^user.active=true`,
            fields: "user",
            limit: 500,
            displayValue: "all",
          }),
          client.listRecords("sys_group_has_role", {
            query: `group=${id1}`,
            fields: "role",
            limit: 500,
            displayValue: "all",
          }),
          client.listRecords("sys_group_has_role", {
            query: `group=${id2}`,
            fields: "role",
            limit: 500,
            displayValue: "all",
          }),
        ]);

        function buildDiffFromField(list1: typeof members1, list2: typeof members1, field: string) {
          const map1 = new Map<string, string>();
          const map2 = new Map<string, string>();
          for (const r of list1) {
            const id = extractRefValue(r[field]);
            const name = extractRefDisplay(r[field]);
            if (id) map1.set(id, name ?? id);
          }
          for (const r of list2) {
            const id = extractRefValue(r[field]);
            const name = extractRefDisplay(r[field]);
            if (id) map2.set(id, name ?? id);
          }
          const d = diffSets(new Set(map1.keys()), new Set(map2.keys()));
          return {
            only_group1: d.onlyInA.map((id) => ({ sys_id: id, name: map1.get(id) })),
            shared: d.shared.map((id) => ({ sys_id: id, name: map1.get(id) ?? map2.get(id) })),
            only_group2: d.onlyInB.map((id) => ({ sys_id: id, name: map2.get(id) })),
            counts: {
              group1_total: map1.size,
              group2_total: map2.size,
              only_group1: d.onlyInA.length,
              shared: d.shared.length,
              only_group2: d.onlyInB.length,
            },
          };
        }

        return {
          members: buildDiffFromField(members1, members2, "user"),
          roles: buildDiffFromField(roles1, roles2, "role"),
        };
      });
    },
  );
}
