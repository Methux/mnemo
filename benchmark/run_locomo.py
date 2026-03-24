#!/usr/bin/env python3
"""
LOCOMO Benchmark — Universal harness for comparing memory frameworks.

Supports: mnemo-core, mnemo-pro, mem0, baseline (no memory)
Each framework implements store_memories() and recall() via adapters.

Usage:
  python benchmark/run_locomo.py --adapter mnemo-core
  python benchmark/run_locomo.py --adapter mem0
  python benchmark/run_locomo.py --adapter mnemo-pro
  python benchmark/run_locomo.py --adapter baseline

Requirements:
  pip install mem0ai   # for mem0 adapter
  npm install          # for mnemo adapters (uses @mnemoai/server)
"""

import json, time, os, sys, argparse, urllib.request, urllib.error
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

# ============================================================================
# Config
# ============================================================================

DATA_FILE = Path(__file__).parent / "data" / "locomo10.json"
RESULTS_DIR = Path(__file__).parent / "results"
RESULTS_DIR.mkdir(exist_ok=True)

OPENAI_KEY = os.environ.get("OPENAI_API_KEY", "")
VOYAGE_KEY = os.environ.get("VOYAGE_API_KEY", "")
JUDGE_MODEL = os.environ.get("LOCOMO_JUDGE_MODEL", "gpt-4.1")

CATEGORY_NAMES = {1: "Single-hop", 2: "Temporal", 3: "Multi-hop", 4: "Open-ended", 5: "Adversarial"}

# ============================================================================
# LLM helpers
# ============================================================================

_oai_lock = threading.Lock()

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

def judge(question, predicted, gold):
    """Score prediction against gold answer. Returns 0-3."""
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

def answer_with_context(question, context_docs, speaker_a, speaker_b):
    """Generate answer from retrieved context."""
    context = "\n".join(f"- {m}" for m in context_docs)
    if not context.strip():
        return "[NO_CONTEXT]"

    prompt = f"""You have memory snippets from a conversation between {speaker_a} and {speaker_b}:

{context}

Based ONLY on the above, answer concisely (1-2 sentences):
Question: {question}

Instructions:
- Look for indirect evidence.
- Extract specific details like names, dates, locations from the context.
- Combine information from multiple snippets when needed.
- Only say "I don't know" if there is truly NO relevant information.
Answer:"""
    try:
        return openai_chat([{"role": "user", "content": prompt}]).strip()
    except Exception as e:
        return f"[ERROR: {e}]"


# ============================================================================
# Adapter: Baseline (no memory — just answer from question)
# ============================================================================

class BaselineAdapter:
    name = "baseline"

    def store_memories(self, conversation, conv_id):
        pass  # no storage

    def recall(self, query, conv_id, limit=10):
        return []  # no retrieval

    def cleanup(self, conv_id):
        pass


# ============================================================================
# Adapter: Mem0
# ============================================================================

class Mem0Adapter:
    name = "mem0"

    def __init__(self):
        try:
            from mem0 import Memory
            self.m = Memory()
            print("[mem0] Initialized with default config")
        except ImportError:
            print("ERROR: pip install mem0ai")
            sys.exit(1)

    def store_memories(self, conversation, conv_id):
        """Ingest conversation turns into Mem0."""
        sessions = []
        for key in sorted(conversation.keys()):
            if key.startswith("session_") and not key.endswith("_date_time"):
                sessions.append((key, conversation[key]))

        speaker_a = conversation.get("speaker_a", "A")
        speaker_b = conversation.get("speaker_b", "B")

        count = 0
        for sess_key, turns in sessions:
            for turn in turns:
                speaker = speaker_a if turn.get("speaker", "") == "speaker_a" else speaker_b
                text = turn.get("text", "")
                if not text.strip():
                    continue
                try:
                    self.m.add(f"{speaker}: {text}", user_id=conv_id)
                    count += 1
                except Exception as e:
                    print(f"  [mem0] store error: {e}")
        print(f"  [mem0] Stored {count} turns for {conv_id}")

    def recall(self, query, conv_id, limit=10):
        try:
            results = self.m.search(query, user_id=conv_id, limit=limit)
            # Mem0 returns list of dicts with 'memory' key
            if isinstance(results, dict) and "results" in results:
                results = results["results"]
            return [r.get("memory", r.get("text", str(r))) for r in results[:limit]]
        except Exception as e:
            print(f"  [mem0] recall error: {e}")
            return []

    def cleanup(self, conv_id):
        try:
            self.m.delete_all(user_id=conv_id)
        except:
            pass


