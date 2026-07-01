/**
 * Agent 2 — Gesture Control.
 *
 * Gesture labels match the official Qualcomm AI Hub MediaPipeHandGesture model:
 * ["None","Closed_Fist","Open_Palm","Pointing_Up","Thumb_Down","Thumb_Up","Victory","ILoveYou"]
 *
 * Does NOT own a camera. Receives hand results from Agent1 via onHandResults().
 * Draws on Agent1's shared canvas (face mesh already rendered).
 */
const GESTURE_LABELS_AIHUB = [
    'None', 'Closed_Fist', 'Open_Palm', 'Pointing_Up',
    'Thumb_Down', 'Thumb_Up', 'Victory', 'ILoveYou',
];

const GESTURE_TO_ACTION = {
    'Closed_Fist':  { action: 'MUTE_AUDIO',    label: 'Muted' },
    'Open_Palm':    { action: 'DISMISS_ALERT',  label: 'Alert dismissed' },
    'Pointing_Up':  { action: 'NAV_SELECT',     label: 'Nav selected' },
    'Thumb_Down':   { action: 'REJECT',         label: 'Rejected' },
    'Thumb_Up':     { action: 'CONFIRM',        label: 'Confirmed' },
    'Victory':      { action: 'CALL_ACCEPT',    label: 'Call accepted' },
    'ILoveYou':     { action: 'CALL_DECLINE',   label: 'Call declined' },
};

// Keep these on window for legacy references
const GESTURE_MAP    = Object.fromEntries(Object.entries(GESTURE_TO_ACTION).map(([k,v]) => [k, v.action]));
const GESTURE_LABELS = Object.fromEntries(Object.entries(GESTURE_TO_ACTION).map(([k,v]) => [v.action, v.label]));

class Agent2Gesture {
    constructor(bus) {
        this.bus          = bus;
        this.running      = false;
        this._history     = [];
        this._lastGesture = '';
        this._lastTs      = 0;
        this._debounceMs  = 900;
    }

    async init() {}   // no own camera
    start()  { this.running = true; }
    stop()   { this.running = false; }
    getHistory() { return [...this._history]; }

