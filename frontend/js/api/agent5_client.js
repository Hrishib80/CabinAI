/**
 * Agent 6 client + Agent 5 client — AIC100 cloud calls via backend proxy.
 */
const BACKEND = 'http://localhost:5000';

// ---------------------------------------------------------------------------
// Agent 5 — Proactive Sync
// ---------------------------------------------------------------------------
class Agent5Client {
    constructor(bus) {
        this.bus = bus;
        this._lastLatency = 0;
        this._syncCount = 0;
    }

    async forceSync(sessionBuffer, useMock = false, frameJpeg = null) {
        const t0 = performance.now();
        try {
            const body = { frames: sessionBuffer };
            if (frameJpeg) body.latest_frame_b64 = frameJpeg;
            const resp = await fetch(
                `${BACKEND}/api/agent5/sync?mock=${useMock}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const result = await resp.json();
            this._lastLatency = Math.round(performance.now() - t0);
            this._syncCount++;

            this.bus.publish('FATIGUE_FORECAST', result);
            this.bus.publish('SESSION_EVENT', {
                type: 'agent5_sync',
                fatigue_forecast: result.fatigue_forecast,
                latency_ms: result.latency_ms || this._lastLatency,
                ts: Date.now() / 1000,
            });
            return result;
        } catch (err) {
            console.error('[Agent5] Sync error:', err);
            throw err;
        }
    }

    getStats() {
        return { lastLatencyMs: this._lastLatency, syncCount: this._syncCount };
    }
}

// ---------------------------------------------------------------------------
// Agent 6 — Complex Query + Coaching
// ---------------------------------------------------------------------------
class Agent6Client {
    constructor(bus) {
        this.bus = bus;
        this._history = [];
    }

    async query(text, useMock = false) {
        const t0 = performance.now();
        const context = {
            ...this.bus.getState(),
            session_minutes: Math.floor(
                (this.bus.getState().session_events?.length || 0) / 12),
        };
        try {
            const resp = await fetch(`${BACKEND}/api/agent6/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: text, context, mock: useMock }),
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const result = await resp.json();
            const latency = result.latency_ms || Math.round(performance.now() - t0);

            this._history.unshift({
                query: text, response: result.response,
                latency_ms: latency, agent: 'Agent6', ts: Date.now(),
            });
            if (this._history.length > 20) this._history.pop();

            this.bus.publish('SESSION_EVENT', {
                type: 'agent6_query', query: text.slice(0, 50), latency_ms: latency,
                ts: Date.now() / 1000,
            });

            return result;
        } catch (err) {
            throw err;
        }
    }

    async generateCoaching(useMock = false) {
        const resp = await fetch(`${BACKEND}/api/agent6/coaching`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_log: { events: this.bus.getState().session_events },
                mock: useMock,
            }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
    }

    getHistory() { return [...this._history]; }
}

// ---------------------------------------------------------------------------
// Agent 7 frontend client
// ---------------------------------------------------------------------------
class Agent7Client {
    constructor(bus) {
        this.bus = bus;
        this._history = [];
    }

    async query(question, useMock = false) {
        const t0 = performance.now();
        const resp = await fetch(`${BACKEND}/api/agent7/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, mock: useMock }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const result = await resp.json();
        const latency = result.local_latency_ms || Math.round(performance.now() - t0);

        this._history.unshift({
            question, ...result, latency_ms: latency, ts: Date.now(),
        });
        if (this._history.length > 20) this._history.pop();

        if (result.escalate) {
            this.bus.publish('SESSION_EVENT', {
                type: 'agent7_escalate', question: question.slice(0, 50),
                local_conf: result.confidence, ts: Date.now() / 1000,
            });
        }
        return result;
    }

    getHistory() { return [...this._history]; }
}

window.Agent5Client = Agent5Client;
window.Agent6Client = Agent6Client;
window.Agent7Client = Agent7Client;