# ============================================================================
# Adapter: Mnemo (via REST server)
# ============================================================================

class MnemoAdapter:
    name = "mnemo-core"

    def __init__(self, server_url="http://localhost:18100"):
        self.url = server_url
        # Check server is running
        try:
            req = urllib.request.Request(f"{self.url}/health")
            with urllib.request.urlopen(req, timeout=5) as r:
                data = json.load(r)
                print(f"[mnemo] Connected to server: {data}")
        except Exception as e:
            print(f"ERROR: Mnemo server not running at {self.url}")
            print(f"  Start it with: cd mnemo && npx @mnemoai/server")
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

    def store_memories(self, conversation, conv_id):
        """Ingest conversation turns via Mnemo REST API."""
        sessions = []
        for key in sorted(conversation.keys()):
            if key.startswith("session_") and not key.endswith("_date_time"):
                sessions.append((key, conversation[key]))

        speaker_a = conversation.get("speaker_a", "A")
        speaker_b = conversation.get("speaker_b", "B")

        count = 0
        for sess_key, turns in sessions:
            for turn in turns:
                speaker = speaker_a if turn.get("speaker", "") == "speaker_a" else speaker_b
                text = turn.get("text", "")
                if not text.strip():
                    continue
                try:
                    self._post("/store", {
                        "text": f"{speaker}: {text}",
                        "category": "fact",
                        "scope": conv_id,
                    })
                    count += 1
                except Exception as e:
                    print(f"  [mnemo] store error: {e}")
        print(f"  [mnemo] Stored {count} turns for {conv_id}")

    def recall(self, query, conv_id, limit=10):
        try:
            data = self._post("/recall", {
                "query": query,
                "limit": limit,
                "scopeFilter": [conv_id],
            })
            results = data.get("results", [])
            return [r.get("text", str(r)) for r in results[:limit]]
        except Exception as e:
            print(f"  [mnemo] recall error: {e}")
            return []

    def cleanup(self, conv_id):
        pass  # memories persist in DB, cleanup optional


# ============================================================================
# Evaluation loop
# ============================================================================

def evaluate_conversation(adapter, conv, conv_idx):
    """Evaluate all QA pairs for one conversation."""
    conv_id = f"locomo-{conv_idx}-{adapter.name}"
    conversation = conv["conversation"]
    speaker_a = conversation.get("speaker_a", "Speaker A")
    speaker_b = conversation.get("speaker_b", "Speaker B")
    qas = conv.get("qa", [])

    print(f"\n--- Conv {conv_idx}: {speaker_a} & {speaker_b}, {len(qas)} questions ---")

    # Ingest
    t0 = time.time()
    adapter.store_memories(conversation, conv_id)
    ingest_time = time.time() - t0
    print(f"  Ingestion: {ingest_time:.1f}s")

    # Evaluate each QA
    results = []
    for qi, qa in enumerate(qas):
        question = qa["question"]
        gold = qa.get("answer")
        if not gold:
            continue  # skip QA pairs without gold answer
        category = qa.get("category", 0)

        # Retrieve
        docs = adapter.recall(question, conv_id, limit=10)

        # Answer
        predicted = answer_with_context(question, docs, speaker_a, speaker_b)

        # Judge
        score = judge(question, predicted, gold)

        results.append({
            "conv_idx": conv_idx,
            "qi": qi,
            "question": question,
            "gold": gold,
            "predicted": predicted,
            "score": score,
            "category": category,
            "n_retrieved": len(docs),
        })

        status = ["WRONG", "PARTIAL", "CORRECT", "EXACT"][score]
        print(f"  Q{qi}: [{status}] {question[:60]}...")

    return results, ingest_time