    /**
     * Called by Agent1._onHandResults() on every frame.
     * results : MediaPipe Hands results object
     * canvas  : the shared canvas (face mesh already drawn on it)
     * ctx     : 2D context
     */
    onHandResults(results, canvas, ctx) {
        if (!this.running) return;

        if (!results.multiHandLandmarks?.length) {
            // Clear any stale gesture label
            return;
        }

        const lm = results.multiHandLandmarks[0];
        const W  = canvas.width;
        const H  = canvas.height;

        // Draw hand skeleton — guard all MediaPipe drawing calls
        try {
            if (typeof HAND_CONNECTIONS !== 'undefined' && typeof drawConnectors === 'function') {
                drawConnectors(ctx, lm, HAND_CONNECTIONS, { color: '#00FF88', lineWidth: 3 });
                drawLandmarks(ctx, lm, { color: '#FF3344', lineWidth: 1, radius: 3 });
            } else {
                // Manual fallback skeleton
                const conns = [
                    [0,1],[1,2],[2,3],[3,4],
                    [0,5],[5,6],[6,7],[7,8],
                    [5,9],[9,10],[10,11],[11,12],
                    [9,13],[13,14],[14,15],[15,16],
                    [13,17],[17,18],[18,19],[19,20],[0,17],
                ];
                ctx.save();
                ctx.strokeStyle = '#00FF88';
                ctx.lineWidth = 2;
                for (const [a, b] of conns) {
                    ctx.beginPath();
                    ctx.moveTo(lm[a].x * W, lm[a].y * H);
                    ctx.lineTo(lm[b].x * W, lm[b].y * H);
                    ctx.stroke();
                }
                // Dots
                ctx.fillStyle = '#FF3344';
                for (const p of lm) {
                    ctx.beginPath();
                    ctx.arc(p.x * W, p.y * H, 3, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }
        } catch (e) {
            // Drawing failed — still classify and show label
        }

        const gesture = this._classify(lm);

        // Always draw gesture label on canvas — centred at the bottom so it never clips
        if (gesture && gesture !== 'None') {
            ctx.save();
            const label = '✋ ' + gesture;
            ctx.font = 'bold 16px monospace';
            const tw = Math.ceil(ctx.measureText(label).width);
            const boxW = Math.max(220, tw + 28);
            const boxH = 38;
            const boxX = Math.max(10, (W - boxW) / 2);   // centred, never < 10 from edge
            const boxY = H - boxH - 10;
            ctx.fillStyle = 'rgba(0,0,0,0.78)';
            ctx.strokeStyle = '#00FF88';
            ctx.lineWidth = 1.5;
            if (typeof ctx.roundRect === 'function') {
                ctx.beginPath();
                ctx.roundRect(boxX, boxY, boxW, boxH, 6);
                ctx.fill();
                ctx.stroke();
            } else {
                ctx.fillRect(boxX, boxY, boxW, boxH);
                ctx.strokeRect(boxX, boxY, boxW, boxH);
            }
            ctx.fillStyle = '#00FF88';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, boxX + boxW / 2, boxY + boxH / 2);
            ctx.restore();
        }

        if (!gesture || gesture === 'None') return;

        const now = Date.now();
        if (gesture === this._lastGesture && now - this._lastTs < this._debounceMs) return;
        this._lastGesture = gesture;
        this._lastTs      = now;

        const mapping = GESTURE_TO_ACTION[gesture];
        if (!mapping) return;

        this._history.unshift({ gesture, action: mapping.action, ts: now });
        if (this._history.length > 10) this._history.pop();

        // Always emit GESTURE_DETECTED so the HUD can show it
        this.bus.publish('GESTURE_DETECTED', { gesture, action: mapping.action });

        // Only emit GESTURE_ACTION (which triggers vehicle commands) when driver is attentive
        if (this.bus.getState().attention_score < 0.4) {
            console.log('[Agent2] gesture action gated — low attention score');
            return;
        }

        this.bus.publish('GESTURE_ACTION', {
            gesture,
            action: mapping.action,
            label: mapping.label,
        });
    }

    // ----------------------------------------------------------------
    // Classifier — matches AI Hub MediaPipeHandGesture gesture set.
    // Uses normalised landmark coordinates (0-1), y-axis points DOWN.
    // Landmark indices: https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker
    //   0=WRIST  1=CMC  2=MCP  3=PIP  4=TIP  (thumb)
    //   5=MCP  6=PIP  7=DIP  8=TIP           (index)
    //   9=MCP 10=PIP 11=DIP 12=TIP           (middle)
    //  13=MCP 14=PIP 15=DIP 16=TIP           (ring)
    //  17=MCP 18=PIP 19=DIP 20=TIP           (pinky)
    // ----------------------------------------------------------------
    _classify(lm) {
        const tip  = [4, 8, 12, 16, 20];   // fingertip indices
        const pip  = [3, 6, 10, 14, 18];   // PIP joint indices (below tip)
        const mcp  = [2, 5,  9, 13, 17];   // MCP joint indices (knuckles)

        const dist = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);

        // Finger extended: tip is farther from wrist than MCP
        // More reliable than Y comparison (works for horizontal hands too)
        const wrist = 0;
        const extended = tip.map((tipIdx, i) =>
            dist(tipIdx, wrist) > dist(mcp[i], wrist) * 1.2
        );
        const extCount = extended.filter(Boolean).length;

        // --- Open Palm: all 5 fingers extended ---
        if (extCount >= 4) return 'Open_Palm';

        // --- Closed Fist: no fingers extended ---
        if (extCount === 0) return 'Closed_Fist';

        // --- Thumb Up: only thumb extended, thumb tip above wrist (y < wrist.y) ---
        // extended[0]=thumb, thumb tip (4) must be above/below wrist (lower y = higher on screen)
        if (extended[0] && !extended[1] && !extended[2] && !extended[3] && !extended[4]) {
            if (lm[4].y < lm[0].y - 0.05) return 'Thumb_Up';
            if (lm[4].y > lm[0].y + 0.05) return 'Thumb_Down';
        }

        // --- Pointing Up: only index extended ---
        if (!extended[0] && extended[1] && !extended[2] && !extended[3] && !extended[4]) {
            return 'Pointing_Up';
        }

        // --- Victory: index + middle extended, others closed ---
        if (!extended[0] && extended[1] && extended[2] && !extended[3] && !extended[4]) {
            return 'Victory';
        }

        // --- ILoveYou: thumb + index + pinky extended ---
        if (extended[0] && extended[1] && !extended[2] && !extended[3] && extended[4]) {
            return 'ILoveYou';
        }

        return 'None';
    }
}

window.Agent2Gesture   = Agent2Gesture;
window.GESTURE_MAP     = GESTURE_MAP;
window.GESTURE_LABELS  = GESTURE_LABELS;
