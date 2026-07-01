/**
 * main.js — CabinAI application entry point.
 *
 * Key changes:
 *  - Agent 1 (face) and Agent 2 (gesture) share ONE camera.
 *  - Mic button is click-to-TOGGLE with audio feedback.
 *  - Agent 2 always started alongside Agent 1.
 *  - VLM frame (base64 JPEG) included in Agent 5 sync payload.
 *  - Driving game (Tab 4) initialised here.
 *  - Demo mode: ?demo=1 auto-triggers the pipeline.
 *  - Session export button.
 *  - MeloTTS-EN integration via AIC100 (falls back to speechSynthesis).
 */
const BACKEND_URL = 'http://localhost:5000';
const USE_MOCK    = false;

let bus, a1, a2, a3, a4, a5, a6, a7;
let syncIntervalId = null;
let initialized    = false;
let _ttsMuted      = false;
let _game          = null;
let _demoMode      = new URLSearchParams(location.search).get('demo') === '1';

// ── TTS ──────────────────────────────────────────────────────────────────────
// Serial TTS queue — only ONE utterance speaks at a time (no overlap).
let _ttsQueue = Promise.resolve();
let _lastSpoken = '';
let _lastSpokenTs = 0;
let _currentAudio = null;
let _ttsPlaying = false;  // true while audio is actively playing

async function speakResponse(text) {
    if (_ttsMuted || !text) return;
    text = String(text).trim();
    if (!text) return;

    // De-duplicate: skip if exact same text was spoken in the last 8s
    const now = Date.now();
    if (text === _lastSpoken && (now - _lastSpokenTs) < 8000) return;
    _lastSpoken   = text;
    _lastSpokenTs = now;

    // Queue this utterance behind any currently-playing one
    _ttsQueue = _ttsQueue.then(() => _speakImmediate(text)).catch(() => {});
    return _ttsQueue;
}

// speakAlert: for game fault alerts — interrupt if something is already playing
// to avoid old speech finishing long after the alert fires.
function speakAlert(text) {
    if (_ttsMuted || !text) return;
    // Stop anything currently playing
    if (_currentAudio) { try { _currentAudio.pause(); } catch (_) {} _currentAudio = null; }
    try { window.speechSynthesis?.cancel(); } catch (_) {}
    // Reset queue and play immediately
    _ttsQueue = Promise.resolve().then(() => _speakImmediate(text)).catch(() => {});
}
window.speakAlert = speakAlert;

async function speakResponse(text) {
    if (_ttsMuted || !text) return;
    text = String(text).trim();
    if (!text) return;

    // De-duplicate: skip if exact same text was spoken in the last 8s
    const now = Date.now();
    if (text === _lastSpoken && (now - _lastSpokenTs) < 8000) return;
    _lastSpoken   = text;
    _lastSpokenTs = now;

    // Queue this utterance behind any currently-playing one
    _ttsQueue = _ttsQueue.then(() => _speakImmediate(text)).catch(() => {});
    return _ttsQueue;
}

async function _speakImmediate(text) {
    try { if (_currentAudio) { _currentAudio.pause(); _currentAudio = null; } } catch (_) {}
    try { window.speechSynthesis?.cancel(); } catch (_) {}

    // Split into sentences for streaming perception
    const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
    const chunks = sentences.map(s => s.trim()).filter(s => s.length > 3);
    if (chunks.length <= 1) {
        // Short text: send as-is
        if (await _tryMeloTTS(text)) return;
        return _speakFallback(text);
    }
    // Multi-sentence: play first, then queue the rest
    for (const chunk of chunks) {
        if (!(await _tryMeloTTS(chunk))) {
            await _speakFallback(chunk);
        }
    }
}

// ── TTS voice selection ───────────────────────────────────────────────────
// We always want a consistent female voice.
// Primary: Kokoro af_bella (via /api/tts/speak).
// Fallback: browser speechSynthesis — force a female voice so it matches Kokoro.
let _femaleVoice = null;  // resolved once on first use

