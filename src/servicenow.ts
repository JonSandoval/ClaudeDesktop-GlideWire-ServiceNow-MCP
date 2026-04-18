import { TokenManager } from "./auth.js";
import {
  TableRecord,
  ServiceNowApiError,
  ServiceNowErrorBody,
  AggregateParams,
} from "./types.js";

const TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;
const SYS_ID_RE = /^[a-f0-9]{32}$/;
const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 60_000;

function validateTableName(name: string): void {
  if (!TABLE_NAME_RE.test(name)) {
    throw new ServiceNowApiError(400, `Invalid table name: "${name}"`);
  }
}

function validateSysId(sysId: string): void {
  if (!SYS_ID_RE.test(sysId)) {
    throw new ServiceNowApiError(400, `Invalid sys_id: "${sysId}"`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ListRecordsParams {
  query?: string;
  fields?: string;
  limit?: number;
  offset?: number;
  displayValue?: string;
}

export interface GetRecordParams {
  fields?: string;
  displayValue?: string;
}

export class ServiceNowClient {
  private readonly instanceUrl: string;
  private readonly tokenManager: TokenManager;

  constructor(instanceUrl: string, tokenManager: TokenManager) {
    this.instanceUrl = instanceUrl;
    this.tokenManager = tokenManager;
  }

  async listRecords(
    tableName: string,
    params: ListRecordsParams = {},
  ): Promise<TableRecord[]> {
    validateTableName(tableName);

    const queryParams: Record<string, string> = {};
    if (params.query) queryParams.sysparm_query = params.query;
    if (params.fields) queryParams.sysparm_fields = params.fields;
    if (params.displayValue) queryParams.sysparm_display_value = params.displayValue;
    queryParams.sysparm_limit = String(Math.min(params.limit ?? 50, 500));
    queryParams.sysparm_offset = String(params.offset ?? 0);

    return this.request<TableRecord[]>("GET", `/api/now/table/${tableName}`, {
      params: queryParams,
    });
  }

  async getRecord(
    tableName: string,
    sysId: string,
    params: GetRecordParams = {},
  ): Promise<TableRecord> {
    validateTableName(tableName);
    validateSysId(sysId);

    const queryParams: Record<string, string> = {};
    if (params.fields) queryParams.sysparm_fields = params.fields;
    if (params.displayValue) queryParams.sysparm_display_value = params.displayValue;

    return this.request<TableRecord>("GET", `/api/now/table/${tableName}/${sysId}`, {
      params: queryParams,
    });
  }

  async createRecord(
    tableName: string,
    body: Record<string, unknown>,
  ): Promise<TableRecord> {
    validateTableName(tableName);

    return this.request<TableRecord>("POST", `/api/now/table/${tableName}`, { body });
  }

  async updateRecord(
    tableName: string,
    sysId: string,
    body: Record<string, unknown>,
  ): Promise<TableRecord> {
    validateTableName(tableName);
    validateSysId(sysId);

    return this.request<TableRecord>("PATCH", `/api/now/table/${tableName}/${sysId}`, {
      body,
    });
  }

  async aggregateRecords(
    tableName: string,
    params: AggregateParams = {},
  ): Promise<unknown> {
    validateTableName(tableName);

    const queryParams: Record<string, string> = {};
    if (params.query) queryParams.sysparm_query = params.query;
    if (params.groupBy) queryParams.sysparm_group_by = params.groupBy;
    if (params.having) queryParams.sysparm_having = params.having;
    if (params.orderBy) queryParams.sysparm_orderby = params.orderBy;
    if (params.count) queryParams.sysparm_count = "true";
    if (params.sumFields) queryParams.sysparm_sum_fields = params.sumFields;
    if (params.avgFields) queryParams.sysparm_avg_fields = params.avgFields;
    if (params.minFields) queryParams.sysparm_min_fields = params.minFields;
    if (params.maxFields) queryParams.sysparm_max_fields = params.maxFields;
    if (params.limit) queryParams.sysparm_limit = String(params.limit);

    return this.request<unknown>("GET", `/api/now/stats/${tableName}`, {
      params: queryParams,
    });
  }

  async listAttachments(
    tableName: string,
    tableSysId: string,
    params: { limit?: number; offset?: number } = {},
  ): Promise<TableRecord[]> {
    validateTableName(tableName);
    validateSysId(tableSysId);

    const queryParams: Record<string, string> = {
      sysparm_query: `table_name=${tableName}^table_sys_id=${tableSysId}`,
      sysparm_limit: String(Math.min(params.limit ?? 50, 500)),
      sysparm_offset: String(params.offset ?? 0),
    };

    return this.request<TableRecord[]>("GET", "/api/now/attachment", {
      params: queryParams,
    });
  }

  async uploadAttachment(
    tableName: string,
    tableSysId: string,
    fileName: string,
    contentType: string,
    base64Content: string,
  ): Promise<TableRecord> {
    validateTableName(tableName);
    validateSysId(tableSysId);

    const bytes = Buffer.from(base64Content, "base64");
    const url = new URL(`${this.instanceUrl}/api/now/attachment/file`);
    url.searchParams.set("table_name", tableName);
    url.searchParams.set("table_sys_id", tableSysId);
    url.searchParams.set("file_name", fileName);

    const response = await this.fetchWithAuth(url, "POST", {
      "Content-Type": contentType,
      Accept: "application/json",
    }, bytes);

    if (!response.ok) {
      await this.throwApiError(response);
    }

    const data = (await response.json()) as { result: TableRecord };
    return data.result;
  }

  async downloadAttachment(
    attachmentSysId: string,
  ): Promise<{ contentType: string; base64Content: string; fileName?: string }> {
    validateSysId(attachmentSysId);

    const url = new URL(`${this.instanceUrl}/api/now/attachment/${attachmentSysId}/file`);

    const response = await this.fetchWithAuth(url, "GET", {
      Accept: "*/*",
    }, undefined);

    if (!response.ok) {
      await this.throwApiError(response);
    }

    const contentType = response.headers.get("Content-Type") ?? "application/octet-stream";
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const fileNameMatch = /filename="?([^";]+)"?/.exec(disposition);
    const fileName = fileNameMatch?.[1];

    const arrayBuffer = await response.arrayBuffer();
    const base64Content = Buffer.from(arrayBuffer).toString("base64");

    return { contentType, base64Content, fileName };
  }

  private async throwApiError(response: Response): Promise<never> {
    let message = `ServiceNow API error: ${response.status} ${response.statusText}`;
    let detail: string | undefined;
    try {
      const errorBody = (await response.json()) as ServiceNowErrorBody;
      if (errorBody.error) {
        message = errorBody.error.message;
        detail = errorBody.error.detail;
      }
    } catch {
      // Response body wasn't JSON, use default message
    }
    throw new ServiceNowApiError(response.status, message, detail);
  }

  private async fetchWithAuth(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: BodyInit | undefined,
  ): Promise<Response> {
    let authRetried = false;
    let retries = 0;

    while (true) {
      const token = await this.tokenManager.getToken();

      const response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...headers },
        body,
      });

      // 401 - retry once with a fresh token
      if (response.status === 401 && !authRetried) {
        authRetried = true;
        this.tokenManager.invalidate();
        continue;
      }

      // 429 - rate limited, exponential backoff
      if (response.status === 429 && retries < MAX_RETRIES) {
        retries++;
        const retryAfter = response.headers.get("Retry-After");
        const waitMs = retryAfter
          ? Math.min(parseInt(retryAfter, 10) * 1000, MAX_RETRY_WAIT_MS)
          : Math.min(1000 * Math.pow(2, retries), MAX_RETRY_WAIT_MS);
        await sleep(waitMs);
        continue;
      }

      return response;
    }
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; params?: Record<string, string> } = {},
  ): Promise<T> {
    const url = new URL(`${this.instanceUrl}${path}`);
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await this.fetchWithAuth(url, method, {
      "Content-Type": "application/json",
      Accept: "application/json",
    }, options.body ? JSON.stringify(options.body) : undefined);

    if (!response.ok) {
      await this.throwApiError(response);
    }

    // Success
    const data = (await response.json()) as { result: T };
    return data.result;
  }
}
