# Retrieval Pipeline

Mnemo uses a 10-stage retrieval pipeline that progressively refines results.

## Stages

### S0: Preprocessing
Cleans metadata pollution from queries (JSON blocks, sender info, timestamps).

### S1: Resonance Gate (auto-recall only)
Fast vector probe (top 3) to determine if full retrieval is worthwhile.
- Pass: similarity ≥ 0.55, or (similarity ≥ adaptive threshold AND importance ≥ 0.7)
- Fail: return empty (saves compute)

### S2: Multi-hop Detection
Detects queries involving multiple entities. Multi-hop queries use Graphiti /search instead of /spread.

### S3: Triple-path Parallel Retrieval
`Promise.all([Vector, BM25, Graphiti])`

### S4: RRF Fusion
Weighted fusion: Vector × 0.7 + BM25 × 0.3. Graphiti enters at 0.85× discount.

### S5: Min-score Filter
Score < 0.3 → discard.

### S6: Cross-encoder Rerank
Voyage rerank-2. Blend: rerank × 0.6 + original × 0.4. BM25 ≥ 0.75 gets preservation floor.

### S7: Weibull Decay + Lifecycle
Tier-specific decay: Core (β=0.8, floor 0.9), Working (β=1.0, floor 0.7), Peripheral (β=1.3, floor 0.5).

### S8: Length Normalization + Hard Cutoff
Anchor 500 chars. hardMinScore = 0.35.

### S9: Noise Filter + MMR
Remove agent denials, meta-questions, boilerplate. MMR deduplication.

### S10: Session Dedup + Injection
Same memory not repeated within 3 turns. Top-K injected into agent context.
