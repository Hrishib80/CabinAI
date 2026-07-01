/**
 * Alert audio — plays synthesised beeps/chimes via Web Audio API.
 *
 * playAlertBeep(severity)  — 'critical' | 'warning' | 'advisory'
 * playDrowsinessAlert()    — urgent triple-beep pattern
 * playRestStopChime()      — gentle notification when approaching rest stop
 */

let _audioCtx = null;

function _getAudioCtx() {
    if (!_audioCtx) {
        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    // Resume if suspended (browsers require user gesture)
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    return _audioCtx;
}

function _beep(freq, duration, gain = 0.4, type = 'sine', delay = 0) {
    const ctx  = _getAudioCtx();
    const osc  = ctx.createOscillator();
    const vol  = ctx.createGain();

    osc.connect(vol);
    vol.connect(ctx.destination);

    osc.type      = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);

    vol.gain.setValueAtTime(0, ctx.currentTime + delay);
    vol.gain.linearRampToValueAtTime(gain, ctx.currentTime + delay + 0.02);
    vol.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + duration);

    osc.start(ctx.currentTime + delay);
    osc.stop(ctx.currentTime + delay + duration + 0.05);
}

function playAlertBeep(severity = 'advisory') {
    try {
        if (severity === 'critical') {
            // Three rapid descending beeps — urgent
            _beep(1000, 0.15, 0.6, 'square', 0.0);
            _beep(800,  0.15, 0.6, 'square', 0.2);
            _beep(600,  0.25, 0.7, 'square', 0.4);
        } else if (severity === 'warning') {
            // Two medium beeps
            _beep(800, 0.2, 0.45, 'sine', 0.0);
            _beep(700, 0.2, 0.45, 'sine', 0.3);
        } else {
            // Single soft chime
            _beep(660, 0.3, 0.3, 'sine', 0.0);
        }
    } catch (e) {
        console.warn('[AlertAudio] playAlertBeep error:', e);
    }
}

function playDrowsinessAlert() {
    try {
        // Urgent alternating high/low
        for (let i = 0; i < 4; i++) {
            _beep(1200, 0.12, 0.7, 'sawtooth', i * 0.18);
            _beep(600,  0.12, 0.7, 'sawtooth', i * 0.18 + 0.09);
        }
    } catch (e) {
        console.warn('[AlertAudio] drowsiness alert error:', e);
    }
}

function playRestStopChime() {
    try {
        // Gentle ascending chime
        [440, 554, 659, 880].forEach((f, i) => _beep(f, 0.3, 0.25, 'sine', i * 0.1));
    } catch (e) {
        console.warn('[AlertAudio] rest stop chime error:', e);
    }
}

function playMicStartSound() {
    try {
        _beep(880, 0.1, 0.2, 'sine', 0);
        _beep(1100, 0.1, 0.2, 'sine', 0.12);
    } catch (e) {}
}

function playMicStopSound() {
    try {
        _beep(1100, 0.08, 0.2, 'sine', 0);
        _beep(880,  0.1,  0.2, 'sine', 0.1);
    } catch (e) {}
}

window.playAlertBeep     = playAlertBeep;
window.playDrowsinessAlert = playDrowsinessAlert;
window.playRestStopChime = playRestStopChime;
window.playMicStartSound = playMicStartSound;
window.playMicStopSound  = playMicStopSound;
window._getAudioCtx      = _getAudioCtx;
