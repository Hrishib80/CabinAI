#!/usr/bin/env python3
"""
scripts/simulate_ota.py — Track 16: Simulate federated learning OTA update.

1. Seeds 5 vehicles with telemetry via scripts/simulate_fleet.py logic
2. Reads vehicle state from GET /api/fleet/state
3. Calls FLAggregator.collect_uncertainty() for each vehicle
4. Calls aggregate() and if update -> apply_update()
5. Prints a table showing before/after
"""
import sys, os, json, time, math, random
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import argparse

VEHICLES = [
    {"id": "CAB-001", "driver": "Alice",  "base_ear": 0.32, "base_drowsy": 0.38, "base_blink": 14.0},
    {"id": "CAB-002", "driver": "Bob",    "base_ear": 0.22, "base_drowsy": 0.52, "base_blink": 8.5},
    {"id": "CAB-003", "driver": "Carol",  "base_ear": 0.35, "base_drowsy": 0.41, "base_blink": 7.2},
    {"id": "CAB-004", "driver": "Dave",   "base_ear": 0.18, "base_drowsy": 0.61, "base_blink": 6.8},
    {"id": "CAB-005", "driver": "Eve",    "base_ear": 0.30, "base_drowsy": 0.48, "base_blink": 9.1},
]


def _gen_metrics(veh: dict) -> dict:
    noise = lambda s: s + random.gauss(0, abs(s) * 0.05 + 0.01)
    return {
        "drowsiness_score": round(max(0, min(1, noise(veh["base_drowsy"]))), 3),
        "blink_freq": round(max(0, noise(veh["base_blink"])), 1),
        "ear": round(max(0.10, noise(veh["base_ear"])), 3),
    }


def _push_fleet(base_url: str, vehicles: list) -> dict:
    try:
        import requests as _req
    except ImportError:
        print("[simulate_ota] requests not installed — using generated data directly")
        return {v["id"]: _gen_metrics(v) for v in vehicles}

    result = {}
    for veh in vehicles:
        m = _gen_metrics(veh)
        try:
            _req.post(
                f"{base_url}/api/fleet/update",
                json={"vehicle_id": veh["id"], "metrics": m},
                timeout=3,
            )
        except Exception:
            pass
        result[veh["id"]] = m
    return result


def _read_fleet(base_url: str) -> list:
    try:
        import requests as _req
        resp = _req.get(f"{base_url}/api/fleet/state", timeout=3)
        if resp.ok:
            return resp.json().get("vehicles", [])
    except Exception:
        pass
    return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:5000")
    ap.add_argument("--offline", action="store_true", help="Skip fleet HTTP, use local data only")
    args = ap.parse_args()

    from backend.fleet.fl_aggregator import FLAggregator

    agg = FLAggregator(bus=None, n_vehicles=len(VEHICLES))
    old_threshold = agg._current_threshold

    print("\n" + "=" * 80)
    print(f"{'CabinAI — Track 16: Federated Learning OTA Simulation':^80}")
    print("=" * 80)
    print(f"Simulating {len(VEHICLES)} vehicles...")
    print()

    # Step 1: Generate/push telemetry
    if args.offline:
        vehicle_metrics = {v["id"]: _gen_metrics(v) for v in VEHICLES}
    else:
        vehicle_metrics = _push_fleet(args.url, VEHICLES)
        time.sleep(0.3)
        fleet_data = _read_fleet(args.url)
        if fleet_data:
            for v in fleet_data:
                vid = v.get("vehicle_id")
                if vid and "drowsiness_score" in v:
                    vehicle_metrics[vid] = v

    # Step 2: Collect uncertainty
    print(f"{'Vehicle':<12} {'Driver':<10} {'Drowsiness':>12} {'Blink/min':>12} {'Alert?':>8}")
    print("-" * 60)

    for veh in VEHICLES:
        vid = veh["id"]
        m = vehicle_metrics.get(vid, _gen_metrics(veh))
        drowsy = m.get("drowsiness_score", 0)
        blink = m.get("blink_freq", 15)
        agg.collect_uncertainty(vid, drowsy, blink)
        alert = "YES" if drowsy > 0.45 or blink < 10 else "no"
        print(f"{vid:<12} {veh['driver']:<10} {drowsy:>12.3f} {blink:>12.1f} {alert:>8}")

    print()

    # Step 3: Aggregate
    update = agg.aggregate()

    if update:
        print(f"Pattern detected: {update['reason']}")
        print(f"Generating OTA threshold update...")
        print()

        # Step 4: Apply update
        agg.apply_update(update)

        # Step 5: Print before/after table
        print(f"{'Field':<30} {'Before':>15} {'After':>15}")
        print("-" * 62)
        print(f"{'drowsiness_threshold':<30} {old_threshold:>15.2f} {agg._current_threshold:>15.2f}")
        print(f"{'reason':<30} {'—':>15} {update.get('reason', '—'):>15}")
        print(f"{'vehicles_contributing':<30} {'—':>15} {update.get('vehicle_count', 0):>15}")
        print()
        print(f"OTA update written to logs/fl_audit.log")
        print(f"FL_THRESHOLD_UPDATE published to ZeroClaw bus")
    else:
        print("No fleet-wide pattern detected — threshold unchanged.")
        print(f"Current threshold: {old_threshold:.2f}")

    print("\n" + "=" * 80)

    status = agg.get_status()
    print(f"FL Status: threshold={status['current_threshold']}, updates={status['update_count']}, vehicles={status['vehicle_count']}")
    print("=" * 80)


if __name__ == "__main__":
    main()
