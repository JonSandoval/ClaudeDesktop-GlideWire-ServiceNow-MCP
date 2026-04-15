export interface ServiceNowConfig {
  instanceUrl: string;
  clientId: string;
  clientSecret: string;
  redirectPort?: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  scope: string;
  token_type: string;
  expires_in: number;
}

export type TableRecord = Record<string, unknown>;

export interface ServiceNowErrorBody {
  error: {
    message: string;
    detail: string;
  };
}

export class ServiceNowApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "ServiceNowApiError";
  }
}
