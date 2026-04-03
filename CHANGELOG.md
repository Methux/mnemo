# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-03-23

### Added

- **Multi-backend storage** — Pluggable backends: LanceDB (default), Qdrant, Chroma, PGVector
- **Weibull decay engine** — Stretched-exponential forgetting with tier-based lifecycle and optimized parameters
- **Triple-path retrieval** — Vector + BM25 + Knowledge Graph fused with Reciprocal Rank Fusion
- **Cross-encoder reranking** — Support for Voyage rerank-2, Jina reranker, and Ollama bge-reranker-v2-m3
- **Three-layer contradiction detection** — Regex signal, LLM 5-class classification, dedup pipeline
- **GDPR audit log** — Structured audit logging for data compliance
- **Async SmartExtractor** — Extraction latency reduced from 800ms to 45ms via async pipeline
- **Mnemo Cloud** — Hosted API with adaptive retrieval and intelligent extraction
- **Docker one-click deployment** — `docker compose up -d` starts Neo4j, Graphiti, and Dashboard
- **Web Dashboard** — Browser-based UI for browsing, debugging, and monitoring memories
- **29 automated tests + CI** — Full test suite with GitHub Actions CI pipeline

[1.1.0]: https://github.com/Methux/mnemo/releases/tag/v1.1.0
