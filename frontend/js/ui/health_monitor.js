/**
 * System Health Monitor — Tab 3.
 * Displays NPU health, 3-slot model standby, and adaptive offloading policy.
 */
function initHealthMonitor(bus) {
    const EL = id => document.getElementById(id);

    const OFFLOAD_STATES = {
        'Parked + WiFi':   { dms:'Local', rag:'Local+Cloud', voice:'Cloud', intel:'Full sync' },
        'Highway + 5G':    { dms:'Local', rag:'Local 90%', voice:'Local/Cloud', intel:'Proactive' },
        'City + 4G':       { dms:'Local', rag:'Local 90%', voice:'Local/Edge-Cloud', intel:'Sync' },
        'Emergency':       { dms:'Local', rag:'Local ONLY', voice:'Local ONLY', intel:'Suspended' },
        'Offline/Tunnel':  { dms:'Local', rag:'Local ONLY', voice:'Local ONLY', intel:'Queued' },
        'Low Battery <20%':{ dms:'Local', rag:'Local ONLY', voice:'Local ONLY', intel:'Suspended' },
    };

    const MODEL_SLOTS = [
        { name: 'QWEN 7B INT4 QNN',   status: 'active',  tok_s: '30-60', role: 'Primary' },
        { name: 'QWEN 6.5B INT8 QNN', status: 'standby', tok_s: '25-45', role: 'NPU degradation' },
        { name: 'QWEN 5B INT4 QNN',   status: 'fallback', tok_s: '20-35', role: 'Thermal throttle' },
    ];

    // Render model standby slots
    function renderModelSlots() {
        const el = EL('model-slots');
        if (!el) return;
        el.innerHTML = MODEL_SLOTS.map(m => `
            <div class="model-slot slot-${m.status}">
                <span class="slot-indicator">${m.status === 'active' ? '●' : m.status === 'standby' ? '◐' : '○'}</span>
                <strong>${m.name}</strong>
                <span class="slot-tps">${m.tok_s} tok/s</span>
                <span class="slot-role">${m.role}</span>
            </div>
        `).join('');
    }

    // Render offloading policy matrix
    function renderOffloadMatrix(activeRow = 'Highway + 5G') {
        const el = EL('offload-matrix');
        if (!el) return;
        let html = `<table class="offload-table">
            <thead><tr>
                <th>Network State</th><th>DMS Safety</th><th>RAG</th><th>Voice</th><th>Cloud Intel</th>
            </tr></thead><tbody>`;
        for (const [state, cols] of Object.entries(OFFLOAD_STATES)) {
            const active = state === activeRow ? ' class="active-row"' : '';
            html += `<tr${active}>
                <td>${state}</td>
                <td>${cols.dms}</td>
                <td>${cols.rag}</td>
                <td>${cols.voice}</td>
                <td>${cols.intel}</td>
            </tr>`;
        }
        html += '</tbody></table>';
        el.innerHTML = html;
    }

    // Render agent status cards (all 7 agents)
    function renderAgentCards() {
        const el = EL('agent-cards');
        if (!el) return;
        const state = bus.getState();
        const agents = [
            { id: 'A1', name: 'Perception',   tier:'Edge',  model:'MediaPipe FaceMesh 468-pt', hw:'Hexagon NPU', latency:'~15ms', status: state.face_detected !== false ? 'active' : 'waiting' },
            { id: 'A2', name: 'Gesture',      tier:'Edge',  model:'MediaPipe Hands 21-pt',     hw:'Hexagon NPU', latency:'<50ms', status:'active' },
            { id: 'A3', name: 'Speech/STT',   tier:'Edge',  model:'Whisper-Large-V3-Turbo',    hw:'Hexagon NPU', latency:'~300ms', status:'standby' },
            { id: 'A4', name: 'Fast LLM',     tier:'Edge',  model:'QWEN 7B INT4 QNN',          hw:'Hexagon NPU', latency:'<1s', status:'active' },
            { id: 'A5', name: 'Proactive Intel',tier:'Cloud', model:'Qwen3-VL-32B-Instruct',  hw:'AIC100 AI80', latency:'~500ms', status: state.last_sync_ts > 0 ? 'active' : 'waiting' },
            { id: 'A6', name: 'Complex+Coach',tier:'Cloud', model:'Qwen3-30B',                hw:'AIC100 AI80', latency:'~1.2s', status:'standby' },
            { id: 'A7', name: 'Local RAG',    tier:'Edge',  model:'all-MiniLM-L6-v2 + SQLite',hw:'Hexagon NPU', latency:'<100ms', status:'active' },
        ];
        el.innerHTML = agents.map(a => `
            <div class="agent-card tier-${a.tier.toLowerCase()}">
                <div class="agent-id">${a.id}</div>
                <div class="agent-name">${a.name}</div>
                <div class="agent-tier badge-${a.tier.toLowerCase()}">${a.tier}</div>
                <div class="agent-model">${a.model}</div>
                <div class="agent-hw">${a.hw}</div>
                <div class="agent-latency">${a.latency}</div>
                <div class="agent-status status-${a.status}">${a.status.toUpperCase()}</div>
            </div>
        `).join('');
    }

    // NPU health from Agent 5 hardware_health output
    bus.subscribe('FATIGUE_FORECAST', (data) => {
        const hw = data.hardware_health || {};
        const state = bus.getState();
        if (EL('npu-status'))   EL('npu-status').textContent   = hw.status || 'nominal';
        if (EL('npu-temp'))     EL('npu-temp').textContent     = (state.npu_temp_c || 45).toFixed(1) + '°C';
        if (EL('npu-ber'))      EL('npu-ber').textContent      = ((state.npu_ber || 0) * 100).toFixed(3) + '%';
        if (EL('npu-latdev'))   EL('npu-latdev').textContent   = '+' + (state.npu_latency_dev_ms || 0.0).toFixed(1) + 'ms';

        const statusEl = EL('npu-status');
        if (statusEl) {
            statusEl.style.color = hw.status === 'nominal' ? '#44ff88' :
                                   hw.status === 'degrading' ? '#ffaa00' : '#ff4444';
        }

        if (hw.model_swap_recommendation && EL('model-swap-rec')) {
            EL('model-swap-rec').textContent = 'Swap to: ' + hw.model_swap_recommendation;
            EL('model-swap-rec').style.display = 'block';
        }

        renderAgentCards();
    });

    // NPU predictive model output — streamed from backend every 1s via SSE
    bus.subscribe('NPU_PREDICTION', (pred) => {
        _renderNpuPrediction(pred);
    });

    function _renderNpuPrediction(pred) {
        if (!pred) return;

        const score = typeof pred.health_score === 'number' ? pred.health_score : null;
        if (score !== null) {
            const pct = Math.round(score * 100);
            if (EL('npu-health-score')) EL('npu-health-score').textContent = pct + '%';
            const bar = EL('npu-health-bar');
            if (bar) {
                bar.style.width = pct + '%';
                bar.style.background = score > 0.6 ? '#44ff88' : score > 0.3 ? '#ffaa00' : '#ff4444';
            }
        }

        const trend = pred.trend_direction || 'stable';
        const trendArrow = trend === 'improving' ? '▲ improving' :
                           trend === 'worsening' ? '▼ worsening' : '▶ stable';
        const trendColor = trend === 'improving' ? '#44ff88' :
                           trend === 'worsening' ? '#ff4444' : '#aaa';
        const trendEl = EL('npu-trend');
        if (trendEl) {
            trendEl.textContent = trendArrow;
            trendEl.style.color = trendColor;
        }

        const degEl = EL('npu-degradation');
        if (degEl) {
            const hours = pred.predicted_degradation_hours;
            degEl.textContent = (hours !== null && hours !== undefined)
                ? 'Predicted degradation: ' + hours.toFixed(1) + ' h'
                : 'Stable';
        }

        const swapEl = EL('model-swap-rec');
        if (swapEl) {
            const swap = pred.recommended_model_swap;
            if (swap) {
                swapEl.textContent = 'Swap: ' + swap;
                swapEl.style.display = 'block';
            } else {
                swapEl.style.display = 'none';
            }
        }
    }

    // MCP communication log
    bus.subscribe('SESSION_EVENT', (data) => {
        const el = EL('mcp-log');
        if (!el) return;
        const entry = document.createElement('div');
        entry.className = 'mcp-log-entry';
        const time = new Date().toLocaleTimeString();
        entry.textContent = `[${time}] ${data.type} ${data.latency_ms ? `→ ${data.latency_ms}ms` : ''} ${data.query || ''}`;
        el.prepend(entry);
        if (el.children.length > 50) el.lastChild.remove();
    });

    // FL Threshold Update widget (Track 16)
    bus.subscribe('FL_THRESHOLD_UPDATE', (data) => {
        const w = document.getElementById('fl-widget');
        if (!w) return;
        const ts = data.triggered_at ? new Date(data.triggered_at * 1000).toLocaleTimeString() : new Date().toLocaleTimeString();
        w.innerHTML = `
            <div class="fl-widget-inner">
                <div class="fl-title">Fleet Learning Update</div>
                <div class="fl-row"><span class="fl-lbl">Last update</span><span class="fl-val">${ts}</span></div>
                <div class="fl-row"><span class="fl-lbl">Reason</span><span class="fl-val fl-reason">${data.reason || '—'}</span></div>
                <div class="fl-row"><span class="fl-lbl">New threshold</span><span class="fl-val fl-threshold">${data.new_threshold !== undefined ? data.new_threshold.toFixed(2) : '—'}</span></div>
                <div class="fl-row"><span class="fl-lbl">Vehicles contributed</span><span class="fl-val">${data.vehicle_count || '—'}</span></div>
            </div>
        `;
        w.style.borderColor = '#44ff88';
    });

    // Initial render
    renderModelSlots();
    renderOffloadMatrix();
    renderAgentCards();

    // Update agent cards every 5 s
    setInterval(renderAgentCards, 5000);
}

window.initHealthMonitor = initHealthMonitor;
