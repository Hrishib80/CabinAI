"""Append-only JSONL audit log for every cloud egress from CabinAI."""
import json, time, threading
from pathlib import Path

LOG_PATH = Path('logs/cloud_egress.log')
_lock = threading.Lock()


def log_egress(stage: str, target: str, n_chars: int, redacted: bool = False):
    """Append one line to logs/cloud_egress.log."""
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts":       time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "stage":    stage,
        "target":   target,
        "n_chars":  n_chars,
        "redacted": redacted,
    }
    with _lock:
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
