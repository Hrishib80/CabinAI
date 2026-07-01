"""
generate_demo_log.py — Synthetic 8-hour driving log with realistic fatigue ramp.

Phase timeline:
  Hours 0-2:   Fully alert   — EAR=0.31±0.02, PERCLOS=2±1%, blink=16±3/min
  Hours 2-4:   Mild fatigue  — EAR declines 0.31→0.24, PERCLOS 2→8%
  Hours 4-4.5: Heavy fatigue — EAR=0.21±0.01, PERCLOS=15-25%, blink=8±2/min
  Hours 4.5-8: Post-alert recovery (mild fatigue sustained)

Sampled at 30s intervals → 960 samples.
Composite mirrors agent1_perception.js:
  earNorm   = clamp(1 - ear / 0.35, 0, 1)
  percNorm  = min(1, perclos / 0.15)
  blinkNorm = 1 if blink<5; 0 if blink>20; else 1 - (blink-5)/15
  composite = 0.4*earNorm + 0.4*percNorm + 0.2*blinkNorm
"""

import json
import math
import os
import random

random.seed(7)

OUTPUT_PATH = os.path.join(
    os.path.dirname(__file__), "..", "phase2", "deliverables", "demo_driving_log.json"
)

DURATION_HOURS = 8
SAMPLE_INTERVAL_S = 30
N_SAMPLES = (DURATION_HOURS * 3600) // SAMPLE_INTERVAL_S   # 960


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def gauss(mu, sigma):
    return mu + sigma * (sum(random.random() for _ in range(12)) - 6.0)


def drowsiness_composite(ear, perclos, blink_freq):
    ear_norm   = clamp(1.0 - ear / 0.35, 0.0, 1.0)
    perc_norm  = min(1.0, perclos / 0.15)
    blink_norm = (
        1.0 if blink_freq < 5
        else (0.0 if blink_freq > 20
              else 1.0 - (blink_freq - 5.0) / 15.0)
    )
    return 0.4 * ear_norm + 0.4 * perc_norm + 0.2 * blink_norm


def phase_params(t_s):
    """Return (ear_mu, ear_sigma, perclos_mu, perclos_sigma, blink_mu, blink_sigma)
    for the given time in seconds."""
    t_h = t_s / 3600.0

    if t_h <= 2.0:
        # Fully alert
        return (0.31, 0.02, 0.02, 0.01, 16.0, 3.0)

    elif t_h <= 4.0:
        # Linear ramp: mild fatigue building
        p = (t_h - 2.0) / 2.0             # 0..1 over hours 2-4
        ear_mu     = 0.31 - 0.07 * p       # 0.31 → 0.24
        perclos_mu = 0.02 + 0.06 * p       # 0.02 → 0.08
        blink_mu   = 16.0 - 5.0 * p        # 16 → 11
        return (ear_mu, 0.015, perclos_mu, 0.015, blink_mu, 2.5)

    elif t_h <= 4.5:
        # Heavy fatigue — EAR=0.19±0.01, PERCLOS=22-32%, blink=6±1.5
        # earNorm~0.46, percNorm~1.0, blinkNorm~0.93 → composite ~0.77-0.88
        return (0.19, 0.01, 0.30, 0.04, 6.5, 1.5)

    else:
        # Post-alert: sustained mild fatigue (slightly better than peak)
        p = min(1.0, (t_h - 4.5) / 3.5)   # gradual mild recovery
        ear_mu     = 0.24 + 0.04 * p        # 0.24 → 0.28
        perclos_mu = 0.08 - 0.04 * p        # 0.08 → 0.04
        blink_mu   = 11.0 + 4.0 * p         # 11 → 15
        return (ear_mu, 0.018, perclos_mu, 0.015, blink_mu, 2.5)


def generate_log():
    samples = []
    for i in range(N_SAMPLES):
        t_s = i * SAMPLE_INTERVAL_S
        ear_mu, ear_s, pc_mu, pc_s, bl_mu, bl_s = phase_params(t_s)
        ear        = round(clamp(gauss(ear_mu, ear_s),  0.10, 0.45), 4)
        perclos    = round(clamp(gauss(pc_mu,  pc_s),   0.00, 0.50), 4)
        blink_freq = round(clamp(gauss(bl_mu,  bl_s),   2.0,  30.0), 1)
        score      = round(drowsiness_composite(ear, perclos, blink_freq), 4)
        samples.append({
            "t_s": t_s,
            "ear": ear,
            "perclos": perclos,
            "blink_freq": blink_freq,
            "drowsiness_composite": score,
        })
    return samples


def main():
    samples = generate_log()
    log = {
        "metadata": {
            "duration_hours": DURATION_HOURS,
            "sample_interval_s": SAMPLE_INTERVAL_S,
            "n_samples": len(samples),
        },
        "samples": samples,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(log, fh, indent=2)

    print(f"demo_driving_log.json written: {len(samples)} samples to {OUTPUT_PATH}")
    # Print first/last 3 + peak sample for verification
    for s in samples[:3]:
        print(f"  t={s['t_s']:5}s  ear={s['ear']:.3f}  perclos={s['perclos']:.3f}"
              f"  blink={s['blink_freq']:.1f}  drowsy={s['drowsiness_composite']:.3f}")
    print("  ...")
    peak = max(samples, key=lambda x: x["drowsiness_composite"])
    print(f"  peak t={peak['t_s']:5}s  drowsy={peak['drowsiness_composite']:.3f}")
    for s in samples[-3:]:
        print(f"  t={s['t_s']:5}s  ear={s['ear']:.3f}  perclos={s['perclos']:.3f}"
              f"  blink={s['blink_freq']:.1f}  drowsy={s['drowsiness_composite']:.3f}")

    # Compute headline numbers for Time Machine
    threshold_with    = 0.65
    threshold_without = 0.80
    t_with = next(
        (s["t_s"] for s in samples if s["drowsiness_composite"] >= threshold_with), None
    )
    t_without = next(
        (s["t_s"] for s in samples if s["drowsiness_composite"] >= threshold_without), None
    )
    print("\n--- Time Machine headline numbers ---")
    if t_with is not None:
        h_w  = t_with // 3600
        m_w  = (t_with % 3600) // 60
        print(f"  alert_with    = {h_w:02d}:{m_w:02d}  ({t_with}s)")
    else:
        print("  alert_with    = never fired")
    if t_without is not None:
        h_wo = t_without // 3600
        m_wo = (t_without % 3600) // 60
        print(f"  alert_without = {h_wo:02d}:{m_wo:02d}  ({t_without}s)")
    else:
        print("  alert_without = never fired")
    if t_with is not None and t_without is not None:
        improvement = (t_without - t_with) // 60
        print(f"  improvement   = {improvement} min")


if __name__ == "__main__":
    main()
