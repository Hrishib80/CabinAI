"""
Agent 7 — Local RAG Knowledge Layer.
Embedding: fastembed (ONNX, no torch needed) → falls back to keyword search.
Vector store: ChromaDB persistent (cabin_rag.db) — fleet network effect.
RAG corpus includes Hyderabad/Gachibowli location names to match the drive simulator.
"""
import os, time, warnings
from pathlib import Path

# Suppress the [transformers] PyTorch warning — we don't use the HF pipeline here
warnings.filterwarnings("ignore", message=".*PyTorch.*")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

_DB_PATH = os.getenv("RAG_DB_PATH",
    str(Path(__file__).parent.parent.parent / "cabin_rag.db"))

# Gachibowli/Hyderabad place names used in the game
HYDERABAD_REST_STOPS = [
    "DLF Cyber City fuel station, Gachibowli",
    "Biodiversity Junction rest area",
    "IKEA Hyderabad parking, Nallagandla",
    "Financial District service centre",
    "Outer Ring Road rest stop near Rajiv Gandhi International Airport",
    "Golkonda Fort parking area",
    "Hussain Sagar lakeside rest area",
    "Hi-Tech City metro station parking",
    "Shamshabad toll plaza rest area",
]

CORPUS = [
    # ── Warning lights ─────────────────────────────────────────────────────
    {"id": "w001", "cat": "warning", "text":
     "Engine overheating / coolant temperature warning light: red thermometer icon. "
     "Stop the vehicle immediately and turn off the engine. Do not open the bonnet until cool. "
     "Call roadside assistance. On the ORR near Gachibowli, the nearest service centre is "
     "at Financial District, about 2km ahead. Continuing to drive risks severe engine damage. "
     "Common causes in Hyderabad summer (April-June): low coolant, AC running too hard in 42°C heat, "
     "or a stuck thermostat."},
    {"id": "w002", "cat": "warning", "text":
     "Low oil pressure warning: red oil can icon. Stop the engine immediately. "
     "Check oil level when cool. Do not drive — engine damage will occur within minutes. "
     "Nearest fuel station with service: DLF Cyber City fuel station, Gachibowli."},
    {"id": "w003", "cat": "warning", "text":
     "Battery warning light / charging system warning: red battery icon. Electrical system fault. "
     "Reduce electrical load (turn off AC, heated seats, non-essential lights). "
     "Drive to a service centre soon — the battery may fail and leave you stranded. "
     "TATA service centre is available at Hi-Tech City, Madhapur."},
    {"id": "w004", "cat": "warning", "text":
     "Check engine light / MIL (malfunction indicator lamp): amber engine icon. "
     "If solid: emissions or engine management fault, drive to service soon. "
     "If flashing: serious misfire — reduce speed immediately. "
     "Nearest Maruti/Toyota service on ORR: Biodiversity Junction service road."},
    {"id": "w005", "cat": "warning", "text":
     "Brake system warning: red exclamation in circle. Check handbrake is released. "
     "If still on, brake fluid may be low or brake pads worn. "
     "Stop safely near Hi-Tech City flyover and seek service."},
    {"id": "w006", "cat": "warning", "text":
     "Tyre pressure (TPMS): amber exclamation in tyre icon. One or more tyres under-inflated. "
     "Pull over safely at Gachibowli stadium parking or ORR toll plaza to check/inflate tyres. "
     "Hyderabad heat causes pressure variation — ideal cold pressure is 32 PSI for sedans, 35 PSI for SUVs."},
    {"id": "w007", "cat": "warning", "text":
     "ABS warning: amber ABS letters. Anti-lock braking system fault. Normal brakes work "
     "but ABS assist is inactive. Drive carefully to the nearest service centre."},
    {"id": "w008", "cat": "warning", "text":
     "Airbag / SRS warning: amber person with circle. Supplemental restraint system fault. "
     "Airbags may not deploy in a collision. Service urgently — "
     "TATA Motors service centre in Kondapur is 3km from Gachibowli."},
    {"id": "w009", "cat": "warning", "text":
     "Power steering warning: amber steering wheel. Electric power steering fault. "
     "Steering becomes very heavy. Drive slowly to the nearest service centre."},
    {"id": "w010", "cat": "warning", "text":
     "Low fuel warning: amber fuel pump icon. Approximately 50-80 km of range remaining. "
     "Nearest fuel stations from Gachibowli: HP petrol pump on Gachibowli main road (0.5km), "
     "BPCL pump near DLF Cyber City (1.2km), Indian Oil near Financial District (2km), "
     "Reliance pump on ORR Service Road near Nanakramguda (3km)."},

    # ── Driving simulator scenarios — sim ↔ knowledge link ────────────────
    {"id": "sim001", "cat": "sim_link", "text":
     "Engine overheating in the driving simulator: caused by sustained high-speed driving "
     "(over 100 km/h on the ORR Highway segment) for more than 60 seconds, or by aggressive "
     "acceleration with high RPM. Mitigation: reduce speed to 60-80 km/h, ease off the throttle, "
     "and pull into the next rest stop (Biodiversity Junction or ORR Toll Plaza). "
     "If engine_temp > 0.85, the cabin assistant will trigger a critical TEMP alert."},
    {"id": "sim002", "cat": "sim_link", "text":
     "Tunnel driving in Hyderabad: the Durgam Cheruvu cable bridge tunnel and the proposed "
     "ORR underpass tunnel near Nanakramguda are simulated as low-light segments where headlights "
     "must be on. Reduce speed by 10-20 km/h. Watch for echoing horns and lane discipline. "
     "Tunnel speed limit: 50 km/h regardless of highway limit."},
    {"id": "sim003", "cat": "sim_link", "text":
     "Highway segment ORR (Outer Ring Road): 8-lane expressway, speed limit 100-120 km/h. "
     "From Gachibowli (Exit 16) to Shamshabad Airport (Exit 28) is 35 km. "
     "Toll: ₹70 for cars at Nanakramguda toll plaza. "
     "Emergency bays every 2 km. NHAI helpline 1033. "
     "Driving over the speed limit for >30 seconds triggers a warning in the simulator."},
    {"id": "sim004", "cat": "sim_link", "text":
     "Parking scenarios in the simulator: Gachibowli Stadium parking (free, 1000+ spaces, low traffic), "
     "IKEA Hyderabad Nallagandla (free, 600 spaces, weekends crowded), "
     "DLF Cyber City multilevel (paid ₹40/hr, secure, EV charging), "
     "Rajiv Gandhi Airport parking (₹120 for first 30 min, long-stay ₹400/day). "
     "Use indicators when pulling in. Speed limit in parking areas: 20-30 km/h."},
    {"id": "sim005", "cat": "sim_link", "text":
     "Emergency zone in the simulator: red and white barriers indicate a roadside emergency bay or "
     "ORR Toll Plaza emergency lane. Pull over here for breakdowns, tyre changes, or driver fatigue. "
     "From here, dial 1033 (NHAI), 108 (ambulance), or 100 (police). "
     "KIMS Hospital is 1.5 km from Gachibowli; Care Hospital Hi-Tech City is 3 km."},
    {"id": "sim006", "cat": "sim_link", "text":
     "Driving simulator controls: ↑ accelerate, ↓ brake / decelerate, ← steer left, → steer right. "
     "Press START to begin. Press STOP to pause. The car automatically decelerates if no key is held. "
     "Gear changes are automatic based on RPM. Engine overheating, low fuel, oil pressure, and battery "
     "warnings will trigger if you drive for too long without stopping."},

    # ── Safety / fatigue ───────────────────────────────────────────────────
    {"id": "s001", "cat": "safety", "text":
     "Drowsy driving kills. If you feel sleepy near Gachibowli, pull over at "
     "Biodiversity Junction rest area or the IKEA Hyderabad parking in Nallagandla. "
     "Rest for 20 minutes. Caffeine takes 20-30 min to act. "
     "Opening windows or turning up music does not prevent fatigue."},
    {"id": "s002", "cat": "safety", "text":
     "Recommended break schedule: at least a 15-minute break every 2 hours on long journeys. "
     "On the ORR from Gachibowli towards the airport: rest stops available at "
     "Shamshabad toll plaza (28km) and Rajiv Gandhi International Airport parking (35km)."},
    {"id": "s003", "cat": "safety", "text":
     "Emergency breakdown on ORR: call NHAI helpline 1033. "
     "Move vehicle to left shoulder, switch on hazard lights. "
     "Emergency bays are located every 2km on the Outer Ring Road. "
     "If injured, call 108 (Telangana ambulance) — average response time on ORR is 8-12 minutes."},
    {"id": "s004", "cat": "safety", "text":
     "Tunnel safety: keep headlights on even during the day. Maintain 3-second gap from car ahead. "
     "Do not change lanes inside Durgam Cheruvu tunnel. If you break down inside a tunnel, "
     "switch on hazard lights, exit to the emergency walkway, and use the SOS phone every 150m."},
    {"id": "s005", "cat": "safety", "text":
     "Hyderabad monsoon (June-September) driving: ORR can have aquaplaning at speeds above 80 km/h. "
     "Reduce speed by 30-40%. Increase following distance to 4 seconds. "
     "Common waterlogged areas: Mehdipatnam, Tolichowki, Nampally. Avoid these during heavy rain."},

    # ── Hyderabad-specific navigation ─────────────────────────────────────
    {"id": "h001", "cat": "navigation", "text":
     "Gachibowli to Hi-Tech City: 3km via Mindspace Junction, 8 minutes off-peak. "
     "Gachibowli to Shamshabad Airport: 35km via ORR, approximately 40 min without traffic. "
     "Gachibowli to Golkonda Fort: 12km via Tolichowki, 25 min. "
     "Gachibowli to Hussain Sagar lake: 18km via Masab Tank, 35 min. "
     "Gachibowli to Charminar: 22 km via Mehdipatnam, 50 min in traffic."},
    {"id": "h002", "cat": "navigation", "text":
     "Parking areas near Gachibowli: IKEA Hyderabad Nallagandla (free, large, 600 spaces), "
     "DLF Cyber City multilevel parking (paid, EV charging), "
     "Gachibowli stadium parking (free, weekends crowded), "
     "Inorbit Mall Cyberabad (paid ₹50/3hr). "
     "Highway rest area: ORR toll plaza at Nanakramguda Junction."},
    {"id": "h003", "cat": "navigation", "text":
     "Emergency services near Gachibowli: "
     "KIMS Hospital (1.5km, 24hr emergency, trauma centre), "
     "Care Hospital Hi-Tech City (3km, cardiac), "
     "Continental Hospital Nanakramguda (4km), "
     "Police station Raidurgam (1km), "
     "Cyberabad police control room: 040-27852333. "
     "Ambulance: 108. Police: 100. Fire: 101."},
    {"id": "h004", "cat": "navigation", "text":
     "Hyderabad tunnels and underpasses: Durgam Cheruvu cable bridge approach tunnel (Jubilee Hills), "
     "Punjagutta underpass, Telugu Talli flyover tunnel section, Mehdipatnam underpass. "
     "All have 50 km/h speed limit and require headlights on. "
     "ORR has multiple underpasses near Nanakramguda and Patancheru."},
    {"id": "h005", "cat": "navigation", "text":
     "Hi-Tech City to Gachibowli highway segment (3km): part of the IT Corridor. "
     "Speed limit 60 km/h, 6 lanes, central divider. "
     "Heavy congestion 9-11 AM and 6-8 PM weekdays. "
     "Alternative: Khajaguda Road (4 km, less traffic but narrower)."},
    {"id": "h006", "cat": "navigation", "text":
     "Shamshabad / Rajiv Gandhi International Airport (RGIA) directions: take ORR south from "
     "Gachibowli (Exit 16) → continue 28 km to Exit 28 (Shamshabad). "
     "Tolls: ₹70 at Nanakramguda. Multi-level parking at airport: ₹120 first 30 min, ₹400/day. "
     "Drop-off zone: kerbside at terminal entrance, 7-min free wait."},

    # ── Driver prefs ───────────────────────────────────────────────────────
    {"id": "p001", "cat": "prefs", "text":
     "Driver prefers gentle alert style. Typical fatigue onset at 68 minutes of continuous driving. "
     "Preferred rest stops: Biodiversity Junction (quiet), IKEA Hyderabad (cafe inside), "
     "Gachibowli Stadium (open air)."},
    {"id": "p002", "cat": "prefs", "text":
     "Driver routine: morning commute Gachibowli → Hi-Tech City, evening return via ORR. "
     "Typical drive duration 25-45 minutes. Heavy traffic between 9-10:30 AM."},

    # ── Rest stops with amenities / children's facilities ─────────────────
    {"id": "f001", "cat": "facilities", "text":
     "Rest stops near Gachibowli with child-friendly facilities: "
     "IKEA Hyderabad Nallagandla (2.5km) — free kids' play area (Småland), family restaurant, "
     "changing rooms, parking 600 spaces. Open 10AM-11PM daily. "
     "Biodiversity Junction rest area (3.2km) — small playground, park with walking paths, café, "
     "public toilets. Shaded seating. Ideal for a 15-20 minute break with children. "
     "Gachibowli Stadium parking (0.5km) — open-air ground, kids can run around, no structured play area, "
     "snack vendors nearby. "
     "Inorbit Mall Cyberabad (4km) — indoor play zone, food court, family restrooms, paid parking ₹50/3hr."},
    {"id": "f002", "cat": "facilities", "text":
     "Nearest rest stop with amenities from ORR Highway: ORR Toll Plaza Nanakramguda — "
     "public restrooms, small dhaba (food stall), parking area. No children's play area. "
     "For children's facilities, exit at Nallagandla (IKEA) or Gachibowli Stadium (open ground). "
     "Shamshabad Airport rest area (28km) has family lounge, kids' corner, and food court inside terminal."},
]

