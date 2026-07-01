/**
 * HUD renderer — updates all metric displays in Tab 1.
 * Called on every PERCEPTION_UPDATE and FATIGUE_FORECAST bus event.
 */
function initHUDRenderer(bus) {
    const EL = id => document.getElementById(id);

    function fmt(v, dec = 2) { return typeof v === 'number' ? v.toFixed(dec) : '—'; }

    function colorForScore(score) {
        if (score > 0.7) return '#ff4444';
        if (score > 0.4) return '#ffaa00';
        return '#44ff88';
    }

    function updateBar(barId, value, max = 1.0) {
        const el = EL(barId);
        if (!el) return;
        const pct = Math.min(100, Math.max(0, (value / max) * 100));
        el.style.width = pct + '%';
        el.style.background = colorForScore(value / max);
    }

    let _lastDrowsyAlert  = 0;
    let _lastProactiveMsg = '';

    bus.subscribe('PERCEPTION_UPDATE', (data) => {
        if (EL('ear-val'))          EL('ear-val').textContent         = fmt(data.ear, 3);
        updateBar('ear-bar', 1 - (data.ear || 0.3) / 0.40);
        if (EL('perclos-val'))      EL('perclos-val').textContent     = fmt(data.perclos * 100, 1) + '%';
        if (EL('blink-val'))        EL('blink-val').textContent       = fmt(data.blink_freq, 0) + '/min';
        if (EL('attention-val'))    EL('attention-val').textContent   = fmt(data.attention_score, 2);
        if (EL('drowsiness-val'))   EL('drowsiness-val').textContent  = fmt(data.drowsiness_score, 2);
        if (EL('fps-val'))          EL('fps-val').textContent         = (data.fps || 0) + ' FPS';

        updateBar('drowsiness-bar', data.drowsiness_score || 0);
        updateBar('attention-bar',  data.attention_score  || 0);
        updateBar('perclos-bar',    (data.perclos || 0) / 0.15);

        // Emotion indicator
        if (data.emotion && EL('emotion-val')) {
            EL('emotion-val').textContent = data.emotion;
            EL('emotion-val').style.color = data.emotion === 'neutral' ? '#44ff88'
                : data.emotion === 'distracted' ? '#ffaa00' : '#ff8844';
        }

        // Drowsiness alert + audio
        const alertEl = EL('drowsiness-alert');
        if (alertEl) {
            if (data.drowsiness_score > 0.7) {
                alertEl.textContent = '⚠ DROWSINESS DETECTED — PULL OVER SAFELY';
                alertEl.className   = 'alert-box alert-critical';
                alertEl.style.display = 'block';
                const now = Date.now();
                if (now - _lastDrowsyAlert > 8000) {
                    _lastDrowsyAlert = now;
                    if (window.playDrowsinessAlert) playDrowsinessAlert();
                }
            } else if (data.drowsiness_score > 0.4) {
                alertEl.textContent = '! Fatigue signs detected. Stay alert.';
                alertEl.className   = 'alert-box alert-warning';
                alertEl.style.display = 'block';
            } else {
                alertEl.style.display = 'none';
            }
        }

        // Vote consensus badge next to DROWSY metric
        const drowsyValEl = EL('drowsiness-val');
        if (drowsyValEl) {
            const existingBadge = drowsyValEl.parentElement?.querySelector('.vote-badge');
            if (existingBadge) existingBadge.remove();
            const level = bus.getState().alert_consensus_level || 'STANDARD';
            if (level === 'L2_CONSENSUS') {
                const badge = document.createElement('span');
                badge.className = 'vote-badge vote-l2';
                badge.textContent = '✓ ALL AGREE';
                drowsyValEl.insertAdjacentElement('afterend', badge);
            } else if (level === 'L1_DISAGREE') {
                const badge = document.createElement('span');
                badge.className = 'vote-badge vote-l1';
                badge.textContent = '△ SPLIT';
                drowsyValEl.insertAdjacentElement('afterend', badge);
            }
        }

        // Face detected indicator
        if (EL('face-status')) {
            EL('face-status').textContent  = data.face_detected ? '● FACE DETECTED' : '○ NO FACE';
            EL('face-status').style.color  = data.face_detected ? '#44ff88' : '#888';
        }
    });

    bus.subscribe('FATIGUE_FORECAST', (data) => {
        if (EL('forecast-val')) {
            const pct = ((data.fatigue_forecast || 0) * 100).toFixed(0);
            EL('forecast-val').textContent = pct + '% in T+15min';
            EL('forecast-val').style.color = colorForScore(data.fatigue_forecast || 0);
        }
        if (EL('confidence-val'))
            EL('confidence-val').textContent = fmt(data.forecast_confidence, 2);
        if (EL('rest-val'))
            EL('rest-val').textContent = data.enriched_system_prompt?.recommended_rest || '—';

        // Proactive alert + audio — only fire when driving AND voice agent is idle
        const pa   = data.proactive_alert;
        const paEl = EL('proactive-alert');
        const isDriving = window._game && !window._game.state.paused;
        if (paEl && pa?.msg) {
            // Shorten the displayed message so it doesn't take over the whole UI
            const shortMsg = pa.msg.length > 80 ? pa.msg.slice(0, 80) + '…' : pa.msg;
            paEl.textContent  = '🔮 ' + shortMsg;
            paEl.className    = `alert-box alert-${pa.urgency || 'advisory'}`;
            paEl.style.display = 'block';
            if (isDriving && pa.msg !== _lastProactiveMsg) {
                _lastProactiveMsg = pa.msg;
                if (window.playAlertBeep) playAlertBeep(pa.urgency || 'advisory');
                // Speak a short version only (first sentence), don't interrupt ongoing conversation
                if (window.speakResponse) {
                    const speakText = pa.msg.split(/[.!?]/)[0].trim().slice(0, 100);
                    speakResponse(speakText);
                }
            }
        } else if (paEl) {
            paEl.style.display = 'none';
        }
    });

    // Game alert handler — play sound only (no auto-TTS to avoid voice overlap).
    // Voice agent and proactive sync already speak; game alerts just beep.
    bus.subscribe('GAME_ALERT', (data) => {
        if (window.playAlertBeep) playAlertBeep(data.severity);
    });

    // Sync countdown
    bus.subscribe('SYNC_TICK', () => {
        const s = bus.getState();
        if (EL('sync-countdown')) {
            const remaining = Math.max(0, Math.round(s.next_sync_in_s || 0));
            const m   = Math.floor(remaining / 60);
            const sec = remaining % 60;
            EL('sync-countdown').textContent = `${m}:${String(sec).padStart(2, '0')}`;
        }
    });

    bus.subscribe('SAFETY_ALERT', (data) => {
        const el = EL('safety-banner');
        if (el) {
            el.textContent  = '🚨 ' + (data.msg || 'SAFETY ALERT — ALL AGENTS SUSPENDED');
            el.style.display = 'block';
            if (window.playAlertBeep) playAlertBeep('critical');
            setTimeout(() => { if (el) el.style.display = 'none'; }, 10000);
        }
    });

    // ZeroClaw state bus JSON display
    setInterval(() => {
        const el = EL('state-bus-json');
        if (el) {
            const s = bus.getState();
            el.textContent = JSON.stringify({
                attention_score:  s.attention_score?.toFixed(2),
                drowsiness_score: s.drowsiness_score?.toFixed(2),
                drowsiness_flag:  s.drowsiness_flag,
                fatigue_forecast: s.fatigue_forecast?.toFixed(2),
                npu_health:       s.npu_status,
                network_state:    s.network_state,
            }, null, 2);
        }
    }, 500);
}

window.initHUDRenderer = initHUDRenderer;
