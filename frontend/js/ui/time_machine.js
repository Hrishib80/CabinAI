(function () {
  'use strict';

  const LOG_PATH = '../phase2/deliverables/demo_driving_log.json';
  const THRESHOLD_WITH    = 0.65;
  const THRESHOLD_WITHOUT = 0.80;
  const REPLAY_TICK_MS    = 30;   // ms between animation frames

  let _log     = null;
  let _timer   = null;
  let _cursor  = 0;

  // headline numbers (filled after log loads)
  let _alertWith    = null;   // t_s
  let _alertWithout = null;   // t_s

  function _fmtHHMM(t_s) {
    const h = Math.floor(t_s / 3600);
    const m = Math.floor((t_s % 3600) / 60);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }

  function _computeAlerts(samples) {
    let aw = null, awo = null;
    for (const s of samples) {
      if (aw  === null && s.drowsiness_composite >= THRESHOLD_WITH)    aw  = s.t_s;
      if (awo === null && s.drowsiness_composite >= THRESHOLD_WITHOUT)  awo = s.t_s;
      if (aw !== null && awo !== null) break;
    }
    return { aw, awo };
  }

  function _buildPanel(container) {
    container.innerHTML = `
      <div class="tm-header">
        <span class="tm-title">TIME MACHINE</span>
        <span class="tm-sub">counterfactual drowsiness detection</span>
      </div>
      <div class="tm-bars">
        <div class="tm-bar-col">
          <div class="tm-bar-label tm-label-without">Without CabinAI</div>
          <div class="tm-bar-label tm-sub-label">threshold = ${THRESHOLD_WITHOUT}</div>
          <div class="tm-metric" id="tm-time-without">—:—</div>
          <div class="tm-metric-sub" id="tm-drowsy-without">drowsiness at alert: —</div>
        </div>
        <div class="tm-bar-col">
          <div class="tm-bar-label tm-label-with">With CabinAI</div>
          <div class="tm-bar-label tm-sub-label">threshold = ${THRESHOLD_WITH}</div>
          <div class="tm-metric" id="tm-time-with">—:—</div>
          <div class="tm-metric-sub" id="tm-drowsy-with">drowsiness at alert: —</div>
        </div>
        <div class="tm-bar-col tm-col-lead">
          <div class="tm-bar-label" style="color:var(--green)">Lead Time</div>
          <div class="tm-bar-label tm-sub-label">&nbsp;</div>
          <div class="tm-metric tm-metric-green" id="tm-improvement">— min</div>
          <div class="tm-metric-sub">earlier warning</div>
        </div>
      </div>
      <div class="tm-chart-wrap">
        <svg id="tm-svg" class="tm-svg" viewBox="0 0 600 130" preserveAspectRatio="none"></svg>
      </div>
      <div class="tm-controls">
        <button class="btn tm-replay-btn" id="tm-replay-btn">&#9654; REPLAY</button>
        <span class="tm-status" id="tm-status">loading log…</span>
      </div>`;
  }

  function _headlineFromSamples(samples) {
    const { aw, awo } = _computeAlerts(samples);
    _alertWith    = aw;
    _alertWithout = awo;

    const withEl    = document.getElementById('tm-time-with');
    const withoutEl = document.getElementById('tm-time-without');
    const impEl     = document.getElementById('tm-improvement');
    const dWith     = document.getElementById('tm-drowsy-with');
    const dWithout  = document.getElementById('tm-drowsy-without');

    if (aw !== null) {
      withEl.textContent  = _fmtHHMM(aw);
      const s = samples.find(x => x.t_s === aw);
      if (s) dWith.textContent = `drowsiness at alert: ${s.drowsiness_composite.toFixed(3)}`;
    } else {
      withEl.textContent = 'no alert';
    }
    if (awo !== null) {
      withoutEl.textContent = _fmtHHMM(awo);
      const s = samples.find(x => x.t_s === awo);
      if (s) dWithout.textContent = `drowsiness at alert: ${s.drowsiness_composite.toFixed(3)}`;
    } else {
      withoutEl.textContent = 'no alert';
    }
    if (aw !== null && awo !== null) {
      const delta = Math.round((awo - aw) / 60);
      impEl.textContent = `${delta} min`;
    } else {
      impEl.textContent = '— min';
    }
  }

  function _drawChart(samples, upTo) {
    const svg = document.getElementById('tm-svg');
    if (!svg) return;

    const W = 600, H = 130, PAD_L = 40, PAD_R = 10, PAD_T = 8, PAD_B = 22;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;
    const maxT  = samples[samples.length - 1].t_s;

    function tx(t) { return PAD_L + (t / maxT) * plotW; }
    function ty(v) { return PAD_T + plotH - v * plotH; }

    const pts = samples.slice(0, upTo + 1);

    let path = '';
    for (let i = 0; i < pts.length; i++) {
      const x = tx(pts[i].t_s);
      const y = ty(pts[i].drowsiness_composite);
      path += (i === 0 ? `M${x},${y}` : ` L${x},${y}`);
    }

    // Grid lines
    let grid = '';
    for (let v = 0; v <= 1.0; v += 0.25) {
      const y = ty(v);
      grid += `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}"
                     stroke="#1e2535" stroke-width="0.5"/>`;
      grid += `<text x="${PAD_L - 4}" y="${y + 3}" fill="#556070" font-size="8"
                     text-anchor="end">${v.toFixed(2)}</text>`;
    }
    // Hour marks on x-axis
    for (let h = 0; h <= 8; h++) {
      const x = tx(h * 3600);
      grid += `<line x1="${x}" y1="${PAD_T}" x2="${x}" y2="${H - PAD_B}"
                     stroke="#1e2535" stroke-width="0.5"/>`;
      grid += `<text x="${x}" y="${H - 4}" fill="#556070" font-size="8"
                     text-anchor="middle">${h}h</text>`;
    }

    // Threshold lines
    const yWith    = ty(THRESHOLD_WITH);
    const yWithout = ty(THRESHOLD_WITHOUT);
    const dashWith    = `<line x1="${PAD_L}" y1="${yWith}" x2="${W - PAD_R}" y2="${yWith}"
                               stroke="#44ff88" stroke-width="1" stroke-dasharray="4,3" opacity="0.7"/>
                          <text x="${W - PAD_R - 2}" y="${yWith - 2}" fill="#44ff88" font-size="7" text-anchor="end">0.65 CabinAI</text>`;
    const dashWithout = `<line x1="${PAD_L}" y1="${yWithout}" x2="${W - PAD_R}" y2="${yWithout}"
                               stroke="#ffaa00" stroke-width="1" stroke-dasharray="4,3" opacity="0.7"/>
                          <text x="${W - PAD_R - 2}" y="${yWithout - 2}" fill="#ffaa00" font-size="7" text-anchor="end">0.80 legacy</text>`;

    // Alert markers
    let markers = '';
    const nowT = pts.length > 0 ? pts[pts.length - 1].t_s : 0;
    if (_alertWith !== null && _alertWith <= nowT) {
      const x = tx(_alertWith);
      markers += `<line x1="${x}" y1="${PAD_T}" x2="${x}" y2="${H - PAD_B}"
                        stroke="#44ff88" stroke-width="1.5"/>
                  <text x="${x + 2}" y="${PAD_T + 8}" fill="#44ff88" font-size="7">CabinAI fires</text>`;
    }
    if (_alertWithout !== null && _alertWithout <= nowT) {
      const x = tx(_alertWithout);
      markers += `<line x1="${x}" y1="${PAD_T}" x2="${x}" y2="${H - PAD_B}"
                        stroke="#ffaa00" stroke-width="1.5"/>
                  <text x="${x + 2}" y="${PAD_T + 16}" fill="#ffaa00" font-size="7">legacy fires</text>`;
    }

    svg.innerHTML = `${grid}${dashWith}${dashWithout}${markers}
      <path d="${path}" fill="none" stroke="#0af" stroke-width="1.5"/>`;
  }

  function _startReplay(samples) {
    if (_timer) { clearInterval(_timer); _timer = null; }
    _cursor = 0;
    const btn    = document.getElementById('tm-replay-btn');
    const status = document.getElementById('tm-status');
    if (btn) btn.disabled = true;

    _drawChart(samples, 0);

    _timer = setInterval(() => {
      _cursor += 4;    // advance 4 samples per tick (~2 min sim time per tick)
      if (_cursor >= samples.length) {
        _cursor = samples.length - 1;
        clearInterval(_timer);
        _timer = null;
        if (btn) btn.disabled = false;
        if (status) status.textContent = 'replay complete';
      }
      _drawChart(samples, _cursor);
      if (status) {
        const t = samples[_cursor].t_s;
        status.textContent = `t = ${_fmtHHMM(t)}`;
      }
    }, REPLAY_TICK_MS);
  }

  async function init() {
    const container = document.getElementById('time-machine-panel');
    if (!container) return;

    _buildPanel(container);

    const status = document.getElementById('tm-status');
    const btn    = document.getElementById('tm-replay-btn');

    try {
      const resp = await fetch(LOG_PATH);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      _log = data.samples;

      _headlineFromSamples(_log);
      _drawChart(_log, _log.length - 1);
      if (status) status.textContent = `${_log.length} samples loaded`;
      if (btn) btn.addEventListener('click', () => _startReplay(_log));

    } catch (e) {
      if (status) status.textContent = `error: ${e.message}`;
      if (btn) btn.disabled = true;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.TimeMachine = { init };
})();