CONFIDENCE_THRESHOLD = 0.50


class Agent7LocalRAG:
    def __init__(self):
        self._embed_fn  = None
        self._chroma    = None
        self._ready     = False
        self._texts: list[str] = []
        self._ids:   list[str] = []
        self._load()

    def _load(self):
        # Try onnxruntime-based BGE embedder (no torch needed)
        try:
            import onnxruntime as ort
            from tokenizers import Tokenizer
            import numpy as np

            _bge_dir  = Path(__file__).parent.parent.parent / "models" / "bge_small_en"
            _onnx_path = _bge_dir / "onnx" / "model.onnx"
            _tok_path  = _bge_dir / "tokenizer.json"

            if _onnx_path.exists() and _tok_path.exists():
                self._ort_sess = ort.InferenceSession(
                    str(_onnx_path), providers=["CPUExecutionProvider"])
                self._tokenizer = Tokenizer.from_file(str(_tok_path))
                self._tokenizer.enable_padding(pad_token="[PAD]", length=128)
                self._tokenizer.enable_truncation(max_length=128)
                self._ready = True
                print("[Agent7] BGE-small ONNX embedder loaded")
            else:
                raise FileNotFoundError("BGE model not found")
        except Exception as e:
            print(f"[Agent7] BGE embedder unavailable ({e}), using keyword fallback")
            self._ort_sess  = None
            self._tokenizer = None
            self._ready = False

        # Seed texts
        self._texts = [d["text"] for d in CORPUS]
        self._ids   = [d["id"]   for d in CORPUS]

        # Pre-compute embeddings for in-memory cosine search
        if self._ready:
            self._embeddings = self._embed_batch(self._texts)
        else:
            self._embeddings = None

        # Try ChromaDB (optional — pulsar-client + meson-numpy unavailable on Windows ARM64)
        # The in-memory numpy cosine path is just as fast and accurate for our 30-doc corpus,
        # so this is treated as an *expected* fallback, not an error.
        self._chroma = None
        if os.getenv("CHROMADB_DISABLE", "").lower() not in ("1", "true", "yes"):
            try:
                import chromadb
                from chromadb.api.types import EmbeddingFunction

                class _NoOpEF(EmbeddingFunction):
                    def __call__(self, input):
                        return [[0.0] * 384]

                client = chromadb.PersistentClient(path=_DB_PATH)
                col    = client.get_or_create_collection(
                    "cabinai_rag_v2",
                    embedding_function=_NoOpEF(),
                    metadata={"hnsw:space": "cosine"},
                )
                if col.count() == 0 and self._ready and self._embeddings is not None:
                    col.add(ids=self._ids, documents=self._texts,
                            embeddings=self._embeddings.tolist(),
                            metadatas=[{"cat": d["cat"]} for d in CORPUS])
                    print(f"[Agent7] ChromaDB seeded with {len(CORPUS)} Hyderabad docs")
                elif col.count() > 0:
                    # Purge stale cache entries with non-Hyderabad locations
                    try:
                        cached = col.get(where={"cat": "cache"})
                        if cached and cached["ids"]:
                            banned = ['innsbruck', 'munich', 'vienna', 'salzburg', 'brenner']
                            bad_ids = [
                                cached["ids"][i] for i, doc in enumerate(cached["documents"])
                                if any(b in doc.lower() for b in banned)
                            ]
                            if bad_ids:
                                col.delete(ids=bad_ids)
                                print(f"[Agent7] Purged {len(bad_ids)} stale cache entries with foreign locations")
                    except Exception:
                        pass
                    print(f"[Agent7] ChromaDB loaded: {col.count()} docs")
                self._chroma = col
            except ImportError:
                print(f"[Agent7] ChromaDB not installed — using in-memory numpy "
                      f"({len(self._texts)} Hyderabad docs, sub-50ms latency)")
            except Exception as e:
                # Truncate noisy stack traces
                msg = str(e).split("\n")[0][:120]
                print(f"[Agent7] ChromaDB init skipped ({msg}) — in-memory numpy active "
                      f"({len(self._texts)} Hyderabad docs)")

    def _embed_one(self, text: str):
        """Embed a single text using BGE ONNX. Returns 1D numpy float32 array."""
        enc = self._tokenizer.encode(text)
        input_ids      = [enc.ids]
        attention_mask = [enc.attention_mask]
        token_type_ids = [[0] * len(enc.ids)]
        import numpy as np
        out = self._ort_sess.run(None, {
            "input_ids":      np.array(input_ids,      dtype=np.int64),
            "attention_mask": np.array(attention_mask, dtype=np.int64),
            "token_type_ids": np.array(token_type_ids, dtype=np.int64),
        })
        # Mean-pool last_hidden_state
        token_embs   = out[0][0]
        mask         = np.array(attention_mask[0], dtype=np.float32)[:, None]
        pooled       = (token_embs * mask).sum(0) / mask.sum()
        norm         = np.linalg.norm(pooled)
        return pooled / (norm + 1e-9)

    def _embed_batch(self, texts: list[str]):
        import numpy as np
        vecs = [self._embed_one(t) for t in texts]
        return np.stack(vecs)

    def _embed_all(self, texts: list[str]):
        return self._embed_batch(texts).tolist() if self._ready else None

    def query(self, question: str, top_k: int = 3) -> tuple[list[str], float, float]:
        t0 = time.perf_counter()

        if self._ready and self._ort_sess is not None:
            try:
                import numpy as np
                q_emb = self._embed_one(question)

                if self._chroma is not None:
                    results = self._chroma.query(
                        query_embeddings=[q_emb.tolist()],
                        n_results=min(top_k, self._chroma.count()),
                    )
                    chunks = results["documents"][0] if results["documents"] else []
                    dists  = results.get("distances", [[1.0]])[0]
                    confidence = max(0.0, 1.0 - dists[0]) if dists else 0.0
                    return chunks, min(1.0, confidence), (time.perf_counter() - t0) * 1000
                elif self._embeddings is not None:
                    sims    = self._embeddings @ q_emb
                    top_idx = np.argsort(sims)[::-1][:top_k]
                    chunks     = [self._texts[i] for i in top_idx]
                    confidence = float(sims[top_idx[0]])
                    return chunks, min(1.0, max(0.0, confidence)), (time.perf_counter() - t0) * 1000
            except Exception as e:
                print(f"[Agent7] embed query error: {e}")

        chunks, confidence = self._keyword_fallback(question, top_k)
        return chunks, confidence, (time.perf_counter() - t0) * 1000

    def _keyword_fallback(self, question: str, top_k: int) -> tuple[list[str], float]:
        q_words = set(question.lower().split())
        scored  = [(len(q_words & set(t.lower().split())) / max(len(q_words), 1), t)
                   for t in self._texts]
        scored.sort(reverse=True)
        top        = scored[:top_k]
        confidence = min(0.70, top[0][0]) if top and top[0][0] > 0 else 0.0
        return [t for _, t in top], confidence

    def add_cached_response(self, question: str, answer: str):
        BANNED_LOCATIONS = [
            'innsbruck', 'munich', 'vienna', 'salzburg', 'brenner', 'europa',
            'autobahn', 'raststätte', 'rastplatz', 'nord', 'süd',
        ]
        answer_lower = answer.lower()
        if any(loc in answer_lower for loc in BANNED_LOCATIONS):
            print(f"[Agent7] Rejected cache entry — contains non-Hyderabad location")
            return

        new_text = f"Q: {question} A: {answer}"
        new_id   = f"cache_{int(time.time() * 1000)}"
        self._texts.append(new_text)
        self._ids.append(new_id)
        CORPUS.append({"id": new_id, "cat": "cache", "text": new_text})

        if self._ready and self._ort_sess is not None:
            import numpy as np
            try:
                new_emb = self._embed_one(new_text)
                if self._embeddings is not None:
                    self._embeddings = np.vstack([self._embeddings, new_emb])
                if self._chroma is not None:
                    self._chroma.add(ids=[new_id], documents=[new_text],
                                     embeddings=[new_emb.tolist()],
                                     metadatas=[{"cat": "cache"}])
            except Exception:
                pass


_rag: Agent7LocalRAG | None = None


def get_rag() -> Agent7LocalRAG:
    global _rag
    if _rag is None:
        _rag = Agent7LocalRAG()
    return _rag
