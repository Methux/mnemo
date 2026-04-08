export interface CloudConfig {
  /** Mnemo Cloud API key (starts with mn_) */
  apiKey: string;
  /** API endpoint. Default: https://api.m-nemo.ai */
  endpoint?: string;
}

export interface CloudMnemoInstance {
  /** Store a memory. Returns the generated memory ID. */
  store(entry: {
    /** The text content to remember. */
    text: string;
    /** Memory category. Default: "fact". */
    category?: "preference" | "fact" | "decision" | "entity" | "other";
    /** Importance score from 0.0 to 1.0. Default: 0.7. */
    importance?: number;
    /** Scope for multi-agent isolation. Default: "global". */
    scope?: string;
  }): Promise<{ id: string }>;

  /** Recall memories by semantic search. Returns ranked results with scores. */
  recall(query: string, options?: {
    /** Maximum number of results. Default: 5. */
    limit?: number;
    /** Only return memories from these scopes. */
    scopeFilter?: string[];
    /** Only return memories of this category. */
    category?: string;
  }): Promise<Array<{
    text: string;
    score: number;
    category: string;
    importance: number;
    timestamp: number;
  }>>;

  /** Delete a memory by ID. Returns true if deleted. */
  delete(id: string): Promise<boolean>;

  /** Get memory store statistics. */
  stats(): Promise<{
    totalEntries: number;
    scopeCounts: Record<string, number>;
    categoryCounts: Record<string, number>;
  }>;
}

/** Create a Mnemo Cloud client instance. */
export function createCloudMnemo(config: CloudConfig): CloudMnemoInstance;
