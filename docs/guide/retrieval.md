# Retrieval Pipeline

Mnemo uses a 10-stage retrieval pipeline that combines multiple search strategies.

## Architecture

```
Query → Preprocessing → Embedding → Triple-Path Search → Fusion → Decay → Rerank → MMR → Filter → Results
```

### Stage 1: Preprocessing
Query expansion, date format normalization (supports Chinese and English date formats).

### Stage 2: Embedding
Query text → vector using the configured embedding model.

### Stage 3: Triple-Path Search
Three independent search paths run in parallel:

| Path | Method | Strength |
|------|--------|----------|
| **Vector** | Cosine similarity search | Semantic understanding |
| **BM25** | Full-text keyword search | Exact term matching |
| **Graph** | Graphiti knowledge graph | Entity relationships |

### Stage 4: Reciprocal Rank Fusion (RRF)
Results from all three paths are fused using RRF, which combines rankings without requiring score normalization.

### Stage 5: Weibull Decay
Each result's score is adjusted by the Weibull decay function based on memory age and tier. Tier-specific parameters ensure core memories persist longer while peripheral memories fade faster. See [Weibull Decay](/guide/decay) for details.

### Stage 6: Cross-Encoder Rerank
Optional high-precision reranking using a cross-encoder model. Supports Jina, Voyage, SiliconFlow, Pinecone, or local Ollama.

### Stage 7: MMR (Maximal Marginal Relevance)
Reduces redundancy by penalizing results that are too similar to already-selected results.

### Stage 8: Scope Filtering
Filters results to only include memories from the requested scopes.

### Stage 9: Noise Filtering
Removes low-quality fragments using an embedding-based noise bank.

### Stage 10: Context Assembly
Final results are assembled with metadata for injection into the LLM context.

## Adaptive Retrieval (Cloud)

Mnemo Cloud dynamically adjusts retrieval parameters based on store size. All parameters are tuned through benchmark optimization — no manual configuration needed.

### Adaptive Candidate Pool

The number of candidates retrieved before reranking scales with store size. Small stores use a conservative pool; large stores widen the pool to avoid missing relevant long-tail memories. The scaling function is derived from empirical testing across store sizes from 100 to 10,000+ memories.

In Core (self-hosted), the pool is a fixed `candidatePoolSize` (default: 30) as set in config.

### Adaptive Minimum Score

Larger stores contain more diverse memories. Cloud automatically lowers the score threshold at scale to prevent relevant memories from being discarded by an overly aggressive filter.

In Core, the threshold is a fixed `minScore` value.

### Soft Frequency Cap

Cloud applies a logarithmic transform to access frequency, preventing frequently recalled memories from dominating retrieval results. The first few accesses count at full value; beyond that, each doubling of accesses adds diminishing returns.

In Core, raw frequency count is used directly.

### Session Deduplication

Cloud tracks which memory IDs have been returned during a retrieval session. On subsequent `recall` calls within the same session, previously surfaced memories are filtered out. This prevents the same high-scoring memory from appearing in every response.

In Core, each `recall` call is independent — no cross-call deduplication.

## Configuration

```typescript
const mnemo = await createMnemo({
  embedding: { /* ... */ },
  dbPath: './db',
  retrieval: {
    candidatePoolSize: 30,        // candidates before reranking
    rerank: 'cross-encoder',      // enable reranking
    rerankProvider: 'jina',
    rerankApiKey: process.env.JINA_API_KEY,
    rerankModel: 'jina-reranker-v2-base-multilingual',
  },
});
```
