/**
 * Cloud Adapter — connects to Mnemo Cloud API instead of local storage.
 *
 * Usage:
 *   import { createCloudMnemo } from "@mnemoai/pro/cloud-adapter";
 *   const mnemo = createCloudMnemo({ apiKey: "mn_xxx" });
 *   await mnemo.store({ text: "User prefers dark mode" });
 *   const results = await mnemo.recall("user preferences");
 */

// ── Types ──

export interface CloudConfig {
  /** Mnemo Cloud API key (starts with mn_) */
  apiKey: string;
  /** API endpoint. Default: https://api.m-nemo.ai */
  endpoint?: string;
}

export interface CloudMnemoInstance {
  store(entry: {
    text: string;
    category?: string;
    importance?: number;
    scope?: string;
  }): Promise<{ id: string }>;

  recall(query: string, options?: {
    limit?: number;
    scopeFilter?: string[];
    category?: string;
  }): Promise<Array<{
    text: string;
    score: number;
    category: string;
    importance: number;
    timestamp: number;
  }>>;

  delete(id: string): Promise<boolean>;

  stats(): Promise<{
    totalEntries: number;
    scopeCounts: Record<string, number>;
    categoryCounts: Record<string, number>;
  }>;
}

// ── Implementation ──

export function createCloudMnemo(config: CloudConfig): CloudMnemoInstance {
  const endpoint = (config.endpoint || "https://api.m-nemo.ai").replace(/\/$/, "");
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };

  async function request(method: string, path: string, body?: unknown): Promise<any> {
    const opts: RequestInit = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${endpoint}${path}`, opts);
    const data = await res.json() as any;

    if (!res.ok) {
      const msg = data?.error || `HTTP ${res.status}`;
      throw new Error(`Mnemo Cloud error: ${msg}`);
    }
    return data;
  }

  return {
    async store(entry) {
      return request("POST", "/v1/store", entry);
    },

    async recall(query, options = {}) {
      const data = await request("POST", "/v1/recall", { query, ...options });
      return data.results;
    },

    async delete(id) {
      const data = await request("DELETE", `/v1/memories/${id}`);
      return !!data.deleted;
    },

    async stats() {
      return request("GET", "/v1/stats");
    },
  };
}
