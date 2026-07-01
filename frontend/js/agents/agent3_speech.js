/**
 * Agent 3 — Speech / STT.
 *
 * Two modes:
 *  1. CLICK-TO-TOGGLE (default): click once to start, click again to stop + transcribe
 *  2. ALWAYS-ON (mic held active): MediaRecorder fires ondataavailable every 3s,
 *     each chunk is sent for transcription automatically.
 *
 * Audio path: browser mic → MediaRecorder (WebM/opus) → Flask /api/agent3/transcribe
 */
class Agent3Speech {
    constructor(bus, backendUrl = 'http://localhost:5000') {
        this.bus           = bus;
        this.backendUrl    = backendUrl;
        this.active        = false;
        this._recorder     = null;
        this._chunks       = [];
        this._stream       = null;
        this._history      = [];
        this._onTranscript = null;
        this._alwaysOn     = false;   // set true via toggle-always-on button
    }

    init(onTranscript) {
        this._onTranscript = onTranscript;
        // Don't probe getUserMedia at startup — it fails before a user gesture even with
        // "Allowed" in browser settings. Instead just show READY and let the mic button
        // trigger the actual permission request on first click.
        this._setStatus('READY');
    }

    toggle() {
        if (this.active) {
            this._stop();
        } else {
            this._start();
        }
    }

    toggleAlwaysOn() {
        this._alwaysOn = !this._alwaysOn;
        const btn = document.getElementById('always-on-btn');
        if (btn) {
            btn.textContent = this._alwaysOn ? '🔴 Always On' : '⚫ Always On';
            btn.style.color = this._alwaysOn ? '#ff4444' : 'var(--muted)';
        }
        if (this._alwaysOn) {
            this._startAlwaysOn();
        } else {
            this._stop();
        }
    }

    // ── Ambient noise measurement ────────────────────────────────────
    async _measureNoise() {
        // Sample 1s of ambient audio using Web Audio API AnalyserNode.
        // Returns max RMS noise level 0..1 across ~20 FFT frames.
        try {
            const ctx      = new AudioContext();
            const source   = ctx.createMediaStreamSource(this._stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);

            const buf     = new Uint8Array(analyser.fftSize);
            const samples = 20;
            const delay   = 1000 / samples;   // ~50 ms per frame → ~1 s total
            let maxRms    = 0;

            for (let i = 0; i < samples; i++) {
                await new Promise(r => setTimeout(r, delay));
                analyser.getByteTimeDomainData(buf);
                let sum = 0;
                for (let j = 0; j < buf.length; j++) {
                    const v = (buf[j] - 128) / 128;
                    sum += v * v;
                }
                const rms = Math.sqrt(sum / buf.length);
                if (rms > maxRms) maxRms = rms;
            }

            source.disconnect();
            ctx.close();
            return maxRms;
        } catch (_e) {
            return 0;
        }
    }

    _applyNoiseBadge(rms) {
        this._noiseRms      = rms;
        this._minBlobSize   = rms > 0.08 ? 3000 : (rms > 0.02 ? 2000 : 1000);
        const badge = document.getElementById('noise-badge');
        if (!badge) return;
        if (rms > 0.08) {
            badge.className = 'noise-badge noise-loud';
            badge.title     = `Loud environment (RMS ${rms.toFixed(3)}) — min blob raised to 3 KB`;
        } else if (rms > 0.02) {
            badge.className = 'noise-badge noise-moderate';
            badge.title     = `Moderate noise (RMS ${rms.toFixed(3)}) — min blob 2 KB`;
        } else {
            badge.className = 'noise-badge noise-quiet';
            badge.title     = `Quiet environment (RMS ${rms.toFixed(3)})`;
        }
    }

    // ── Click-to-toggle ──────────────────────────────────────────────
    async _start() {
        if (this.active) return;
        const stream = await this._getStream();
        if (!stream) return;

        // 1-second ambient noise calibration before recording begins
        this._setTranscript('Calibrating noise…', 'interim');
        const noiseRms = await this._measureNoise();
        this._applyNoiseBadge(noiseRms);

        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus' : 'audio/webm';

        this._chunks   = [];
        this._recorder = new MediaRecorder(stream, { mimeType });
        this._recorder.ondataavailable = e => { if (e.data.size > 0) this._chunks.push(e.data); };
        this._recorder.onstop = () => this._onRecordingStop();
        this._recorder.start();
        this.active = true;
        this._setMicVisual(true);
        this._setTranscript('Recording… click MIC again to transcribe', 'interim');
        if (window.playMicStartSound) playMicStartSound();
    }

