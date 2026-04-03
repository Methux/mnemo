# Contributing to Mnemo

Thank you for your interest in contributing to Mnemo!

## What's Open Source

**Mnemo Core** (MIT License) is fully open source:
- Storage engine (LanceDB hybrid)
- Retrieval pipeline (Vector + BM25 fusion)
- Weibull decay engine
- Tier-based lifecycle
- Smart extraction (single channel)
- Noise filtering
- Date expansion

## Development Setup

```bash
git clone https://github.com/Methux/mnemo.git
cd mnemo
npm install
docker-compose up -d   # Neo4j (optional, for Knowledge Graph features)
cp config/mnemo.example.json config/mnemo.json
# Edit config/mnemo.json with your API keys
```

## Areas We Need Help

- **Benchmarks**: LOCOMO, MemBench evaluation
- **Embedding adapters**: Gemini, Cohere, local models
- **Language SDKs**: Python, Go, Rust wrappers
- **Documentation**: Tutorials, examples, translations
- **Retrieval research**: New fusion strategies, reranking approaches

## Pull Request Guidelines

1. Fork the repo and create a feature branch
2. Write tests for new functionality
3. Keep PRs focused — one feature per PR
4. Update docs if you change behavior

## Code of Conduct

Be respectful. Be constructive. We're building something cool together.
