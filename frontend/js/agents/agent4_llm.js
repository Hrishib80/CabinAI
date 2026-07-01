/**
 * Agent 4 — Fast Edge LLM.
 * Calls backend /api/agent4/generate (SSE streaming).
 * Backend uses: Genie SDK → Ollama → mock (in that preference order).
 * Handles 80% of voice queries; defers complex queries to Agent 6.
 */
class Agent4LLM {
    constructor(bus, baseUrl = 'http://localhost:5000') {
        this.bus     = bus;
        this.baseUrl = baseUrl;
        this._history = [];   // conversation history for display
    }

    async generate(query, features, onToken, onDone) {
        const route = routeQuery(features, this.bus.getState());

        if (route === 'AGENT6') {
            // Defer to Agent 6 client
            return false;   // caller should call Agent6Client instead
        }

        this.bus.publish('SESSION_EVENT',
            { type: 'agent4_query', query: query.slice(0, 50), ts: Date.now() / 1000 });

        const t0 = performance.now();
        let fullResponse = '';
        let tokenCount = 0;
        let lastTokenTs = Date.now();
        let doneCalled = false;
        let reader;

        const finishUp = (text) => {
            if (doneCalled) return;
            doneCalled = true;
            const latencyMs = performance.now() - t0;
            const tps       = tokenCount / (latencyMs / 1000);
            this._history.unshift({
                query, response: text,
                latency_ms: Math.round(latencyMs),
                tps: Math.round(tps * 10) / 10,
                agent: 'Agent4', ts: Date.now(),
            });
            if (this._history.length > 20) this._history.pop();
            if (onDone) onDone(text, { latency_ms: Math.round(latencyMs), tps });
        };

        // Watchdog: if no tokens for 10s OR total > 30s, give up gracefully.
        const watchdog = setInterval(() => {
            const stalled = (Date.now() - lastTokenTs) > 10_000;
            const tooLong = (performance.now() - t0) > 30_000;
            if ((stalled || tooLong) && !doneCalled) {
                clearInterval(watchdog);
                try { reader?.cancel(); } catch (_) {}
                const fallback = fullResponse.trim() ||
                    "I'm having trouble reaching the language model right now. Please try again in a moment.";
                if (onToken) onToken('', fallback);
                finishUp(fallback);
            }
        }, 1000);

        try {
            const resp = await fetch(`${this.baseUrl}/api/agent4/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, features }),
            });

            reader = resp.body.getReader();
            const dec    = new TextDecoder();
            let buf      = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop();

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const chunk = JSON.parse(line.slice(6));
                        if (chunk.token) {
                            fullResponse += chunk.token;
                            tokenCount++;
                            lastTokenTs = Date.now();
                            if (onToken) onToken(chunk.token, fullResponse);
                        }
                        if (chunk.done) {
                            clearInterval(watchdog);
                            finishUp(fullResponse);
                        }
                    } catch (_) {}
                }
            }
            // Stream ended without explicit {done:true}
            clearInterval(watchdog);
            finishUp(fullResponse || "(no response)");
        } catch (err) {
            clearInterval(watchdog);
            const errMsg = `[Agent 4 error: ${err.message}]`;
            if (onToken) onToken(errMsg, errMsg);
            finishUp(errMsg);
        }

        return true;
    }

    getHistory() { return [...this._history]; }
}

window.Agent4LLM = Agent4LLM;