    _stop() {
        if (!this.active && !this._recorder) return;
        if (this._recorder && this._recorder.state !== 'inactive') {
            this._recorder.stop();
        }
        if (this._stream) {
            this._stream.getTracks().forEach(t => t.stop());
            this._stream = null;
        }
        this.active = false;
        this._setMicVisual(false);
        if (!this._alwaysOn) this._setTranscript('Transcribing…', 'interim');
        if (window.playMicStopSound) playMicStopSound();
    }

    // ── Always-on: sends 3s chunks automatically ─────────────────────
    async _startAlwaysOn() {
        const stream = await this._getStream();
        if (!stream) return;

        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus' : 'audio/webm';

        this._recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 16000 });
        this._recorder.ondataavailable = async (e) => {
            if (e.data.size > 500 && this._alwaysOn) {
                await this._transcribeBlob(new Blob([e.data], { type: 'audio/webm' }));
            }
        };
        this._recorder.start(3000);  // fire every 3 seconds
        this.active = true;
        this._setMicVisual(true);
        this._setTranscript('Always-on listening…', 'interim');
    }

    // ── Shared helpers ───────────────────────────────────────────────
    async _getStream() {
        try {
            this._stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true },
                video: false,
            });
            return this._stream;
        } catch (err) {
            this._setTranscript('Mic error: ' + err.message, 'error');
            this._setMicVisual(false);
            return null;
        }
    }

    async _onRecordingStop() {
        const blob    = new Blob(this._chunks, { type: 'audio/webm' });
        this._chunks  = [];
        const minSize = this._minBlobSize || 1000;
        if (blob.size < minSize) {
            this._setTranscript('No audio captured — speak for longer', 'error');
            return;
        }
        await this._transcribeBlob(blob);
    }

    async _transcribeBlob(blob) {
        const langEl = document.getElementById('lang-select');
        const lang   = (langEl && langEl.value) ? langEl.value : 'en';
        const formData = new FormData();
        formData.append('file', blob, 'recording.webm');
        formData.append('language', lang);
        try {
            const resp = await fetch(`${this.backendUrl}/api/agent3/transcribe`, {
                method: 'POST', body: formData,
            });
            if (resp.status === 429) {
                this._setTranscript('Rate limited — try again in a moment', 'error');
                return;
            }
            if (!resp.ok) {
                const t = await resp.text();
                throw new Error(`HTTP ${resp.status}: ${t.slice(0, 80)}`);
            }
            const data = await resp.json();
            const text = (data.text || '').trim();
            if (!text) {
                this._setTranscript('(no speech detected)', 'error');
                return;
            }
            this._handleFinal(text, data.latency_ms, data.source);
        } catch (err) {
            console.error('[Agent3] Transcription error:', err);
            this._setTranscript('Error: ' + err.message, 'error');
        }
    }

    _handleFinal(text, latencyMs, source) {
        const sourceLabel = source === 'local_distil_whisper' ? ' [local]'
                          : source === 'mock'                  ? ' [mock]' : '';
        this._setTranscript(text + sourceLabel, 'final');

        const features = extractFeatures(text);
        const route    = routeQuery(features, this.bus.getState());
        const result   = { text, features, route, ts: Date.now(), latency_ms: latencyMs };

        this._history.unshift(result);
        if (this._history.length > 20) this._history.pop();

        this.bus.publish('STT_RESULT', result);
        if (this._onTranscript) this._onTranscript(result);
        this.bus.publish('SESSION_EVENT', {
            type: 'stt_result', query: text.slice(0, 60),
            route, latency_ms: latencyMs, ts: Date.now() / 1000,
        });
    }

    _setMicVisual(active) {
        const btn = document.getElementById('mic-btn');
        if (btn) {
            btn.classList.toggle('active', active);
            btn.textContent = active ? 'STOP' : 'MIC';
            btn.title = active ? 'Recording — click to stop' : 'Click to record';
        }
        this._setStatus(active ? 'RECORDING' : 'READY');
    }

    _setStatus(text) {
        const el = document.getElementById('mic-status');
        if (!el) return;
        el.textContent = text;
        el.className   = 'mic-status ' + (text === 'RECORDING' ? 'listening' : 'ready');
    }

    _setTranscript(text, type) {
        const el = document.getElementById('transcript-display');
        if (!el) return;
        el.textContent = text;
        el.className   = 'voice-transcript ' + type;
    }

    getHistory() { return [...this._history]; }
}

window.Agent3Speech = Agent3Speech;
