#!/usr/bin/env python3
"""
LongMemEval Benchmark — Tests Mnemo on Zep's preferred benchmark.

Dataset: LongMemEval (500 questions, 5 categories)
  - Information Extraction
  - Multi-Session Reasoning
  - Knowledge Updates
  - Temporal Reasoning
  - Abstention

Usage:
  python benchmark/run_longmemeval.py --adapter mnemo-core
  python benchmark/run_longmemeval.py --adapter mnemo-pro

Requires: longmemeval_s.json in benchmark/data/
"""

import json, time, os, sys, argparse, urllib.request, urllib.error
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

DATA_FILE = Path(__file__).parent / "data" / "longmemeval_s.json"
RESULTS_DIR = Path(__file__).parent / "results"
RESULTS_DIR.mkdir(exist_ok=True)

OPENAI_KEY = os.environ.get("OPENAI_API_KEY", "")
JUDGE_MODEL = os.environ.get("LONGMEMEVAL_JUDGE_MODEL", "gpt-4.1")

CATEGORY_NAMES = {
    "single-session-user": "Single (User)",
    "single-session-assistant": "Single (Assistant)",
    "single-session-preference": "Single (Preference)",
    "multi-session": "Multi-Session",
    "knowledge-update": "Knowledge Update",
    "temporal-reasoning": "Temporal",
    "abstention": "Abstention",
}

# ============================================================================
# LLM helpers
# ============================================================================

