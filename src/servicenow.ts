import { TokenManager } from "./auth.js";
import {
  TableRecord,
  ServiceNowApiError,
  ServiceNowErrorBody,
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

    let authRetried = false;
    let retries = 0;

    while (true) {
      const token = await this.tokenManager.getToken();

      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
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

      // Error responses
      if (!response.ok) {
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

      // Success
      const data = (await response.json()) as { result: T };
      return data.result;
    }
  }
}
