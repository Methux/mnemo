# Mnemo LOCOMO Benchmark

Reproducible benchmark comparing AI memory frameworks on [LOCOMO](https://snap-research.github.io/locomo/) — a long-term conversational memory evaluation dataset.

## What We Measure

- **Retrieval accuracy**: Can the framework retrieve the right memories to answer questions?
- **Category breakdown**: Single-hop, Multi-hop, Open-ended, Temporal, Adversarial
- **Ingestion time**: How fast can the framework store conversations?
- **Fair comparison**: Same dataset, same judge model, same scoring rubric

## Supported Frameworks

| Adapter | Framework | Setup |
|---------|-----------|-------|
| `mnemo-core` | Mnemo Core (MIT) | `npx @mnemoai/server` |
| `mnemo-pro` | Mnemo Pro | `npx @mnemoai/server` (with Pro license) |
| `mem0` | Mem0 | `pip install mem0ai` |
| `baseline` | No memory (control) | None |

## Quick Start

```bash
# 1. Set API keys
export OPENAI_API_KEY=sk-...       # Required (judge model)
export VOYAGE_API_KEY=pa-...       # Optional (for Mnemo with Voyage)

# 2. Run Mnemo benchmark
npx @mnemoai/server &              # Start server in background
python benchmark/run_locomo.py --adapter mnemo-core

# 3. Run Mem0 benchmark
pip install mem0ai
python benchmark/run_locomo.py --adapter mem0

# 4. Run baseline (no memory)
python benchmark/run_locomo.py --adapter baseline
```

## Evaluation Method

1. **Ingest**: Each conversation's turns are stored through the framework's standard API
2. **Query**: For each LOCOMO question, the framework retrieves relevant memories
3. **Answer**: GPT-4.1 generates an answer using ONLY the retrieved context
4. **Judge**: GPT-4.1 scores the answer against the gold label (0=wrong, 1=partial, 2=correct, 3=exact)
5. **Accuracy**: Percentage of questions scored ≥ 2

All frameworks use the same judge model and scoring rubric. The only variable is the memory framework's ability to store and retrieve relevant information.

## Results

Results are saved to `benchmark/results/` as JSON files with full question-level detail.

## Adding a New Framework

Create an adapter class with two methods:

```python
class MyAdapter:
    name = "my-framework"

    def store_memories(self, conversation, conv_id):
        """Ingest LOCOMO conversation turns."""
        ...

    def recall(self, query, conv_id, limit=10):
        """Retrieve relevant memories. Returns list of strings."""
        ...

    def cleanup(self, conv_id):
        """Optional cleanup after evaluation."""
        ...
```

## Fairness Guarantees

- Same LOCOMO dataset (10 conversations, ~2000 QA pairs)
- Same judge model (GPT-4.1)
- Same scoring rubric (0-3 scale, ≥2 = correct)
- Same answer generation prompt
- Each framework uses its default/recommended configuration
- Sequential execution (no parallel advantage)
- Full results published with question-level detail
