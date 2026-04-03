# Retrieval Pipeline

Mnemo uses a 10-stage retrieval pipeline that progressively refines results.

## Stages

### S0: Preprocessing
Cleans metadata pollution from queries (JSON blocks, sender info, timestamps).

### S1: Resonance Gate (auto-recall only)
Fast vector probe (top 3) to determine if full retrieval is worthwhile.
- Pass: meets configurable similarity threshold, or (meets adaptive threshold AND meets configurable importance threshold)
- Fail: return empty (saves compute)

### S2: Multi-hop Detection
Detects queries involving multiple entities. Multi-hop queries use Graphiti /search instead of /spread.

### S3: Triple-path Parallel Retrieval
`Promise.all([Vector, BM25, Graphiti])`

### S4: RRF Fusion
Weighted fusion of vector and keyword scores. Knowledge graph results blended with configurable weight.

### S5: Min-score Filter
Results below minimum score threshold are discarded.

### S6: Cross-encoder Rerank
Cross-encoder reranking with blended rerank and original scores. High-confidence keyword matches are preserved.

### S7: Weibull Decay + Lifecycle
Tier-specific decay with optimized β parameters and decay floors. Core memories persist longest, peripheral memories fade fastest.

### S8: Length Normalization + Hard Cutoff
Length normalization with configurable anchor. Hard minimum score cutoff.

### S9: Noise Filter + MMR
Remove agent denials, meta-questions, boilerplate. MMR deduplication.

### S10: Session Dedup + Injection
Same memory not repeated within 3 turns. Top-K injected into agent context.