function _getFemaleBrowserVoice() {
    if (_femaleVoice) return _femaleVoice;
    const voices = window.speechSynthesis?.getVoices() || [];
    // Preference order: Microsoft Zira (Win11), Google UK English Female, any female
    const preferred = [
        /zira/i, /jenny/i, /aria/i,
        /google uk.*female/i, /google.*female/i,
        /female/i, /woman/i,
        /en.*us.*f/i, /en.*gb.*f/i,
        /en-us/i, /en-gb/i,   // last resort: any English voice
    ];
    for (const pat of preferred) {
        const v = voices.find(v => pat.test(v.name) && v.lang.startsWith('en'));
        if (v) { _femaleVoice = v; return v; }
    }
    // Absolute fallback: first English voice
    _femaleVoice = voices.find(v => v.lang.startsWith('en')) || null;
    return _femaleVoice;
}

async function _speakFallback(text) {
    if (!window.speechSynthesis) return;
    // Resolve the female voice — voices may not be loaded yet on first call
    if (!_femaleVoice) {
        await new Promise(resolve => {
            if (window.speechSynthesis.getVoices().length > 0) { resolve(); return; }
            window.speechSynthesis.addEventListener('voiceschanged', resolve, { once: true });
            setTimeout(resolve, 1500); // if event never fires
        });
    }
    return new Promise((resolve) => {
        const utt   = new SpeechSynthesisUtterance(text);
        const voice = _getFemaleBrowserVoice();
        if (voice) utt.voice = voice;
        utt.lang   = 'en-US';
        utt.rate   = 1.05;
        utt.pitch  = 1.1;   // slightly higher → more feminine
        utt.volume = 0.9;
        utt.onend  = () => resolve();
        utt.onerror = () => resolve();
        window.speechSynthesis.speak(utt);
        setTimeout(resolve, 15000);
    });
}

