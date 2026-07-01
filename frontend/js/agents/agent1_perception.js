/**
 * Agent 1 — Perception / Driver Monitoring System.
 * Single Camera feeds frames to BOTH FaceMesh (Agent 1) AND Hands (Agent 2)
 * simultaneously via Promise.all — one camera, two models, same frame.
 *
 * Improvements from ai-hub-apps/mediapipe reference:
 *  - Combined camera loop avoids the race condition of two Camera() instances
 *  - FACEMESH_FACE_OVAL overlay added for richer visual
 *  - Gesture canvas drawn on same canvas as face (layered overlay)
 *  - Session buffer uses the key-landmark compression from the ai-hub-models spec
 */
class Agent1Perception {
    static LEFT_EYE  = [33, 160, 158, 133, 153, 144];
    static RIGHT_EYE = [263, 387, 385, 362, 380, 374];
    static KEY_LM    = [33, 133, 362, 263, 1, 61, 291, 70, 300, 107, 336, 10, 152, 234, 454];

    constructor(bus, videoEl, canvasEl) {
        this.bus    = bus;
        this.video  = videoEl;
        this.canvas = canvasEl;
        this.ctx    = canvasEl.getContext('2d');
        this.running = false;

        // Gesture agent hook — set by Agent2Gesture after init
        this._gestureHandler = null;

        // Rolling buffers
        this._earHistory    = new Float32Array(1800);  // 60s @ 30 FPS
        this._earIdx        = 0;
        this._blinkWindow   = [];
        this._inBlink       = false;
        this._blinkCount    = 0;
        this._headPoseDrift = 0;
        this._prevNose      = null;
        this._lastSampleTs  = 0;
        this._sessionBuffer = [];

        // FPS
        this._frameCount = 0;
        this._fpsTs      = performance.now();
        this._fps        = 0;
    }

    // ----------------------------------------------------------------
    async init() {
        // --- FaceMesh ---
        this.faceMesh = new FaceMesh({
            locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/${f}`
        });
        this.faceMesh.setOptions({
            maxNumFaces: 1,
            refineLandmarks: true,
            minDetectionConfidence: 0.5,
            minTrackingConfidence:  0.5,
        });
        this.faceMesh.onResults(r => this._onFaceResults(r));

        // --- Hands (init here, driven from same camera loop) ---
        this.hands = new Hands({
            locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${f}`
        });
        this.hands.setOptions({
            maxNumHands: 1,
            modelComplexity: 1,
            minDetectionConfidence: 0.5,
            minTrackingConfidence:  0.5,
        });
        this.hands.onResults(r => this._onHandResults(r));

        // --- Single shared camera — SEQUENTIAL, not parallel ---
        // MediaPipe JS WASM models share internal state and corrupt each
        // other when sent frames simultaneously via Promise.all.
        // Run faceMesh first, then hands, on every frame.
        this.camera = new Camera(this.video, {
            onFrame: async () => {
                if (!this.running) return;
                await this.faceMesh.send({ image: this.video });
                await this.hands.send({ image: this.video });
            },
            width: 640, height: 480,
        });
    }

    start() { this.running = true;  this.camera.start(); }
    stop()  { this.running = false; this.camera.stop(); }

    // Called by Agent2Gesture to register itself as the hand-results consumer
    setGestureHandler(fn) { this._gestureHandler = fn; }

    getSessionBuffer()  { return [...this._sessionBuffer]; }
    clearSessionBuffer() { this._sessionBuffer = []; }

    // ----------------------------------------------------------------
    _onFaceResults(results) {
        if (!this.running) return;

        // FPS
        this._frameCount++;
        const now = performance.now();
        if (now - this._fpsTs >= 1000) {
            this._fps        = this._frameCount;
            this._frameCount = 0;
            this._fpsTs      = now;
        }

        // Draw base video frame (canvas is shared with gesture overlay)
        this.canvas.width  = this.video.videoWidth  || 640;
        this.canvas.height = this.video.videoHeight || 480;
        this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);

        if (!results.multiFaceLandmarks?.length) {
            this.bus.publish('PERCEPTION_UPDATE', {
                face_detected: false, attention_score: 0.5, drowsiness_score: 0.0,
                ear: 0.3, perclos: 0.0, blink_freq: 15, head_pose_drift: 0, fps: this._fps,
            });
            return;
        }

        const lm = results.multiFaceLandmarks[0];

        // Draw face mesh overlays
        drawConnectors(this.ctx, lm, FACEMESH_TESSELATION,
            { color: '#00FF4120', lineWidth: 0.5 });
        drawConnectors(this.ctx, lm, FACEMESH_LEFT_EYE,  { color: '#30FF30', lineWidth: 2 });
        drawConnectors(this.ctx, lm, FACEMESH_RIGHT_EYE, { color: '#30FF30', lineWidth: 2 });
        drawConnectors(this.ctx, lm, FACEMESH_FACE_OVAL, { color: '#0088FF40', lineWidth: 1 });

        // EAR
        const earL = this._ear(lm, Agent1Perception.LEFT_EYE);
        const earR = this._ear(lm, Agent1Perception.RIGHT_EYE);
        const ear  = (earL + earR) / 2;

        // Blink detection
        const EAR_THRESH = 0.20;
        if (ear < EAR_THRESH && !this._inBlink) {
            this._inBlink = true;
        } else if (ear >= EAR_THRESH && this._inBlink) {
            this._inBlink = false;
            this._blinkCount++;
            this._blinkWindow.push(now);
        }
        this._blinkWindow = this._blinkWindow.filter(t => now - t < 30000);
        const blinkFreq = this._blinkWindow.length * 2;

