#!/usr/bin/env python3
"""
scripts/simulate_fleet.py — Push fake telemetry from 5 virtual vehicles.

Usage:
    python scripts/simulate_fleet.py [--url http://localhost:5000] [--interval 3]
"""
import argparse, json, math, random, time
import requests

VEHICLES = [
    {"id": "CAB-001", "driver": "Alice",  "base_ear": 0.32, "base_speed": 95},
    {"id": "CAB-002", "driver": "Bob",    "base_ear": 0.27, "base_speed": 110},
    {"id": "CAB-003", "driver": "Carol",  "base_ear": 0.35, "base_speed": 80},
    {"id": "CAB-004", "driver": "Dave",   "base_ear": 0.20, "base_speed": 120},
    {"id": "CAB-005", "driver": "Eve",    "base_ear": 0.30, "base_speed": 70},
]


def _gen_metrics(veh: dict, t: float) -> dict:
    noise = lambda s: s + random.gauss(0, s * 0.05)
    ear   = max(0.12, noise(veh["base_ear"] - 0.04 * math.sin(t / 60)))
    perclos = max(0, min(1, (0.28 - ear) * 3))
    drowsy  = max(0, min(1, 0.4 * (1 - ear / 0.35) + 0.4 * (perclos / 0.15) + 0.2 * random.random() * 0.3))

    return {
        "ear":             round(ear, 3),
        "perclos":         round(perclos, 3),
        "blink_freq":      round(noise(15), 1),
        "attention_score": round(max(0, 1 - drowsy * 1.2), 2),
        "drowsiness_score": round(drowsy, 2),
        "speed_kmh":       round(noise(veh["base_speed"]), 1),
        "fuel":            round(max(0, 1 - t / 3600), 2),
        "engine_temp":     round(noise(0.50), 2),
        "driver_id":       veh["driver"],
        "route_km":        round(veh["base_speed"] * t / 3600, 1),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url",      default="http://localhost:5000")
    ap.add_argument("--interval", type=float, default=3.0)
    args = ap.parse_args()

    base_url = args.url.rstrip("/")
    t_start  = time.time()

    print(f"[Fleet sim] Sending to {base_url}/api/fleet/update every {args.interval}s")
    print(f"[Fleet sim] Vehicles: {[v['id'] for v in VEHICLES]}")

    while True:
        t = time.time() - t_start
        for veh in VEHICLES:
            metrics = _gen_metrics(veh, t)
            try:
                r = requests.post(
                    f"{base_url}/api/fleet/update",
                    json={"vehicle_id": veh["id"], "metrics": metrics},
                    timeout=5,
                )
                status = r.json().get("vehicles", "?")
                print(f"  [{veh['id']}] drowsy={metrics['drowsiness_score']:.2f} "
                      f"speed={metrics['speed_kmh']} fleet_size={status}")
            except Exception as e:
                print(f"  [{veh['id']}] ERROR: {e}")
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
