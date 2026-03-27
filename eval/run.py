"""
AssistantX Guard Evaluation Runner.

Runs the adversarial evaluation dataset against the live guard pipeline
and produces accuracy, precision, recall, F1, and latency metrics.

Usage:
    cd /root/assistantx && python -m eval.run

Output:
    eval/results.json  - per-case results with timing
    eval/report.md     - human-readable summary with metrics
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path
from collections import defaultdict

# Ensure project root is on path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api.services.guard import guard_inbound, guard_outbound


async def run_evaluation():
    dataset_path = Path(__file__).parent / "dataset.json"
    with open(dataset_path) as f:
        dataset = json.load(f)

    results = []
    total = len(dataset)
    correct = 0
    errors = 0

    # Per-class tracking for precision/recall
    # For attacks: expected != "pass" means it's a threat
    # "pass" means benign
    tp = 0  # true positive: expected=threat, predicted=threat
    fp = 0  # false positive: expected=pass, predicted=threat
    tn = 0  # true negative: expected=pass, predicted=pass
    fn = 0  # false negative: expected=threat, predicted=pass

    latencies = []
    category_results = defaultdict(lambda: {"correct": 0, "total": 0, "cases": []})

    print(f"\nRunning {total} evaluation cases...\n")
    print(f"{'ID':<16} {'Expected':<8} {'Got':<8} {'Match':<6} {'Latency':<10} Category")
    print("-" * 80)

    for case in dataset:
        case_id = case["id"]
        content = case["content"]
        expected = case["expected"]
        direction = case["direction"]
        category = case["category"]

        start = time.monotonic()
        try:
            if direction == "inbound":
                result = await guard_inbound(content)
            else:
                result = await guard_outbound(content)

            elapsed_ms = (time.monotonic() - start) * 1000
            predicted = result.verdict.value  # "pass", "block", "redact"
        except Exception as exc:
            elapsed_ms = (time.monotonic() - start) * 1000
            predicted = "error"
            errors += 1
            print(f"  ERROR on {case_id}: {exc}")

        latencies.append(elapsed_ms)

        # For metrics: "block" and "redact" are both "threat detected"
        expected_is_threat = expected != "pass"
        predicted_is_threat = predicted != "pass"

        # Exact match (pass/block/redact)
        exact_match = predicted == expected

        # Threat detection match (did we catch it / not false positive)
        threat_match = expected_is_threat == predicted_is_threat

        if threat_match:
            correct += 1
            if expected_is_threat:
                tp += 1
            else:
                tn += 1
        else:
            if predicted_is_threat:
                fp += 1
            else:
                fn += 1

        match_str = "OK" if threat_match else "FAIL"
        print(f"  {case_id:<14} {expected:<8} {predicted:<8} {match_str:<6} {elapsed_ms:>7.0f}ms  {category}")

        case_result = {
            "id": case_id,
            "content": content[:80] + "..." if len(content) > 80 else content,
            "direction": direction,
            "category": category,
            "expected": expected,
            "predicted": predicted,
            "exact_match": exact_match,
            "threat_match": threat_match,
            "latency_ms": round(elapsed_ms, 1),
            "reasoning": getattr(result, "reasoning", None) if predicted != "error" else None,
            "model_used": getattr(result, "model_used", None) if predicted != "error" else None,
        }
        results.append(case_result)

        cat = category_results[category]
        cat["total"] += 1
        if threat_match:
            cat["correct"] += 1

    # Compute metrics
    accuracy = correct / total if total else 0
    precision = tp / (tp + fp) if (tp + fp) else 0
    recall = tp / (tp + fn) if (tp + fn) else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0
    fpr = fp / (fp + tn) if (fp + tn) else 0

    latencies_sorted = sorted(latencies)
    p50 = latencies_sorted[len(latencies_sorted) // 2] if latencies_sorted else 0
    p95 = latencies_sorted[int(len(latencies_sorted) * 0.95)] if latencies_sorted else 0
    p99 = latencies_sorted[int(len(latencies_sorted) * 0.99)] if latencies_sorted else 0
    avg_latency = sum(latencies) / len(latencies) if latencies else 0

    # Print summary
    print("\n" + "=" * 80)
    print("EVALUATION RESULTS")
    print("=" * 80)
    print(f"\nDataset: {total} cases ({tp + fn} threats, {tn + fp} benign)")
    print(f"Errors: {errors}")
    print(f"\n  Accuracy:          {accuracy:.1%}  ({correct}/{total})")
    print(f"  Precision:         {precision:.1%}  (of predicted threats, how many were real)")
    print(f"  Recall:            {recall:.1%}  (of real threats, how many were caught)")
    print(f"  F1 Score:          {f1:.3f}")
    print(f"  False Positive Rate: {fpr:.1%}  ({fp} benign messages incorrectly blocked)")
    print(f"\n  Confusion Matrix:")
    print(f"    TP={tp}  FP={fp}")
    print(f"    FN={fn}  TN={tn}")
    print(f"\n  Latency (ms):")
    print(f"    avg={avg_latency:.0f}  p50={p50:.0f}  p95={p95:.0f}  p99={p99:.0f}")

    print(f"\n  Per-Category Accuracy:")
    for cat_name, cat_data in sorted(category_results.items()):
        cat_acc = cat_data["correct"] / cat_data["total"] if cat_data["total"] else 0
        print(f"    {cat_name:<24} {cat_acc:.0%}  ({cat_data['correct']}/{cat_data['total']})")

    # Save results
    output = {
        "summary": {
            "total": total,
            "correct": correct,
            "errors": errors,
            "accuracy": round(accuracy, 4),
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1_score": round(f1, 4),
            "false_positive_rate": round(fpr, 4),
            "confusion_matrix": {"tp": tp, "fp": fp, "fn": fn, "tn": tn},
            "latency_ms": {
                "avg": round(avg_latency, 1),
                "p50": round(p50, 1),
                "p95": round(p95, 1),
                "p99": round(p99, 1),
            },
            "per_category": {
                name: {"accuracy": round(d["correct"] / d["total"], 4) if d["total"] else 0, "correct": d["correct"], "total": d["total"]}
                for name, d in sorted(category_results.items())
            },
        },
        "cases": results,
    }

    results_path = Path(__file__).parent / "results.json"
    with open(results_path, "w") as f:
        json.dump(output, f, indent=2)
    print(f"\nResults saved to {results_path}")

    # Generate markdown report
    report_lines = [
        "# AssistantX Guard Evaluation Report",
        "",
        f"**Dataset:** {total} adversarial and benign test cases",
        f"**Model:** DO Gradient `llama3.3-70b-instruct` via official SDK",
        "",
        "## Metrics",
        "",
        "| Metric | Value |",
        "|--------|-------|",
        f"| **Accuracy** | {accuracy:.1%} ({correct}/{total}) |",
        f"| **Precision** | {precision:.1%} |",
        f"| **Recall** | {recall:.1%} |",
        f"| **F1 Score** | {f1:.3f} |",
        f"| **False Positive Rate** | {fpr:.1%} ({fp} benign blocked) |",
        "",
        "## Confusion Matrix",
        "",
        "| | Predicted Threat | Predicted Benign |",
        "|---|---|---|",
        f"| **Actual Threat** | {tp} (TP) | {fn} (FN) |",
        f"| **Actual Benign** | {fp} (FP) | {tn} (TN) |",
        "",
        "## Latency",
        "",
        "| Percentile | Latency |",
        "|------------|---------|",
        f"| avg | {avg_latency:.0f}ms |",
        f"| p50 | {p50:.0f}ms |",
        f"| p95 | {p95:.0f}ms |",
        f"| p99 | {p99:.0f}ms |",
        "",
        "## Per-Category Accuracy",
        "",
        "| Category | Accuracy | Correct / Total |",
        "|----------|----------|-----------------|",
    ]
    for cat_name, cat_data in sorted(category_results.items()):
        cat_acc = cat_data["correct"] / cat_data["total"] if cat_data["total"] else 0
        report_lines.append(f"| {cat_name} | {cat_acc:.0%} | {cat_data['correct']}/{cat_data['total']} |")

    report_lines.extend([
        "",
        "## Test Cases",
        "",
        "| ID | Expected | Predicted | Match | Latency | Category |",
        "|---|---|---|---|---|---|",
    ])
    for r in results:
        match = "pass" if r["threat_match"] else "**FAIL**"
        report_lines.append(f"| {r['id']} | {r['expected']} | {r['predicted']} | {match} | {r['latency_ms']:.0f}ms | {r['category']} |")

    report_path = Path(__file__).parent / "report.md"
    with open(report_path, "w") as f:
        f.write("\n".join(report_lines) + "\n")
    print(f"Report saved to {report_path}")

    return output


if __name__ == "__main__":
    asyncio.run(run_evaluation())