        // PERCLOS
        this._earHistory[this._earIdx % 1800] = ear;
        this._earIdx++;
        const windowSize = Math.min(this._earIdx, 1800);
        let closed = 0;
        for (let i = 0; i < windowSize; i++) if (this._earHistory[i] < EAR_THRESH) closed++;
        const perclos = closed / windowSize;

        // Head pose drift
        const nose = lm[1];
        if (this._prevNose) {
            const dx = nose.x - this._prevNose.x;
            const dy = nose.y - this._prevNose.y;
            this._headPoseDrift = Math.sqrt(dx * dx + dy * dy);
        }
        this._prevNose = { x: nose.x, y: nose.y };

        // Drowsiness composite
        const earNorm   = Math.max(0, Math.min(1, 1 - ear / 0.35));
        const percNorm  = Math.min(1, perclos / 0.15);
        const blinkNorm = blinkFreq < 5 ? 1 : (blinkFreq > 20 ? 0 : 1 - (blinkFreq - 5) / 15);
        const drowsiness = 0.4 * earNorm + 0.4 * percNorm + 0.2 * blinkNorm;
        const attention  = Math.max(0, 1 - drowsiness * 1.2);

        const metrics = {
            face_detected:    true,
            ear:              parseFloat(ear.toFixed(4)),
            perclos:          parseFloat(perclos.toFixed(4)),
            blink_freq:       blinkFreq,
            head_pose_drift:  parseFloat(this._headPoseDrift.toFixed(4)),
            drowsiness_score: parseFloat(drowsiness.toFixed(4)),
            attention_score:  parseFloat(attention.toFixed(4)),
            fps:              this._fps,
            ...this._detectEmotion(lm),
        };

        this.bus.publish('PERCEPTION_UPDATE', metrics);

        // 1-FPS session buffer
        const nowSec = now / 1000;
        if (nowSec - this._lastSampleTs >= 1.0) {
            this._lastSampleTs = nowSec;
            const compressed = Agent1Perception.KEY_LM.flatMap(idx => {
                const p = lm[idx] || { x: 0, y: 0, z: 0 };
                return [
                    Math.max(-127, Math.min(127, Math.round(p.x * 127))),
                    Math.max(-127, Math.min(127, Math.round(p.y * 127))),
                    Math.max(-127, Math.min(127, Math.round((p.z || 0) * 127))),
                ];
            });
            this._sessionBuffer.push({
                kp: compressed, ear: metrics.ear, perc: metrics.perclos,
                blink: blinkFreq, hpd: metrics.head_pose_drift, ds: metrics.drowsiness_score,
            });
            if (this._sessionBuffer.length > 300) this._sessionBuffer.shift();

            fetch('http://localhost:5000/api/buffer/frame', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this._sessionBuffer.at(-1)),
            }).catch(() => {});
        }
    }

    // ----------------------------------------------------------------
    _onHandResults(results) {
        // Dispatch to Agent2Gesture if registered; it draws on the same canvas
        if (this._gestureHandler) {
            this._gestureHandler(results, this.canvas, this.ctx);
        }
    }

    // ----------------------------------------------------------------
    // Emotion / distraction detection using FaceMesh landmark geometry.
    // Detects: neutral, surprised, frustrated, distracted, mouth_open
    // ----------------------------------------------------------------
    _detectEmotion(lm) {
        const d = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);

        // Eyebrow raise (surprise): inner brow lm70/300 vs outer brow 107/336
        const leftBrowRaise  = lm[70].y  - lm[107].y;
        const rightBrowRaise = lm[300].y - lm[336].y;
        const browsRaised    = (leftBrowRaise + rightBrowRaise) / 2 < -0.015;

        // Brow furrow (frustration): distance between inner brows 70 ↔ 300
        const browFurrow = d(70, 300) < 0.06;

        // Mouth open: lm13 (upper lip) ↔ lm14 (lower lip)
        const mouthOpen = d(13, 14) > 0.04;

        // Head yaw (distraction): nose tip lm1 x vs midpoint of lm10↔152 line
        const midX = (lm[10].x + lm[152].x) / 2;
        const yaw  = Math.abs(lm[1].x - midX);
        const distracted = yaw > 0.06;

        let emotion = 'neutral';
        let confidence = 0.7;

        if (distracted) {
            emotion = 'distracted'; confidence = Math.min(0.95, yaw * 10);
        } else if (browsRaised && mouthOpen) {
            emotion = 'surprised';  confidence = 0.8;
        } else if (browFurrow) {
            emotion = 'frustrated'; confidence = 0.7;
        } else if (mouthOpen) {
            emotion = 'yawning';    confidence = 0.75;
        }

        return { emotion, emotion_confidence: parseFloat(confidence.toFixed(2)) };
    }

    _ear(lm, idx) {
        const p = i => ({ x: lm[idx[i]].x, y: lm[idx[i]].y });
        const d = (a, b) => Math.hypot(p(a).x - p(b).x, p(a).y - p(b).y);
        return (d(1, 5) + d(2, 4)) / (2 * d(0, 3));
    }

    // Return latest frame as base64 JPEG for VLM (Agent 5)
    getLatestJpeg(quality = 0.6) {
        const tmp = document.createElement('canvas');
        tmp.width  = 320;
        tmp.height = 240;
        const tc = tmp.getContext('2d');
        tc.drawImage(this.canvas, 0, 0, tmp.width, tmp.height);
        return tmp.toDataURL('image/jpeg', quality).split(',')[1];
    }
}

window.Agent1Perception = Agent1Perception;
