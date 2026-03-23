---
layout: home
hero:
  name: Mnemo
  text: AI memory that forgets intelligently
  tagline: The first memory framework built on cognitive science — Weibull decay, triple-path retrieval, multi-backend storage.
  image:
    src: /logo.svg
    alt: Mnemo
  actions:
    - theme: brand
      text: Quick Start
      link: /guide/quickstart
    - theme: alt
      text: API Reference
      link: /api/
    - theme: alt
      text: View on GitHub
      link: https://github.com/Methux/mnemo

features:
  - icon: 🧠
    title: Weibull Decay
    details: Stretched-exponential forgetting modeled on cognitive science. Important memories consolidate, trivial ones fade naturally.
  - icon: 🔍
    title: Triple-Path Retrieval
    details: Vector search + BM25 keyword + Knowledge Graph fused with Reciprocal Rank Fusion. 10-stage pipeline.
  - icon: 🔌
    title: Multi-Backend Storage
    details: LanceDB (default, zero-config), Qdrant, Chroma, PGVector. Switch backends with one config line.
  - icon: 💰
    title: Free & Open Source
    details: MIT licensed. Full retrieval engine with no restrictions. $0 local deployment with Ollama.
  - icon: ⚡
    title: 4 Lines to Start
    details: "npm install @mnemoai/core → createMnemo() → store() → recall(). That's it."
  - icon: 🛡️
    title: Production Ready
    details: 47 tests, CI/CD, TypeScript types with JSDoc, zero security vulnerabilities, 142KB package.
---
