/**
 * Microsoft Graph / OneNote service for Medusa Mac desktop app.
 *
 * Uses OAuth 2.0 device code flow — no redirect URI required, ideal for
 * desktop apps. The user visits a short URL and enters a code; the server
 * polls until the token arrives.
 *
 * Token lifecycle:
 *   - Access token (~1h) is refreshed automatically before expiry
 *   - Refresh token is persisted in ~/.claude-chat/settings.json
 */

import https from "https";

// ---- Types ------------------------------------------------------------------

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;   // seconds
  interval: number;    // polling interval in seconds
}

export interface MsalTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export type OneNoteStatus = "disconnected" | "pending" | "connected" | "error";

// ---- Constants --------------------------------------------------------------

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TOKEN_URL_BASE = "https://login.microsoftonline.com";
const DEVICE_CODE_SCOPE = "Notes.ReadWrite.All User.Read offline_access";

// ---- Helpers ----------------------------------------------------------------

function httpsPost(url: string, body: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => {
          // Reject on HTTP error so callers get status context
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(extractMsError(data)));
          } else {
            resolve(data);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Extracts a clean human-readable error message from a Microsoft API error response.
 * Microsoft returns verbose JSON with error_description, trace IDs, timestamps, etc.
 * We only surface the error_description (first line) or fall back to the error code.
 */
function extractMsError(raw: string): string {
  try {
    const data = JSON.parse(raw) as {
      error?: string;
      error_description?: string;
      message?: string;
    };
    if (data.error_description) {
      // error_description is multi-line — first line is the human-readable part
      return data.error_description.split("\r\n")[0].split("\n")[0].trim();
    }
    if (data.error) return data.error;
    if (data.message) return data.message;
  } catch {
    // Not JSON — return truncated raw string
  }
  return raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
}

/**
 * Like httpsPost but always resolves with the raw body — even on 4xx.
 * Used by _pollToken so it can inspect data.error directly ("authorization_pending",
 * "slow_down") without the extractMsError transformation clobbering those codes.
 */
function httpsPostRaw(url: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpsPostJson(url: string, body: unknown, token: string): Promise<string> {
  const bodyStr = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "Content-Length": Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function httpsPostHtml(url: string, html: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const buf = Buffer.from(html, "utf-8");
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Authorization": `Bearer ${token}`,
          "Content-Length": buf.byteLength,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

function httpsGet(url: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        headers: { "Authorization": `Bearer ${token}` },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// ---- OneNoteService ---------------------------------------------------------

export class OneNoteService {
  private clientId: string;
  private tenantId: string;

  // Live state (in-memory, not persisted between restarts unless token is passed in)
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiry: number = 0; // unix ms

  // Device code flow polling state
  private pendingDeviceCode: string | null = null;
  private pendingInterval: number = 5;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollResolve: ((tok: MsalTokenResponse) => void) | null = null;
  private pollReject: ((err: Error) => void) | null = null;

  // Callbacks for token persistence
  private onTokenUpdate: ((tokens: { accessToken: string; refreshToken: string; expiry: number }) => void) | null = null;

  constructor(clientId: string, tenantId = "common") {
    this.clientId = clientId;
    this.tenantId = tenantId;
  }

  /** Register a callback to persist tokens when they change. */
  setTokenUpdateCallback(
    cb: (tokens: { accessToken: string; refreshToken: string; expiry: number }) => void
  ): void {
    this.onTokenUpdate = cb;
  }

  /** Restore persisted tokens (call on startup). */
  restoreTokens(accessToken: string, refreshToken: string, expiry: number): void {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.tokenExpiry = expiry;
  }

  getClientId(): string { return this.clientId; }

  getStatus(): OneNoteStatus {
    if (this.pendingDeviceCode) return "pending";
    if (this.accessToken) return "connected";
    return "disconnected";
  }

  /** Step 1: Start device code flow. Returns user-facing code + URL. */
  async startDeviceCodeFlow(): Promise<DeviceCodeResponse> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      scope: DEVICE_CODE_SCOPE,
    }).toString();

    const url = `${TOKEN_URL_BASE}/${this.tenantId}/oauth2/v2.0/devicecode`;
    const raw = await httpsPost(url, body, {});
    const data = JSON.parse(raw) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
      message?: string;
    };

    if (!data.device_code) {
      throw new Error(extractMsError(raw));
    }

    this.pendingDeviceCode = data.device_code;
    this.pendingInterval = data.interval ?? 5;

    // Start background polling
    this._startPolling();

    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUrl: data.verification_uri,
      expiresIn: data.expires_in,
      interval: data.interval,
    };
  }

  private _startPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);

    const poll = async () => {
      if (!this.pendingDeviceCode) return;
      try {
        const tok = await this._pollToken(this.pendingDeviceCode);
        // Success
        this._applyToken(tok);
        this.pendingDeviceCode = null;
        if (this.pollResolve) this.pollResolve(tok);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("authorization_pending") || msg.includes("slow_down")) {
          // Keep polling
          this.pollTimer = setTimeout(poll, this.pendingInterval * 1000);
        } else {
          // Fatal error
          this.pendingDeviceCode = null;
          if (this.pollReject) this.pollReject(err instanceof Error ? err : new Error(msg));
        }
      }
    };

    this.pollTimer = setTimeout(poll, this.pendingInterval * 1000);
  }

  /** Waits for the device code flow to complete (resolves when user logs in). */
  waitForAuth(): Promise<MsalTokenResponse> {
    return new Promise((resolve, reject) => {
      this.pollResolve = resolve;
      this.pollReject = reject;
    });
  }

  private async _pollToken(deviceCode: string): Promise<MsalTokenResponse> {
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth2:grant-type:device_code",
      client_id: this.clientId,
      device_code: deviceCode,
    }).toString();

    const url = `${TOKEN_URL_BASE}/${this.tenantId}/oauth2/v2.0/token`;
    // Use httpsPostRaw (always resolves) so we can inspect data.error directly.
    // The poll loop checks for "authorization_pending" / "slow_down" by exact string —
    // extractMsError would replace these with human-readable descriptions, breaking the check.
    const raw = await httpsPostRaw(url, body);
    const data = JSON.parse(raw) as { error?: string; error_description?: string } & Partial<MsalTokenResponse>;

    if (data.error) {
      // Throw the raw error code so the poll loop's includes() checks still work
      throw new Error(data.error);
    }
    return data as MsalTokenResponse;
  }

  private _applyToken(tok: MsalTokenResponse): void {
    this.accessToken = tok.access_token;
    if (tok.refresh_token) this.refreshToken = tok.refresh_token;
    this.tokenExpiry = Date.now() + tok.expires_in * 1000;
    if (this.onTokenUpdate && this.accessToken && this.refreshToken) {
      this.onTokenUpdate({
        accessToken: this.accessToken,
        refreshToken: this.refreshToken,
        expiry: this.tokenExpiry,
      });
    }
  }

  /** Returns a valid access token, refreshing if needed. */
  async getAccessToken(): Promise<string> {
    if (!this.accessToken) throw new Error("Not authenticated — start device code flow first");

    // Refresh 2 minutes before expiry
    if (Date.now() > this.tokenExpiry - 2 * 60 * 1000) {
      await this._refreshToken();
    }
    return this.accessToken;
  }

  private async _refreshToken(): Promise<void> {
    if (!this.refreshToken) throw new Error("No refresh token available");

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.clientId,
      refresh_token: this.refreshToken,
      scope: DEVICE_CODE_SCOPE,
    }).toString();

    const url = `${TOKEN_URL_BASE}/${this.tenantId}/oauth2/v2.0/token`;
    const raw = await httpsPost(url, body, {});
    const data = JSON.parse(raw) as { error?: string } & Partial<MsalTokenResponse>;

    if (data.error) {
      const desc = (data as { error_description?: string }).error_description;
      const clean = desc ? desc.split("\r\n")[0].split("\n")[0].trim() : data.error;
      throw new Error(`Token refresh failed: ${clean}`);
    }
    this._applyToken(data as MsalTokenResponse);
  }

  /** Disconnect — clears tokens. */
  disconnect(): void {
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = 0;
    this.pendingDeviceCode = null;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  /** Get user's default OneNote notebook list. */
  async getNotebooks(): Promise<Array<{ id: string; displayName: string }>> {
    const token = await this.getAccessToken();
    const { status, body } = await httpsGet(`${GRAPH_BASE}/me/onenote/notebooks`, token);
    if (status !== 200) throw new Error(`Graph API ${status}: ${body}`);
    const data = JSON.parse(body) as { value: Array<{ id: string; displayName: string }> };
    return data.value;
  }

  /**
   * Write content to OneNote.
   * Creates a page in the specified section (or "Medusa" notebook → "General" section by default).
   * @param title   Page title
   * @param content HTML body content
   * @param notebookName  Target notebook display name (default: "Medusa")
   * @param sectionName   Target section display name (default: "General")
   */
  async writePage(
    title: string,
    content: string,
    notebookName = "Medusa",
    sectionName = "General"
  ): Promise<{ id: string; webUrl: string }> {
    const token = await this.getAccessToken();

    // Get or create notebook
    const sectionId = await this._getOrCreateSection(token, notebookName, sectionName);

    // Build the HTML page
    const now = new Date().toLocaleString("en-US", {
      weekday: "short", year: "numeric", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>${escHtml(title)}</title>
  <meta name="created" content="${new Date().toISOString()}" />
</head>
<body>
  <h1>${escHtml(title)}</h1>
  <p style="color:#888;font-size:12px;">Created by Medusa · ${escHtml(now)}</p>
  ${content}
</body>
</html>`;

    const url = `${GRAPH_BASE}/me/onenote/sections/${sectionId}/pages`;
    const { status, body } = await httpsPostHtml(url, html, token);

    if (status !== 201) throw new Error(`OneNote page creation failed (${status}): ${body}`);
    const page = JSON.parse(body) as { id: string; links?: { oneNoteWebUrl?: { href: string } } };
    return {
      id: page.id,
      webUrl: page.links?.oneNoteWebUrl?.href ?? "",
    };
  }

  private async _getOrCreateSection(token: string, notebookName: string, sectionName: string): Promise<string> {
    // Find or create notebook
    const nbRes = await httpsGet(`${GRAPH_BASE}/me/onenote/notebooks?$filter=displayName eq '${encodeURIComponent(notebookName)}'`, token);
    let notebookId: string;

    if (nbRes.status === 200) {
      const nb = JSON.parse(nbRes.body) as { value: Array<{ id: string }> };
      if (nb.value.length > 0) {
        notebookId = nb.value[0].id;
      } else {
        // Create notebook
        const createRes = await httpsPostJson(`${GRAPH_BASE}/me/onenote/notebooks`, { displayName: notebookName }, token);
        const created = JSON.parse(createRes) as { id: string };
        notebookId = created.id;
      }
    } else {
      throw new Error(`Failed to query notebooks: ${nbRes.status}`);
    }

    // Find or create section
    const secRes = await httpsGet(
      `${GRAPH_BASE}/me/onenote/notebooks/${notebookId}/sections?$filter=displayName eq '${encodeURIComponent(sectionName)}'`,
      token
    );
    if (secRes.status === 200) {
      const sec = JSON.parse(secRes.body) as { value: Array<{ id: string }> };
      if (sec.value.length > 0) return sec.value[0].id;
      // Create section
      const createSec = await httpsPostJson(
        `${GRAPH_BASE}/me/onenote/notebooks/${notebookId}/sections`,
        { displayName: sectionName },
        token
      );
      const created = JSON.parse(createSec) as { id: string };
      return created.id;
    }
    throw new Error(`Failed to query sections: ${secRes.status}`);
  }
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
