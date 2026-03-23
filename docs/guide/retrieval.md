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
Each result's score is adjusted by the Weibull decay function based on memory age and tier:

```
score × exp(-(t/λ)^β)
```

| Tier | β | Behavior |
|------|---|----------|
| Core | 0.8 | Slow initial decay, then rapid |
| Working | 1.0 | Exponential (standard) |
| Peripheral | 1.3 | Fast initial decay |

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

## Configuration

```typescript
const mnemo = await createMnemo({
  embedding: { /* ... */ },
  dbPath: './db',
  retrieval: {
    candidatePoolSize: 20,        // candidates before reranking
    rerank: 'cross-encoder',      // enable reranking
    rerankProvider: 'jina',
    rerankApiKey: process.env.JINA_API_KEY,
    rerankModel: 'jina-reranker-v2-base-multilingual',
  },
});
```
