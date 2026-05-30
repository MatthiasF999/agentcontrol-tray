import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

const DEFAULT_HOST = "http://localhost:3001";

export interface BridgeHealth {
  ok: boolean;
  version?: string;
}

export type BridgePairingState =
  | { state: "unpaired"; claimUrl: string }
  | { state: "claimed"; claimCode: string; expiresAt: string }
  | { state: "paired"; bridgeId: string; orgId: string };

export interface BridgeAutonomousStatus {
  running_count: number;
  claimed_ids: string[];
  task_ids_pending_approval: string[];
}

export interface BridgeAcceptRequest {
  bridge_id: string;
  refresh_token: string;
  supabase_url: string;
}

export interface BridgeAcceptResponse {
  paired: true;
  bridge_id: string;
  org_id: string;
}

export class BridgeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export interface BridgeClientOptions {
  host?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export class BridgeClient {
  private readonly host: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;

  constructor(opts: BridgeClientOptions = {}) {
    this.host = opts.host ?? DEFAULT_HOST;
    this.apiKey = opts.apiKey ?? null;
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  async health(): Promise<BridgeHealth> {
    const res = await this.request("GET", "/health");
    return (await res.json()) as BridgeHealth;
  }

  async pairStatus(): Promise<BridgePairingState> {
    const res = await this.request("GET", "/pair");
    return (await res.json()) as BridgePairingState;
  }

  async autonomousStatus(): Promise<BridgeAutonomousStatus> {
    const res = await this.request("GET", "/autonomous/status");
    return (await res.json()) as BridgeAutonomousStatus;
  }

  async acceptPairing(req: BridgeAcceptRequest): Promise<BridgeAcceptResponse> {
    const res = await this.request("POST", "/pair/accept", req);
    return (await res.json()) as BridgeAcceptResponse;
  }

  async approveTask(taskId: string): Promise<void> {
    await this.request("POST", `/autonomous/approve/${encodeURIComponent(taskId)}`, {});
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey !== null) headers["Authorization"] = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);

    try {
      const res = await tauriFetch(`${this.host}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new BridgeError(
          `Bridge ${method} ${path} → ${res.status}`,
          res.status,
          text,
        );
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
}