async function _tryMeloTTS(text) {
    try {
        const langEl = document.getElementById('lang-select');
        const lang   = (langEl && langEl.value) ? langEl.value : 'en';
        const resp = await fetch(`${BACKEND_URL}/api/tts/speak`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: text.slice(0, 500), language: lang }),
            // 6s timeout: fast fail so female browser fallback kicks in quickly
            signal: AbortSignal.timeout(6000),
        });
        if (!resp.ok) return false;
        const blob = await resp.blob();
        if (!blob || blob.size < 100) return false;
        const url   = URL.createObjectURL(blob);
        const audio = new Audio(url);
        _currentAudio = audio;
        // MUST await completion — without this the next sentence starts while this one
        // is still playing, creating the male+female overlap the user heard.
        await new Promise((resolve) => {
            audio.onended  = () => { URL.revokeObjectURL(url); _currentAudio = null; resolve(); };
            audio.onerror  = () => { URL.revokeObjectURL(url); _currentAudio = null; resolve(); };
            audio.play().catch(() => { URL.revokeObjectURL(url); _currentAudio = null; resolve(); });
            setTimeout(() => { URL.revokeObjectURL(url); _currentAudio = null; resolve(); }, 30000);
        });
        return true;
    } catch (_) {
        _currentAudio = null;
        return false;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    // ── 1. ZeroClaw bus ──────────────────────────────────────────────
    bus = new ZeroClawBus();
    bus.connectSSE(BACKEND_URL);
    window.bus = bus;   // expose for debugging + inline scripts

    // ── 2. Cloud / backend agents ────────────────────────────────────
    a5 = new Agent5Client(bus);
    a6 = new Agent6Client(bus);
    a7 = new Agent7Client(bus);
    a4 = new Agent4LLM(bus, BACKEND_URL);

    // ── 3. UI modules ────────────────────────────────────────────────
    initHUDRenderer(bus);
    initHealthMonitor(bus);
    initTab2RAG(bus, a7, a6);

    // ── 4. Mic / voice pipeline ──────────────────────────────────────
    a3 = new Agent3Speech(bus);
    a3.init(async ({ text, features, route }) => {
        const routeEl = document.getElementById('route-label');
        if (routeEl) {
            routeEl.textContent = route;
            routeEl.className   = `route-badge route-${route.toLowerCase()}`;
        }

        const responseEl = document.getElementById('response-display');
        if (responseEl) responseEl.textContent = '';

        if (route === 'AGENT4') {
            const handled = await a4.generate(
                text, features,
                (token, full) => { if (responseEl) responseEl.textContent = full; },
                (full, stats) => {
                    if (responseEl) responseEl.textContent = full;
                    speakResponse(full);
                    appLog(`[A4] ${stats.tps?.toFixed(1)} tok/s | ${stats.latency_ms}ms`);
                    // If response mentions rest stop, sync with game
                    if (_game && /rest|stop|pull over|fatigue/i.test(full)) {
                        const name = (full.match(/\b([A-Z][a-z]+ (?:Nord|South|North|East|West|Rest|Area|Service)(?:\s+\w+)?)\b/) || [])[1];
                        if (name) _game.state.recommendedRest = name;
                    }
                }
            );
            if (!handled) callAgent6(text, responseEl);
        } else {
            callAgent6(text, responseEl);
        }
    });

    // Mic button — single click to toggle start/stop
    const micBtn = document.getElementById('mic-btn');
    if (micBtn) micBtn.addEventListener('click', () => a3.toggle());

    // Always-on mic mode
    const alwaysOnBtn = document.getElementById('always-on-btn');
    if (alwaysOnBtn) alwaysOnBtn.addEventListener('click', () => a3.toggleAlwaysOn());

    // TTS mute toggle
    const ttsBtn = document.getElementById('tts-btn');
    if (ttsBtn) {
        ttsBtn.addEventListener('click', () => {
            _ttsMuted = !_ttsMuted;
            ttsBtn.textContent = _ttsMuted ? '🔇' : '🔊';
            ttsBtn.title       = _ttsMuted ? 'Voice response muted' : 'Voice response on';
            if (_ttsMuted) window.speechSynthesis?.cancel();
        });
    }

    // ── 5. Tab switching ─────────────────────────────────────────────
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            const panel = document.getElementById(btn.dataset.tab);
            if (panel) panel.classList.add('active');
        });
    });

    // ── 6. Start Agents 1 + 2 (shared camera) ───────────────────────
    await startPerceptionAndGesture();

    // ── 7. 5-min proactive sync ──────────────────────────────────────
    syncIntervalId = setInterval(triggerSync, 300_000);
    const forceSyncBtn = document.getElementById('force-sync-btn');
    if (forceSyncBtn) forceSyncBtn.addEventListener('click', triggerSync);

    // ── 8. Post-trip coaching button ─────────────────────────────────
    const coachBtn = document.getElementById('coaching-btn');
    if (coachBtn) {
        coachBtn.addEventListener('click', async () => {
            coachBtn.disabled    = true;
            coachBtn.textContent = 'Generating…';
            try {
                const report = await a6.generateCoaching(USE_MOCK);
                renderCoachingReport(report);
            } catch (e) {
                appLog('[Coach] Error: ' + e.message, 'error');
            } finally {
                coachBtn.disabled    = false;
                coachBtn.textContent = 'Generate Coaching Report';
            }
        });
    }

    // ── 9. Session export ────────────────────────────────────────────
    const exportBtn = document.getElementById('export-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            const payload = {
                ts:         new Date().toISOString(),
                bus_state:  bus.getState(),
                a3_history: a3?.getHistory() || [],
                a4_history: a4?.getHistory() || [],
                a6_history: a6?.getHistory() || [],
                game_state: _game?.getState() || null,
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)],
                { type: 'application/json' });
            const url  = URL.createObjectURL(blob);
            const a    = Object.assign(document.createElement('a'), {
                href: url, download: `cabinai_session_${Date.now()}.json`,
            });
            a.click();
            URL.revokeObjectURL(url);
            appLog('[Export] Session JSON downloaded');
        });
    }

    // ── 10. Driving game ─────────────────────────────────────────────
    // Defer until after first layout so canvas dimensions are known.
    // The 3D game needs window.THREE (loaded as an ESM module → 'three-ready' event).
    // Wait for it unless ?game=2d forced the legacy renderer.
    (function startGameWhenReady() {
        const force2D = new URLSearchParams(location.search).get('game') === '2d';
        const go = () => requestAnimationFrame(() => initDrivingGame());
        if (force2D || window.THREE) { go(); return; }
        let started = false;
        const once = () => { if (started) return; started = true; go(); };
        window.addEventListener('three-ready', once, { once: true });
        // Fallback: if THREE never arrives in 4s, start anyway (will use 2D class if 3D unavailable)
        setTimeout(once, 4000);
    })();

    // ── 11. Demo mode auto-trigger ───────────────────────────────────
    if (_demoMode) {
        appLog('[Demo] Demo mode active — will trigger pipeline when driving starts');
        // Wait until the user actually starts driving before firing the demo script.
        // This prevents false Agent 6 queries + TTS on page load.
        const _waitForDrive = () => {
            if (_game && !_game.state.paused) {
                setTimeout(runDemoScript, 2000);
            } else {
                setTimeout(_waitForDrive, 500);
            }
        };
        _waitForDrive();
    }

    // ── 12. Game fault injection / clear toggle ────────────────────
    // Click once to inject, click again to clear (and silence the alert).
    document.querySelectorAll('.fault-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!_game) return;
            const fault = btn.dataset.fault;
            const isActive = btn.classList.toggle('fault-active');
            if (isActive) {
                _game.injectFault(fault);
                appLog(`[Game] Fault injected: ${fault}`);
            } else {
                _game.clearFault?.(fault);
                appLog(`[Game] Fault cleared: ${fault}`);
            }
        });
    });

    // Click anywhere on the AI-bar / alert overlay to dismiss the active game alert
    document.getElementById('game-llm-panel')?.addEventListener('click', () => {
        if (_game) {
            _game.state.activeAlert = null;
            _game.state.alertTimeout = 0;
        }
    });

    // ── 13. Game speed controls ──────────────────────────────────────
    document.getElementById('game-speed-up')?.addEventListener('click', () => {
        if (_game) { _game.state.targetSpeed = Math.min(200, _game.state.targetSpeed + 20); }
    });
    document.getElementById('game-speed-down')?.addEventListener('click', () => {
        if (_game) { _game.state.targetSpeed = Math.max(0, _game.state.targetSpeed - 20); }
    });
    document.getElementById('game-weather-btn')?.addEventListener('click', () => {
        if (!_game) return;
        const weathers = ['clear', 'rain', 'fog'];
        const cur = weathers.indexOf(_game.state.weather);
        _game.setWeather(weathers[(cur + 1) % weathers.length]);
    });

    // Camera preset cycle: Cockpit → Hood → Chase
    const _camPresets = ['cockpit', 'hood', 'chase'];
    const _camLabels  = { cockpit: '🎥 Cockpit', hood: '🎥 Hood', chase: '🎥 Chase' };
    let _camIdx = 0;
    document.getElementById('game-cam-btn')?.addEventListener('click', () => {
        if (!_game) return;
        _camIdx = (_camIdx + 1) % _camPresets.length;
        const preset = _camPresets[_camIdx];
        if (typeof _game.setCamPreset === 'function') _game.setCamPreset(preset);
        const btn = document.getElementById('game-cam-btn');
        if (btn) btn.textContent = _camLabels[preset];
        appLog(`[Game] Camera: ${preset}`);
    });

    appLog('CabinAI ready');

    // ── Startup greeting (gated on first user interaction — browser autoplay policy) ──
    setupStartupGreeting();
});

