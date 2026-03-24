# LOCOMO Benchmark

Mnemo is evaluated on [LOCOMO](https://github.com/snap-research/locomo), a benchmark designed to measure long-term conversational memory quality across 5 categories.

## Results

**Best configuration: Voyage voyage-3-large + candidatePoolSize=40**

| Category | Accuracy | Description |
|----------|----------|-------------|
| Single-hop | 78.7% | Direct fact retrieval from a single conversation turn |
| Multi-hop | 78.8% | Facts requiring synthesis across multiple turns |
| Open-ended | 84.4% | Questions with subjective or multi-faceted answers |
| Temporal | 89.9% | Time-sensitive questions ("when did X happen?") |
| Adversarial | 100.0% | Questions designed to trick the system |
| **Overall** | **85.2%** | Weighted average across all categories |

## Progression

Mnemo's accuracy improved significantly through systematic architecture iteration:

| Configuration | Accuracy | What changed |
|--------------|----------|--------------|
| LanceDB vector only | 66.7% | Baseline — vector search alone |
| + Graphiti knowledge graph | 70.0% | Added graph traversal path |
| + All-facts extraction | 76.1% | Better memory extraction from conversations |
| + Improved extraction | 80.3% | Refined LLM extraction prompts |
| + BM25 fusion | 82.4% | Added keyword search path |
| + Voyage voyage-3-large | 84.4% | Upgraded embedding model |
| + Pool size 40 + tuning | **85.2%** | Increased candidate pool, optimized RRF |

## How We Test

1. **Dataset**: LOCOMO provides multi-session conversations between two people, with ground-truth QA pairs
2. **Memory ingestion**: Conversations are stored through Mnemo's standard pipeline (extraction → embedding → storage)
3. **Retrieval**: For each question, Mnemo's full 10-stage pipeline retrieves relevant memories
4. **Evaluation**: An LLM judge scores the retrieval-augmented answer against gold labels (0=wrong, 1=partial, 2=correct, 3=complete)
5. **Scoring**: Accuracy = percentage of questions scored ≥2 (correct or complete)

## Architecture That Drives Results

The 85.2% score comes from the full pipeline working together:

- **Triple-path retrieval** (Vector + BM25 + Graphiti) catches different types of information
- **Voyage rerank-2** re-scores candidates for precision
- **Weibull decay** prevents stale memories from competing with relevant ones
- **candidatePoolSize=40** ensures enough candidates reach the reranking stage

Each component's contribution was validated through [ablation testing](/guide/ablation).

## Reproducing

```bash
# Clone and set up
git clone https://github.com/Methux/mnemo
cd mnemo

# The benchmark suite is in the workspace (not published to npm)
# Contact us for access to the evaluation harness
```

## Comparison Notes

- Mem0 reports ~54% on LOCOMO in their published benchmarks
- Mnemo achieves 85.2% — a **31 percentage point improvement**
- Direct comparison is approximate since evaluation methodology may differ
- We encourage independent benchmarking and welcome reproducibility efforts