def openai_chat(messages, model=None, max_tokens=512):
    model = model or JUDGE_MODEL
    payload = {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": 0}
    for attempt in range(5):
        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            json.dumps(payload).encode(),
            {"Content-Type": "application/json", "Authorization": f"Bearer {OPENAI_KEY}"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 4:
                time.sleep(2 ** attempt * 3 + 2)
                continue
            raise

def judge(question, predicted, gold, question_type):
    """Score prediction. For abstention questions, check if model correctly abstains."""
    if question_type == "abstention":
        # Model should say "I don't know" or equivalent
        abstain_signals = ["don't know", "no information", "not mentioned", "cannot determine",
                          "no record", "not available", "unclear", "no evidence"]
        predicted_lower = predicted.lower()
        for signal in abstain_signals:
            if signal in predicted_lower:
                return 3  # Correctly abstained
        return 0  # Failed to abstain

    prompt = f"""Evaluate this AI answer.

Question: {question}
Gold answer: {gold}
Predicted: {predicted}

Score (respond with ONLY a digit):
3 = Exact / semantically equivalent
2 = Mostly correct
1 = Partially correct
0 = Wrong or "I don't know"

Score:"""
    try:
        s = openai_chat([{"role": "user", "content": prompt}], max_tokens=4)
        return min(max(int(s.strip()[0]), 0), 3)
    except:
        return 0

def answer_with_context(question, context_docs):
    context = "\n".join(f"- {m}" for m in context_docs)
    if not context.strip():
        return "I don't have enough information to answer this question."

    prompt = f"""You have memory snippets from past conversations:

{context}

Based ONLY on the above, answer concisely (1-2 sentences):
Question: {question}

Instructions:
- If the information is not in the snippets, say "I don't have information about that."
- Extract specific details like names, dates, locations from the context.
- Combine information from multiple snippets when needed.
Answer:"""
    try:
        return openai_chat([{"role": "user", "content": prompt}]).strip()
    except Exception as e:
        return f"[ERROR: {e}]"


# ============================================================================
# Mnemo Adapter (via REST server)
# ============================================================================

class MnemoAdapter:
    def __init__(self, name, server_url="http://localhost:18100"):
        self.name = name
        self.url = server_url
        try:
            req = urllib.request.Request(f"{self.url}/health")
            with urllib.request.urlopen(req, timeout=5) as r:
                data = json.load(r)
                print(f"[{name}] Connected to server: {data}")
        except Exception:
            print(f"ERROR: Mnemo server not running at {self.url}")
            print(f"  Start with: MNEMO_PORT=18100 npx @mnemoai/server")
            sys.exit(1)

    def _post(self, path, body):
        req = urllib.request.Request(
            f"{self.url}{path}",
            json.dumps(body).encode(),
            {"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)

    def store(self, text, scope):
        self._post("/store", {"text": text, "category": "fact", "scope": scope})

    def recall(self, query, scope, limit=10):
        try:
            data = self._post("/recall", {"query": query, "limit": limit, "scopeFilter": [scope]})
            return [r.get("text", str(r)) for r in data.get("results", [])[:limit]]
        except:
            return []


# ============================================================================
# Main
# ============================================================================

def main():
    parser = argparse.ArgumentParser(description="LongMemEval Benchmark for Mnemo")
    parser.add_argument("--adapter", choices=["mnemo-core", "mnemo-pro"], required=True)
    parser.add_argument("--max-questions", type=int, default=500)
    parser.add_argument("--server-url", type=str, default="http://localhost:18100")
    parser.add_argument("--max-turns-per-scope", type=int, default=150, help="Max turns to ingest per scope")
    args = parser.parse_args()

    if not OPENAI_KEY:
        print("ERROR: OPENAI_API_KEY required")
        sys.exit(1)

    if not DATA_FILE.exists():
        print(f"ERROR: {DATA_FILE} not found")
        print("Download from: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned")
        sys.exit(1)

    print(f"Loading {DATA_FILE}...")
    data = json.load(open(DATA_FILE))
    questions = data[:args.max_questions]
    print(f"Loaded {len(questions)} questions")

    adapter = MnemoAdapter(args.adapter, args.server_url)

    print(f"\n{'='*60}")
    print(f"LongMemEval Benchmark — {adapter.name}")
    print(f"Judge: {JUDGE_MODEL}, Questions: {len(questions)}")
    print(f"{'='*60}")

    # Phase 1: Ingest all conversation histories (parallel)
    WORKERS = int(os.environ.get("INGEST_WORKERS", "32"))
    print(f"\n--- Phase 1: Ingestion ({WORKERS} workers) ---")
    t0 = time.time()

    # Collect all store tasks (capped per scope)
    max_per_scope = args.max_turns_per_scope
    store_tasks = []  # (text, scope)
    seen_scopes = set()
    for q in questions:
        qid = q["question_id"]
        scope = f"lme-{qid}"
        if scope in seen_scopes:
            continue
        sessions = q.get("haystack_sessions") or []
        if not sessions:
            continue
        scope_turns = []
        for session in sessions:
            turns = session if isinstance(session, list) else session.get("turns", session.get("messages", []))
            for turn in turns:
                if isinstance(turn, dict):
                    role = turn.get("role", "")
                    text = turn.get("content", turn.get("text", ""))
                elif isinstance(turn, str):
                    text = turn
                    role = ""
                else:
                    continue
                if not text or len(text.strip()) < 10:
                    continue
                prefix = f"{role}: " if role else ""
                scope_turns.append((f"{prefix}{text}", scope))
        # Evenly sample if over limit
        if len(scope_turns) > max_per_scope:
            step = len(scope_turns) / max_per_scope
            scope_turns = [scope_turns[int(i * step)] for i in range(max_per_scope)]
        store_tasks.extend(scope_turns)
        seen_scopes.add(scope)

    print(f"  {len(store_tasks)} turns across {len(seen_scopes)} scopes")

    stored = [0]
    failed = [0]
    def do_store(item):
        text, scope = item
        try:
            adapter.store(text, scope)
            stored[0] += 1
            if stored[0] % 200 == 0:
                print(f"  Stored {stored[0]}/{len(store_tasks)} ({stored[0]*100//len(store_tasks)}%)")
        except:
            failed[0] += 1

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        list(pool.map(do_store, store_tasks))

    ingest_time = time.time() - t0
    print(f"  Ingestion complete: {stored[0]} stored, {failed[0]} failed, {ingest_time:.1f}s")

    # Phase 2: Evaluate
    print(f"\n--- Phase 2: Evaluation ---")
    results = []

    for qi, q in enumerate(questions):
        qid = q["question_id"]
        scope = f"lme-{qid}"
        question = q["question"]
        gold = q.get("answer", "")
        qtype = q.get("question_type", "unknown")

        if not gold and qtype != "abstention":
            continue

        # Retrieve
        docs = adapter.recall(question, scope, limit=10)

        # Answer
        predicted = answer_with_context(question, docs)

        # Judge
        score = judge(question, predicted, gold, qtype)

        results.append({
            "question_id": qid,
            "question_type": qtype,
            "question": question,
            "gold": gold,
            "predicted": predicted,
            "score": score,
            "n_retrieved": len(docs),
        })

        status = ["WRONG", "PARTIAL", "CORRECT", "EXACT"][score]
        if (qi + 1) % 25 == 0 or qi < 5:
            print(f"  Q{qi}: [{status}] ({qtype}) {question[:60]}...")

    # Results
    if not results:
        print("No results!")
        return

    correct = sum(1 for r in results if r["score"] >= 2)
    total = len(results)
    accuracy = correct / total * 100

    by_type = {}
    for r in results:
        t = r["question_type"]
        if t not in by_type:
            by_type[t] = {"correct": 0, "total": 0}
        by_type[t]["total"] += 1
        if r["score"] >= 2:
            by_type[t]["correct"] += 1

    print(f"\n{'='*60}")
    print(f"RESULTS — {adapter.name} on LongMemEval")
    print(f"{'='*60}")
    print(f"Overall accuracy: {accuracy:.1f}% ({correct}/{total})")
    print(f"Ingestion time: {ingest_time:.1f}s")
    print(f"\nBy category:")
    for t in sorted(by_type.keys()):
        c = by_type[t]
        pct = c["correct"] / c["total"] * 100 if c["total"] > 0 else 0
        name = CATEGORY_NAMES.get(t, t)
        print(f"  {name}: {pct:.1f}% ({c['correct']}/{c['total']})")

    # Save
    ts = time.strftime("%Y%m%d_%H%M%S")
    out_file = RESULTS_DIR / f"longmemeval_{adapter.name}_{ts}.json"
    output = {
        "adapter": adapter.name,
        "benchmark": "LongMemEval",
        "judge_model": JUDGE_MODEL,
        "accuracy": accuracy,
        "correct": correct,
        "total": total,
        "ingest_time_seconds": ingest_time,
        "by_type": {k: v["correct"] / v["total"] * 100 for k, v in by_type.items() if v["total"] > 0},
        "type_counts": {k: v for k, v in by_type.items()},
        "timestamp": ts,
        "questions": results,
    }
    with open(out_file, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    print(f"\nResults saved to: {out_file}")


if __name__ == "__main__":
    main()
