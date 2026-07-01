/**
 * ZeroClaw bus — browser-side shared state and event pub/sub.
 * Mirrors the backend ZeroClawBus. Syncs with server via SSE + REST.
 */
class ZeroClawBus extends EventTarget {
    constructor() {
        super();
        this.state = {
            attention_score:      1.0,
            drowsiness_score:     0.0,
            drowsiness_flag:      false,
            ear:                  0.30,
            perclos:              0.0,
            blink_freq:           15.0,
            fatigue_forecast:     0.0,
            forecast_confidence:  0.0,
            recommended_rest:     '',
            route_complexity:     'unknown',
            driver_fatigue_state: 0.0,
            fatigue_forecast_t15: 0.0,
            proactive_alert_msg:  '',
            proactive_alert_urgency: '',
            npu_status:           'nominal',
            npu_temp_c:           45.0,
            npu_ber:              0.0,
            npu_latency_dev_ms:   0.0,
            network_state:        'online',
            battery_level:        1.0,
            session_events:       [],
            last_sync_ts:         0,
            next_sync_in_s:       300,
            agent7_escalate:      false,
        };
        this._safetyActive = false;
        this._sseSource    = null;
        this._frameQueue   = [];
        this._flushTimer   = null;
    }

    publish(event, data) {
        const _safetyPassthrough = new Set([
            'SAFETY_ALERT', 'PERCEPTION_UPDATE',
            'GAME_JUMP_REQUEST', 'GAME_SPEED_REQUEST',
            'GAME_WEATHER_REQUEST', 'GAME_TOGGLE_REQUEST',
        ]);
        if (this._safetyActive && !_safetyPassthrough.has(event)) return;

        this._apply(event, data);
        this.dispatchEvent(new CustomEvent(event, { detail: data }));
        this.dispatchEvent(new CustomEvent('STATE_CHANGE', { detail: this.state }));

        // Forward perception updates to backend (batched)
        if (event === 'PERCEPTION_UPDATE') {
            this._queueFrameFlush(data);
        }
    }

    subscribe(event, handler) {
        this.addEventListener(event, e => handler(e.detail));
    }

    getState() { return { ...this.state }; }

    // ----------------------------------------------------------------
    // SSE connection to backend
    // ----------------------------------------------------------------
    connectSSE(baseUrl = 'http://localhost:5000') {
        this._baseUrl = baseUrl;
        const src = new EventSource(`${baseUrl}/api/events`);
        src.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.event && msg.data !== undefined) {
                    this._apply(msg.event, msg.data);
                    this.dispatchEvent(new CustomEvent('STATE_CHANGE', { detail: this.state }));
                }
            } catch (_) {}
        };
        src.onerror = () => {
            setTimeout(() => this.connectSSE(baseUrl), 3000);
        };
        this._sseSource = src;

        // Drive the sync countdown locally — backend SYNC_TICK is internal only
        setInterval(() => {
            this._apply('SYNC_TICK', {});
            this.dispatchEvent(new CustomEvent('SYNC_TICK', { detail: {} }));
        }, 1000);
    }

    // ----------------------------------------------------------------
    // Batch-flush perception frames to backend (max 5/s to avoid overload)
    // ----------------------------------------------------------------
    _queueFrameFlush(data) {
        this._frameQueue.push(data);
        if (!this._flushTimer) {
            this._flushTimer = setTimeout(() => {
                const frames = this._frameQueue.splice(0);
                this._flushTimer = null;
                if (frames.length > 0 && this._baseUrl) {
                    fetch(`${this._baseUrl}/api/state/update`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(frames[frames.length - 1]),
                    }).catch(() => {});
                }
            }, 200);   // flush every 200 ms
        }
    }

    // ----------------------------------------------------------------
    _apply(event, data) {
        const s = this.state;
        if (event === 'PERCEPTION_UPDATE' && data) {
            s.attention_score  = data.attention_score  ?? s.attention_score;
            s.drowsiness_score = data.drowsiness_score ?? s.drowsiness_score;
            s.ear              = data.ear              ?? s.ear;
            s.perclos          = data.perclos          ?? s.perclos;
            s.blink_freq       = data.blink_freq       ?? s.blink_freq;

            if (s.drowsiness_score > 0.7 && !this._safetyActive) {
                this._activateSafety();
            } else if (s.drowsiness_score < 0.5) {
                this._safetyActive   = false;
                s.drowsiness_flag    = false;
            }
        }

        if (event === 'FATIGUE_FORECAST' && data) {
            s.fatigue_forecast    = data.fatigue_forecast    ?? 0;
            s.forecast_confidence = data.forecast_confidence ?? 0;
            const ctx = data.enriched_system_prompt || {};
            s.driver_fatigue_state  = ctx.driver_fatigue_state  ?? s.driver_fatigue_state;
            s.fatigue_forecast_t15  = ctx.fatigue_forecast_t15  ?? s.fatigue_forecast_t15;
            s.recommended_rest      = ctx.recommended_rest       ?? '';
            s.route_complexity      = ctx.route_complexity       ?? s.route_complexity;
            const alert = data.proactive_alert || {};
            s.proactive_alert_msg     = alert.msg     ?? '';
            s.proactive_alert_urgency = alert.urgency ?? '';
            const hw = data.hardware_health || {};
            s.npu_status = hw.status ?? 'nominal';
            s.last_sync_ts   = Date.now() / 1000;
            s.next_sync_in_s = 300;
        }

        if (event === 'SYNC_TICK') {
            s.next_sync_in_s = Math.max(0, s.next_sync_in_s - 1);
        }

        if (event === 'SESSION_EVENT' && data) {
            s.session_events = [...s.session_events.slice(-49), data];
        }

        if (event === 'SAFETY_ALERT') {
            s.drowsiness_flag = true;
        }
    }

    _activateSafety() {
        this._safetyActive    = true;
        this.state.drowsiness_flag = true;
        this.dispatchEvent(new CustomEvent('SAFETY_ALERT',
            { detail: { msg: 'DROWSINESS DETECTED', urgency: 'critical' } }));
        setTimeout(() => {
            if (this.state.drowsiness_score < 0.5) {
                this._safetyActive = false;
                this.state.drowsiness_flag = false;
            }
        }, 30000);
    }
}

window.ZeroClawBus = ZeroClawBus;
