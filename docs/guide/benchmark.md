# LOCOMO Benchmark

Mnemo is evaluated on [LOCOMO](https://github.com/snap-research/locomo), a benchmark designed to measure long-term conversational memory quality across 5 categories.

## Results

**Best configuration: Voyage voyage-4 embedding with optimized retrieval parameters**

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
| + Voyage voyage-4 | 84.4% | Upgraded embedding model |
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
- **Optimized candidate pool** ensures enough candidates reach the reranking stage

Each component's contribution was validated through [ablation testing](/guide/ablation).

## Reproducing

```bash
# Clone and set up
git clone https://github.com/Methux/mnemo
cd mnemo

# The benchmark suite is in the benchmark/ directory
# See benchmark/README.md for setup instructions
```

## Cross-Framework Comparison

### Default config (same conditions)

All frameworks tested under identical conditions using our [open-source benchmark harness](https://github.com/Methux/mnemo/tree/main/benchmark). Each framework uses its out-of-the-box configuration — no custom tuning.

Full 1986-question re-run in progress. Results will be published with complete result files.

**Previous partial results** (235 questions, 1 conversation):

| Framework | Accuracy | Sample | Config |
|-----------|----------|--------|--------|
| **Mnemo Core** | **46.4%** | 235 QA | `createMnemo()` default — OpenAI text-embedding-3-small, vector only |

Full cross-framework comparison (Mnemo Core vs Mem0 vs Baseline) on all 1986 questions is being re-run for accuracy.

### Self-reported optimized scores (not independently verified)

| Framework | Accuracy | Source |
|-----------|----------|--------|
| **Mem0** | **66.9%** | Mem0 published research (optimized config) |
| **Zep** | **75.14%** | Zep blog (corrected benchmark) |

**Methodology**: Same LOCOMO dataset, same GPT-4.1 judge, same scoring rubric (0-3, ≥2 = correct), same answer generation prompt. Only the memory framework's store/recall differs. Full evaluation code is open source.

## MQoT (Mnemo Quality-of-Thought)

MQoT is Mnemo's internal benchmark designed to test memory quality in realistic agent workflows. Unlike LOCOMO (which tests conversational recall), MQoT focuses on whether the right memories surface at the right time during multi-turn agent tasks.

### MQoT-500

500 evaluation queries against a moderate-size memory store:

| Configuration | Accuracy |
|:---|:---:|
| **Mnemo Cloud** | **91.5%** |
| **Mnemo Core** | **85.5%** |

The 6pp gap demonstrates the value of Cloud's adaptive retrieval strategies (candidate pool sizing, soft frequency cap, extraction-time context injection) even at moderate scale.

### MQoT-3K

A stress test with 509 stored memories and 3,000 evaluation queries, designed to test retrieval quality at scale:

| Configuration | Accuracy |
|:---|:---:|
| **Mnemo Cloud** | **80.5%** |

The 11pp drop from MQoT-500 reflects the harder retrieval challenge of a larger, noisier memory store. Cloud's adaptive retrieval parameters that scale with store size are specifically designed for this regime.

## LongMemEval

We also tested on [LongMemEval](https://github.com/xiaowu0162/LongMemEval), a 500-question benchmark across 6 categories.

**Preliminary results** (20 questions, single-session-user category):

| Framework | Accuracy | Sample |
|-----------|----------|--------|
| **Mnemo Core** | **90.0%** | 20 QA (single-session-user) |

Full 500-question evaluation across all 6 categories is in progress.

## Notes

- **Mem0 default vs optimized**: We tested Mem0 using its default `Memory()` initialization. Mem0's own published research reports 66.9% on LOCOMO with their optimized setup. The difference (31.7% vs 66.9%) likely reflects configuration choices — our harness tests each framework's out-of-the-box experience.
- **Self-reported scores**: Mem0 (66.9%) and Zep (75.14%) optimized scores are from their own publications. We have not independently verified them.
- Results may vary depending on embedding model, LLM judge, hardware, and framework configuration
- We encourage independent benchmarking and welcome reproducibility efforts
- Benchmark harness and data are open source: `benchmark/run_locomo.py`
