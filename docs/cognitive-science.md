# Cognitive Science Behind Mnemo

## Memory Systems Theory

Mnemo's architecture maps to established cognitive science models:

### Atkinson-Shiffrin Model
- **Sensory memory** → Resonance gate (S1): most inputs filtered out
- **Short-term memory** → Agent context window (limited capacity)
- **Long-term memory** → LanceDB + Graphiti (persistent storage)

### Ebbinghaus Forgetting Curve → Weibull Decay
Standard forgetting: `R = exp(-t/S)` where S = memory strength.

Mnemo extends this with Weibull stretched-exponential decay. Each memory tier uses a different shape parameter (β), optimized through ablation testing:
- β < 1 (Core tier): sub-exponential — slow initial decay, very persistent
- β = 1 (Working tier): standard exponential — classic Ebbinghaus
- β > 1 (Peripheral tier): super-exponential — faster-than-exponential fade

### Spreading Activation → Graphiti Spread Search
Collins & Loftus (1975): activating one concept spreads to related concepts.
Mnemo: Graphiti `/spread` traverses 1-hop neighborhood from matched entities.

### Spaced Repetition → Access Reinforcement
Ebbinghaus (1885): spaced review strengthens memory traces.
Mnemo Cloud: frequently recalled memories are reinforced, extending their effective lifetime.

### Amygdala Emotional Tagging → emotionalSalience
Emotionally charged memories are more durable (McGaugh, 2004).
Mnemo: `emotionalSalience` field modulates decay rate — higher salience memories persist longer.

### Sleep Consolidation → Cron Maintenance
Memory consolidation during sleep (Stickgold, 2005).
Mnemo: overnight cron jobs for deep consolidation, weekly dedup, monthly review.