const GREETING_TEXT = "CabinAI ready. I am monitoring your alertness and will alert you about vehicle faults and rest stops.";

let _greeted = false;
function setupStartupGreeting() {
    const greet = () => {
        if (_greeted) return;
        _greeted = true;
        try { if (window._getAudioCtx) window._getAudioCtx(); } catch (_) {}
        appLog('[CabinAI] Greeting');
        // Send greeting as ONE TTS call (no sentence chunking) so it comes out as
        // a single Kokoro synthesis = one voice, fast.
        _ttsQueue = _ttsQueue.then(() => _tryMeloTTS(GREETING_TEXT).then(ok => {
            if (!ok) _speakFallback(GREETING_TEXT);
        })).catch(() => {});
        const transcriptEl = document.getElementById('response-display');
        if (transcriptEl) transcriptEl.textContent = GREETING_TEXT;
        window.removeEventListener('click', greet);
        window.removeEventListener('keydown', greet);
    };
    window.addEventListener('click', greet, { once: false });
    window.addEventListener('keydown', greet, { once: false });
}

// ── Driving game initialisation ──────────────────────────────────────────────
function initDrivingGame() {
    const gameCanvas = document.getElementById('game-canvas');
    if (!gameCanvas) return;

    function resizeGame() {
        const vp = gameCanvas.parentElement;
        if (!vp) return;
        const r = vp.getBoundingClientRect();
        if (r.width > 10 && r.height > 10) {
            gameCanvas.width  = Math.floor(r.width);
            gameCanvas.height = Math.floor(r.height);
        }
    }
    resizeGame();
    window.addEventListener('resize', resizeGame);
    // Resize after layout settles + on tab switch
    setTimeout(resizeGame, 100);
    setTimeout(resizeGame, 400);
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            requestAnimationFrame(resizeGame);
            setTimeout(resizeGame, 80);
        });
    });

    // Use the 3D game when THREE is available; otherwise fall back to the legacy 2D class.
    let GameClass = window.DrivingGame;
    if (window.DrivingGame3D && !window.THREE) {
        appLog('[Game] THREE.js unavailable — using 2D fallback renderer');
        GameClass = window.DrivingGame2D || window.DrivingGame;
    }
    _game = new GameClass(gameCanvas, bus);

    const drowsyBadge = document.getElementById('cockpit-drowsy-badge');

    // Update cockpit overlay + drowsy badge from bus
    bus.subscribe('PERCEPTION_UPDATE', d => {
        if (drowsyBadge) drowsyBadge.style.display = d.drowsiness_score > 0.65 ? 'block' : 'none';

        // Update camera-overlay metrics
        const att = (d.attention_score ?? 1).toFixed(2);
        const drw = (d.drowsiness_score ?? 0).toFixed(2);
        const emo = d.emotion || 'neutral';
        const emojiMap = { neutral:'😐', happy:'😀', surprised:'😮', frustrated:'😠', tired:'😩', distracted:'😶' };
        const setT = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        setT('cockpit-att',   `ATT ${att}`);
        setT('cockpit-drwsy', `DRWSY ${drw}`);
        setT('cockpit-emo',   `${emojiMap[emo] || '😐'} ${emo}`);
    });

    // Forward GAME_STATE → backend so Agent 4 sees live drive context
    bus.subscribe('GAME_STATE', data => {
        try {
            fetch(`${BACKEND_URL}/api/state/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            }).catch(() => {});
        } catch (_) {}
    });

    // SAFETY_FLOOR_HIT — deterministic voice commands bypass LLM entirely
    bus.subscribe('SAFETY_FLOOR_HIT', result => {
        if (!_game) return;
        cockpitLog(`[SafetyFloor] ${result.action}: ${result.label} (${result.latency_ms}ms)`, 'ok');
        switch (result.action) {
            case 'GAME_JUMP':
                _game.jumpToSegment(result.value);
                break;
            case 'GAME_SPEED':
                _game.state.targetSpeed = Math.max(0, Math.min(200, (_game.state.targetSpeed || 0) + result.value));
                break;
            case 'GAME_STOP':
                _game.stopDriving();
                break;
            case 'GAME_WEATHER':
                _game.setWeather(result.value);
                break;
            case 'GAME_PAUSE':
                _game.stopDriving();
                break;
            case 'GAME_RESUME':
                _game.startDriving();
                break;
        }
    });

    // Start game render loop (paused by default)
    _game.start();

    // Proactive 90-minute driving nudge: check every 60s, fire when distance > 50km and drowsy
    setInterval(() => {
        if (!_game || _game.state.paused) return;
        const s = _game.state;
        const drowsiness = bus.getState().drowsiness_score;
        if (s.distance > 50 && drowsiness > 0.5) {
            const restTypes = ['rest', 'parking', 'gas', 'emergency'];
            let nearestName = 'Biodiversity Junction';
            let nearestDist = 0;
            for (let off = 1; off <= HYDERABAD_ROUTE.length; off++) {
                const seg = HYDERABAD_ROUTE[(s.routeIdx + off) % HYDERABAD_ROUTE.length];
                if (restTypes.includes(seg.type)) {
                    nearestName = seg.name;
                    nearestDist = (off * 0.4).toFixed(1);
                    break;
                }
            }
            const msg = `You have been driving ${Math.floor(s.distance)} km. ${nearestName} has rest facilities ${nearestDist} km ahead. Should I navigate there?`;
            if (window.speakResponse) window.speakResponse(msg);
            const panel = document.getElementById('game-llm-panel');
            if (panel) panel.textContent = msg;
        }
    }, 60000);

    // Bus handlers for voice-commanded game control events
    bus.subscribe('GAME_JUMP_REQUEST', d => { if (_game && d.idx != null) _game.jumpToSegment(d.idx); });
    bus.subscribe('GAME_SPEED_REQUEST', d => { if (_game) _game.state.targetSpeed = Math.max(0, Math.min(200, (_game.state.targetSpeed || 0) + (d.delta || 0))); });
    bus.subscribe('GAME_WEATHER_REQUEST', d => { if (_game && d.weather) _game.setWeather(d.weather); });
    bus.subscribe('GAME_TOGGLE_REQUEST', () => { if (_game) _game.togglePause?.(); });

    // LLM rest recommendations → game + cockpit metric
    bus.subscribe('FATIGUE_FORECAST', data => {
        if (!_game) return;
        const rest = data.enriched_system_prompt?.recommended_rest;
        const fatigue = data.fatigue_forecast || 0;
        const setT = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        setT('cockpit-fatigue-val', `${(fatigue * 100).toFixed(0)}%`);
        if (rest) {
            _game.state.recommendedRest = rest;
            if (window.playRestStopChime) playRestStopChime();
            setT('cockpit-rest-val', `rest: ${rest}`);
            const p = document.getElementById('game-llm-panel');
            if (p) p.textContent = `🛏 Rest at ${rest} · Fatigue T+15: ${(fatigue * 100).toFixed(0)}%`;
            cockpitLog('[Agent5] Rest stop suggested: ' + rest, 'ok');
        }
    });

    // GAME_ALERT → AI bar + cockpit log
    bus.subscribe('GAME_ALERT', alert => {
        const p = document.getElementById('game-llm-panel');
        if (p) {
            const col = alert.severity === 'critical' ? '#ff4444' :
                        alert.severity === 'warning'  ? '#ffaa00' : '#0af';
            p.innerHTML = `<span style="color:${col}">⚠ [${alert.type}]</span> ${alert.msg}`;
        }
        cockpitLog(`[Game] ${alert.type}: ${alert.msg}`,
               alert.severity === 'critical' ? 'error' :
               alert.severity === 'warning'  ? 'warn'  : 'info');
    });

    // Mirror SESSION_EVENT and other bus events to cockpit log
    bus.subscribe('SESSION_EVENT', d => {
        const t = d.type || 'event';
        cockpitLog(`[${t}] ${d.query || d.fatigue_forecast || ''} ${d.latency_ms ? d.latency_ms + 'ms' : ''}`.trim(), 'info');
    });

    // Start / Stop buttons
    document.getElementById('game-start-btn')?.addEventListener('click', () => {
        _game.startDriving();
        cockpitLog('[Game] Started driving — use arrow keys ↑↓←→', 'ok');
        gameCanvas.focus?.();
    });
    document.getElementById('game-stop-btn')?.addEventListener('click', () => {
        _game.stopDriving();
        cockpitLog('[Game] Stopped', 'info');
    });

    // Jump-to-location dropdown
    document.getElementById('game-location-select')?.addEventListener('change', (e) => {
        const idx = parseInt(e.target.value);
        if (!isNaN(idx) && _game) {
            _game.jumpToSegment(idx);
            const seg = window.HYDERABAD_ROUTE?.[idx];
            cockpitLog(`[Game] Jumped to ${seg?.name || 'segment ' + idx}`, 'info');
            e.target.value = '';
        }
    });
}

// Cockpit log helper (the main agent log panel on Tab 1)
function cockpitLog(msg, level = 'info') {
    const el = document.getElementById('cockpit-log');
    if (!el) return;
    const entry = document.createElement('div');
    entry.className = 'log-' + level;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    el.prepend(entry);
    while (el.children.length > 80) el.removeChild(el.lastChild);
}
window.cockpitLog = cockpitLog;

// ── Agent 1 + 2 shared startup ───────────────────────────────────────────────
async function startPerceptionAndGesture() {
    const video  = document.getElementById('agent1-video');
    const canvas = document.getElementById('agent1-canvas');
    if (!video || !canvas || initialized) return;

    a2 = new Agent2Gesture(bus);
    await a2.init();
    a2.start();

    a1 = new Agent1Perception(bus, video, canvas);
    await a1.init();

    a1.setGestureHandler((results, cvs, ctx) => a2.onHandResults(results, cvs, ctx));
    a1.start();

    initialized = true;
    appLog('[Agent1+2] Face mesh + gesture started on shared camera');

    bus.subscribe('GESTURE_ACTION', (data) => {
        const toast = document.getElementById('gesture-toast');
        if (toast) {
            const icons = {
                MUTE_AUDIO:    '✋ Muted',
                DISMISS_ALERT: '🖐 Alert Dismissed',
                NAV_SELECT:    '☝ Nav Selected',
                REJECT:        '👎 Rejected',
                CONFIRM:       '👍 Confirmed',
                CALL_ACCEPT:   '✌ Call Accepted',
                CALL_DECLINE:  '🤙 Call Declined',
            };
            toast.textContent  = icons[data.action] || data.label;
            toast.style.display = 'block';
            setTimeout(() => { toast.style.display = 'none'; }, 2500);
        }

        const histEl = document.getElementById('gesture-history');
        if (histEl) {
            const entry = document.createElement('div');
            entry.className   = 'gesture-entry';
            entry.textContent = data.gesture + ' → ' + data.label;
            histEl.prepend(entry);
            if (histEl.children.length > 10) histEl.lastChild.remove();
        }

        // Game controls via gesture
        if (_game) {
            if (data.action === 'CONFIRM')       _game.state.targetSpeed = Math.min(200, _game.state.targetSpeed + 10);
            if (data.action === 'REJECT')        _game.state.targetSpeed = Math.max(0,   _game.state.targetSpeed - 20);
            if (data.action === 'DISMISS_ALERT') _game.state.activeAlert = null;
        }
    });
}

// ── Agent 5 proactive sync ───────────────────────────────────────────────────
async function triggerSync() {
    const btn = document.getElementById('force-sync-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }

    const frames    = a1 ? a1.getSessionBuffer() : [];
    const frameJpeg = a1 ? a1.getLatestJpeg?.() : null;

    appLog(`[Agent5] Sync → ${frames.length} frames, ~${JSON.stringify(frames).length} bytes`);

    try {
        const result = await a5.forceSync(frames, USE_MOCK, frameJpeg);
        appLog(`[Agent5] Forecast: ${(result.fatigue_forecast * 100).toFixed(0)}% | ${result.latency_ms}ms`);
    } catch (err) {
        appLog('[Agent5] Sync error: ' + err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Force 5-min Sync Now'; }
    }
}

// ── Agent 6 call ─────────────────────────────────────────────────────────────
async function callAgent6(text, responseEl) {
    if (responseEl) responseEl.textContent = '[Agent 6 — AIC100…]';
    try {
        const result = await a6.query(text, USE_MOCK);
        if (responseEl) responseEl.textContent = result.response;
        speakResponse(result.response);
        appLog(`[A6] ${result.latency_ms}ms`);
        // Sync rest stop to game
        if (_game && /rest|stop|pull over/i.test(result.response)) {
            const m = result.response.match(/\b([A-Z][a-z]+(?: \w+){0,3})\b/);
            if (m) _game.state.recommendedRest = m[1];
        }
    } catch (err) {
        if (responseEl) responseEl.textContent = '[Agent 6 error: ' + err.message + ']';
        appLog('[A6] Error: ' + err.message, 'error');
    }
}

// ── Tab 2 — RAG interface ────────────────────────────────────────────────────
function initTab2RAG(bus, a7, a6) {
    const queryInput  = document.getElementById('rag-input');
    const askBtn      = document.getElementById('rag-ask-btn');
    const ragResponse = document.getElementById('rag-response');
    const ragSource   = document.getElementById('rag-source');
    const ragLatency  = document.getElementById('rag-latency');

    if (!askBtn) return;

    async function doRAG(question) {
        if (!question) return;
        if (ragResponse) ragResponse.textContent = 'Searching…';
        try {
            const result = await a7.query(question, USE_MOCK);

            const entry = document.createElement('div');
            entry.className = 'mcp-log-entry';
            entry.textContent = `[${new Date().toLocaleTimeString()}] A7 ${result.source} conf=${result.confidence?.toFixed(2)} ${result.local_latency_ms || result.latency_ms}ms`;
            const log = document.getElementById('mcp-log');
            if (log) { log.prepend(entry); if (log.children.length > 50) log.lastChild.remove(); }

            if (ragSource) {
                ragSource.textContent = result.source === 'local'
                    ? `Local RAG (conf: ${(result.confidence * 100).toFixed(0)}%)`
                    : `Cloud — Agent 6 escalation (local conf: ${(result.confidence * 100).toFixed(0)}%)`;
                ragSource.className = result.source === 'local' ? 'source-local' : 'source-cloud';
            }
            if (ragLatency) {
                ragLatency.textContent = result.source === 'local'
                    ? `${result.latency_ms}ms (local)`
                    : `${result.local_latency_ms}ms local + ${result.cloud_latency_ms}ms cloud`;
            }
            if (ragResponse) {
                const answer = result.source === 'local'
                    ? result.chunks?.[0] || 'No result.'
                    : result.cloud_answer || 'No cloud answer.';
                ragResponse.textContent = answer;
                speakResponse(answer.slice(0, 120));
            }
        } catch (err) {
            if (ragResponse) ragResponse.textContent = 'Error: ' + err.message;
        }
    }

    askBtn.addEventListener('click', () => doRAG(queryInput?.value?.trim()));
    queryInput?.addEventListener('keydown', e => { if (e.key === 'Enter') doRAG(queryInput.value.trim()); });

    document.querySelectorAll('.warning-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const q = btn.dataset.question;
            if (queryInput) queryInput.value = q;
            doRAG(q);
            if (window.playAlertBeep) playAlertBeep('advisory');
        });
    });
}

// ── Demo script (auto mode) ──────────────────────────────────────────────────
async function runDemoScript() {
    appLog('[Demo] Starting demo sequence');
    // 1. Trigger a RAG query
    const ragInput = document.getElementById('rag-input');
    const ragBtn   = document.getElementById('rag-ask-btn');
    if (ragInput && ragBtn) {
        ragInput.value = 'engine temperature warning light red';
        ragBtn.click();
    }
    await _sleep(3000);
    // 2. Force Agent 5 sync
    await triggerSync();
    await _sleep(2000);
    // 3. Call Agent 6 with a complex query
    const responseEl = document.getElementById('response-display');
    await callAgent6('I feel tired, should I take a break? What is the nearest rest stop?', responseEl);
    appLog('[Demo] Demo sequence complete');
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Coaching report renderer ─────────────────────────────────────────────────
function renderCoachingReport(report) {
    const el = document.getElementById('coaching-output');
    if (!el) return;
    el.style.display = 'block';
    el.innerHTML = `
        <h3>Post-Trip Coaching Report</h3>
        <p>${report.summary || ''}</p>
        ${report.fatigue_events?.length ? `
        <h4>Fatigue Events</h4>
        <ul>${report.fatigue_events.map(e =>
            `<li><strong>T+${e.timestamp_min}min</strong> [${e.severity}]: ${e.description}</li>`
        ).join('')}</ul>` : ''}
        ${report.recommendations?.length ? `
        <h4>Recommendations</h4>
        <ul>${report.recommendations.map(r => `<li>${r}</li>`).join('')}</ul>` : ''}
        ${report.driver_profile_update ? `
        <h4>Updated Driver Profile</h4>
        <pre>${JSON.stringify(report.driver_profile_update, null, 2)}</pre>` : ''}
        <p class="latency">Generated in ${report.latency_ms || 0}ms via Agent 6 (gpt-oss-20b / AIC100)</p>
    `;
}

// ── Backend health check ─────────────────────────────────────────────────────
async function checkBackend() {
    const dot = document.getElementById('backend-dot');
    const txt = document.getElementById('backend-status-text');
    try {
        const r = await fetch(`${BACKEND_URL}/api/health`,
            { signal: AbortSignal.timeout(3000) });
        const ok = r.ok;
        if (dot) dot.className = ok ? 'backend-dot' : 'backend-dot offline';
        if (txt) txt.textContent = ok ? 'Backend connected' : 'Backend error';
    } catch {
        if (dot) dot.className = 'backend-dot offline';
        if (txt) txt.textContent = 'Backend offline (mock mode)';
    }
}
checkBackend();
setInterval(checkBackend, 15000);

// ── Mini app log ─────────────────────────────────────────────────────────────
function appLog(msg, level = 'info') {
    const el = document.getElementById('app-log');
    if (!el) return;
    const entry = document.createElement('div');
    entry.className   = 'log-' + level;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    el.prepend(entry);
    if (el.children.length > 100) el.lastChild.remove();
}

window.triggerSync  = triggerSync;
window.appLog       = appLog;
window.speakResponse = speakResponse;