def main():
    parser = argparse.ArgumentParser(description="LOCOMO Benchmark — Universal Memory Framework Evaluator")
    parser.add_argument("--adapter", choices=["mnemo-core", "mnemo-pro", "mem0", "baseline"], required=True)
    parser.add_argument("--max-convs", type=int, default=10)
    parser.add_argument("--max-qa", type=int, default=9999)
    parser.add_argument("--server-url", type=str, default="http://localhost:18100")
    parser.add_argument("--workers", type=int, default=1, help="Parallel workers (1=sequential, recommended for fairness)")
    args = parser.parse_args()

    if not OPENAI_KEY:
        print("ERROR: OPENAI_API_KEY is required for the judge model")
        sys.exit(1)

    # Load data
    if not DATA_FILE.exists():
        print(f"ERROR: {DATA_FILE} not found")
        print("Download LOCOMO dataset and place locomo10.json in benchmark/data/")
        sys.exit(1)

    data = json.load(open(DATA_FILE))
    convs = data[:args.max_convs]

    # Create adapter
    if args.adapter == "mem0":
        adapter = Mem0Adapter()
    elif args.adapter in ("mnemo-core", "mnemo-pro"):
        adapter = MnemoAdapter(args.server_url)
        adapter.name = args.adapter
    elif args.adapter == "baseline":
        adapter = BaselineAdapter()

    print(f"\n{'='*60}")
    print(f"LOCOMO Benchmark — {adapter.name}")
    print(f"Judge model: {JUDGE_MODEL}")
    print(f"Conversations: {len(convs)}")
    print(f"{'='*60}")

    # Run evaluation
    all_results = []
    total_ingest_time = 0

    for i, conv in enumerate(convs):
        results, ingest_time = evaluate_conversation(adapter, conv, i)
        all_results.extend(results[:args.max_qa])
        total_ingest_time += ingest_time

    # Calculate accuracy
    if not all_results:
        print("No results!")
        return

    correct = sum(1 for r in all_results if r["score"] >= 2)
    total = len(all_results)
    accuracy = correct / total * 100

    # By category
    by_cat = {}
    for r in all_results:
        cat = r["category"]
        if cat not in by_cat:
            by_cat[cat] = {"correct": 0, "total": 0}
        by_cat[cat]["total"] += 1
        if r["score"] >= 2:
            by_cat[cat]["correct"] += 1

    print(f"\n{'='*60}")
    print(f"RESULTS — {adapter.name}")
    print(f"{'='*60}")
    print(f"Overall accuracy: {accuracy:.1f}% ({correct}/{total})")
    print(f"Total ingestion time: {total_ingest_time:.1f}s")
    print(f"\nBy category:")
    for cat in sorted(by_cat.keys()):
        c = by_cat[cat]
        pct = c["correct"] / c["total"] * 100 if c["total"] > 0 else 0
        name = CATEGORY_NAMES.get(cat, f"Cat-{cat}")
        print(f"  {name}: {pct:.1f}% ({c['correct']}/{c['total']})")

    # Save results
    ts = time.strftime("%Y%m%d_%H%M%S")
    out_file = RESULTS_DIR / f"locomo_{adapter.name}_{ts}.json"
    output = {
        "adapter": adapter.name,
        "judge_model": JUDGE_MODEL,
        "accuracy": accuracy,
        "correct": correct,
        "total": total,
        "ingest_time_seconds": total_ingest_time,
        "by_category": {str(k): v["correct"] / v["total"] * 100 for k, v in by_cat.items() if v["total"] > 0},
        "category_counts": {str(k): v for k, v in by_cat.items()},
        "timestamp": ts,
        "questions": all_results,
    }
    with open(out_file, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    print(f"\nResults saved to: {out_file}")

    # Cleanup
    for i in range(len(convs)):
        adapter.cleanup(f"locomo-{i}-{adapter.name}")


if __name__ == "__main__":
    main()
