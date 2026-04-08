/**
 * @mnemoai/client — Mnemo Cloud API client
 *
 * Usage:
 *   import { createCloudMnemo } from "@mnemoai/client";
 *   const mnemo = createCloudMnemo({ apiKey: "mn_xxx" });
 *   await mnemo.store({ text: "User prefers dark mode" });
 *   const results = await mnemo.recall("user preferences");
 */

/**
 * Create a Mnemo Cloud client instance.
 * @param {object} config
 * @param {string} config.apiKey - Mnemo Cloud API key (starts with mn_)
 * @param {string} [config.endpoint] - API endpoint. Default: https://api.m-nemo.ai
 * @returns {object} Mnemo client with store, recall, delete, stats methods
 */
export function createCloudMnemo(config) {
  const endpoint = (config.endpoint || "https://api.m-nemo.ai").replace(/\/$/, "");
  const headers = {
    "Authorization": `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };

  async function request(method, path, body) {
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${endpoint}${path}`, opts);
    const data = await res.json();

    if (!res.ok) {
      const msg = data?.error || `HTTP ${res.status}`;
      throw new Error(`Mnemo Cloud error: ${msg}`);
    }
    return data;
  }

  return {
    /**
     * Store a memory.
     * @param {object} entry
     * @param {string} entry.text - The text content to remember
     * @param {string} [entry.category] - Memory category (fact, preference, decision, entity, other)
     * @param {number} [entry.importance] - Importance score 0.0–1.0 (default: 0.7)
     * @param {string} [entry.scope] - Scope for multi-agent isolation (default: global)
     * @returns {Promise<{id: string}>}
     */
    async store(entry) {
      return request("POST", "/v1/store", entry);
    },

    /**
     * Recall memories by semantic search.
     * @param {string} query - Search query
     * @param {object} [options]
     * @param {number} [options.limit] - Max results (default: 5)
     * @param {string[]} [options.scopeFilter] - Only return memories from these scopes
     * @param {string} [options.category] - Only return memories of this category
     * @returns {Promise<Array<{text: string, score: number, category: string, importance: number, timestamp: number}>>}
     */
    async recall(query, options = {}) {
      const data = await request("POST", "/v1/recall", { query, ...options });
      return data.results;
    },

    /**
     * Delete a memory by ID.
     * @param {string} id - Memory ID
     * @returns {Promise<boolean>}
     */
    async delete(id) {
      const data = await request("DELETE", `/v1/memories/${id}`);
      return !!data.deleted;
    },

    /**
     * Get memory store statistics.
     * @returns {Promise<{totalEntries: number, scopeCounts: object, categoryCounts: object}>}
     */
    async stats() {
      return request("GET", "/v1/stats");
    },
  };
}
