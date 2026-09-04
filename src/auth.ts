import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { ServiceNowConfig, TokenResponse } from "./types.js";

const TOKEN_REFRESH_BUFFER_MS = 120_000;
const AUTH_TIMEOUT_MS = 120_000;
const DEFAULT_REDIRECT_PORT = 8443;

export type OAuthCallbackResult =
  | { type: "invalid_state" }
  | { type: "authorization_error"; error: string }
  | { type: "missing_code" }
  | { type: "success"; code: string };

/** Evaluate an OAuth callback, always validating state before other parameters. */
export function evaluateOAuthCallback(url: URL, expectedState: string): OAuthCallbackResult {
  if (url.searchParams.get("state") !== expectedState) {
    return { type: "invalid_state" };
  }

  const error = url.searchParams.get("error");
  if (error) {
    return { type: "authorization_error", error };
  }

  const code = url.searchParams.get("code");
  return code ? { type: "success", code } : { type: "missing_code" };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

export function renderOAuthErrorPage(error: string): string {
  return `<html><body><h1>Authorization Failed</h1><p>${escapeHtml(error)}</p><p>You can close this tab.</p></body></html>`;
}

export class TokenManager {
  private readonly instanceUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectPort: number;

  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private expiresAt = 0;
  private authPromise: Promise<string> | null = null;

  constructor(config: ServiceNowConfig) {
    this.instanceUrl = config.instanceUrl;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.redirectPort = config.redirectPort ?? DEFAULT_REDIRECT_PORT;
  }

  async getToken(): Promise<string> {
    // Valid cached token
    if (this.accessToken && Date.now() < this.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return this.accessToken;
    }

    // Deduplicate concurrent requests
    if (this.authPromise) {
      return this.authPromise;
    }

    // Try refresh, fall back to full authorization
    if (this.refreshToken) {
      this.authPromise = this.refreshAccessToken().finally(() => {
        this.authPromise = null;
      });
    } else {
      this.authPromise = this.authorize().finally(() => {
        this.authPromise = null;
      });
    }

    return this.authPromise;
  }

  invalidate(): void {
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
  }

  private get redirectUri(): string {
    return `http://localhost:${this.redirectPort}/callback`;
  }

  private async authorize(): Promise<string> {
    const state = randomBytes(32).toString("hex");

    const code = await this.startCallbackServer(state);

    return this.exchangeCodeForToken(code);
  }

  private startCallbackServer(state: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let callbackServer: Server;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          callbackServer?.close();
          reject(new Error("OAuth authorization timed out after 120 seconds. No callback received."));
        }
      }, AUTH_TIMEOUT_MS);

      callbackServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (settled) {
          res.writeHead(400);
          res.end();
          return;
        }

        const url = new URL(req.url ?? "/", `http://localhost:${this.redirectPort}`);

        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const callback = evaluateOAuthCallback(url, state);

        if (callback.type === "invalid_state") {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<html><body><h1>Invalid State</h1><p>CSRF validation failed. Please try again.</p></body></html>`);
          return;
        }

        if (callback.type === "authorization_error") {
          settled = true;
          clearTimeout(timeout);
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderOAuthErrorPage(callback.error));
          callbackServer.close();
          reject(new Error(`OAuth authorization denied: ${callback.error}`));
          return;
        }

        if (callback.type === "missing_code") {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<html><body><h1>Missing Code</h1><p>No authorization code received.</p></body></html>`);
          return;
        }

        settled = true;
        clearTimeout(timeout);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<html><body><h1>Authorization Successful</h1><p>You can close this tab and return to your application.</p></body></html>`);
        callbackServer.close();
        resolve(callback.code);
      });

      callbackServer.listen(this.redirectPort, "127.0.0.1", () => {
        const authUrl =
          `${this.instanceUrl}/oauth_auth.do` +
          `?response_type=code` +
          `&client_id=${encodeURIComponent(this.clientId)}` +
          `&redirect_uri=${encodeURIComponent(this.redirectUri)}` +
          `&state=${state}`;

        console.error(`\nOpen this URL to authorize:\n${authUrl}\n`);
        this.openBrowser(authUrl);
      });

      callbackServer.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Failed to start callback server on port ${this.redirectPort}: ${err.message}`));
        }
      });
    });
  }

  private openBrowser(url: string): void {
    const platform = process.platform;
    let command: string;
    let args: string[];

    if (platform === "win32") {
      command = "explorer.exe";
      args = [url];
    } else if (platform === "darwin") {
      command = "/usr/bin/open";
      args = [url];
    } else {
      command = "xdg-open";
      args = [url];
    }

    const child = spawn(command, args, {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => {
      console.error("Could not open browser automatically. Please open the URL above manually.");
    });
    child.unref();
  }

  private async exchangeCodeForToken(code: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
    });

    const response = await fetch(`${this.instanceUrl}/oauth_token.do`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!response.ok) {
      throw new Error(
        `Failed to exchange authorization code: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as TokenResponse;

    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token ?? null;
    this.expiresAt = Date.now() + data.expires_in * 1000;

    console.error("Successfully authenticated with ServiceNow.");

    return this.accessToken;
  }

  private async refreshAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken!,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const response = await fetch(`${this.instanceUrl}/oauth_token.do`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!response.ok) {
      // Refresh token expired or revoked — force full re-auth
      console.error("Refresh token expired. Re-authorization required.");
      this.invalidate();
      return this.authorize();
    }

    const data = (await response.json()) as TokenResponse;

    this.accessToken = data.access_token;
    if (data.refresh_token) {
      this.refreshToken = data.refresh_token;
    }
    this.expiresAt = Date.now() + data.expires_in * 1000;

    return this.accessToken;
  }
}
