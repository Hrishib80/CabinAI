/**
 * CabinAI — Hyderabad/Gachibowli Driving Simulator
 *
 * First-person driving with real Hyderabad route layout.
 * Arrow key controls (↑ accel · ↓ brake · ← → steer).
 * Embedded dashboard at bottom of game canvas.
 * Locations: parking, urban, highway, tunnel, emergency, gas, rest.
 * Sim ↔ App linkage: engine overheat / low fuel / RPM trigger bus events.
 */

const HYDERABAD_ROUTE = [
    { name: 'Gachibowli Stadium',         type: 'parking',   speed: 30,  color: '#2ecc71' },
    { name: 'Gachibowli Main Road',       type: 'urban',     speed: 60,  color: '#e67e22' },
    { name: 'Mindspace Junction',         type: 'urban',     speed: 50,  color: '#e67e22' },
    { name: 'DLF Cyber City',             type: 'urban',     speed: 50,  color: '#e67e22' },
    { name: 'DLF Fuel Station',           type: 'gas',       speed: 25,  color: '#f39c12' },
    { name: 'Financial District',         type: 'urban',     speed: 50,  color: '#e67e22' },
    { name: 'Durgam Cheruvu Tunnel',      type: 'tunnel',    speed: 50,  color: '#9b59b6' },
    { name: 'Nanakramguda Junction',      type: 'highway',   speed: 80,  color: '#3498db' },
    { name: 'Biodiversity Junction',      type: 'rest',      speed: 30,  color: '#27ae60' },
    { name: 'IKEA Hyderabad, Nallagandla',type: 'parking',   speed: 25,  color: '#2ecc71' },
    { name: 'Nallagandla Township',       type: 'urban',     speed: 50,  color: '#e67e22' },
    { name: 'Hi-Tech City',               type: 'urban',     speed: 50,  color: '#e67e22' },
    { name: 'Madhapur Flyover',           type: 'highway',   speed: 80,  color: '#3498db' },
    { name: 'ORR Toll Plaza',             type: 'highway',   speed: 100, color: '#2980b9' },
    { name: 'ORR Emergency Bay',          type: 'emergency', speed: 30,  color: '#e74c3c' },
    { name: 'ORR Highway',                type: 'highway',   speed: 120, color: '#2980b9' },
    { name: 'Shamshabad Airport',         type: 'parking',   speed: 30,  color: '#2ecc71' },
];

const SEG_LENGTH_M = 400;

class DrivingGame {
    constructor(canvas, bus) {
        this.canvas = canvas;
        this.ctx    = canvas.getContext('2d');
        this.bus    = bus;
        this.running = false;
        this._raf   = null;
        this._keys  = {};

        this.state = {
            speed: 0, targetSpeed: 0, rpm: 800,
            fuel: 1.0, engineTemp: 0.35, oilPressure: 1.0, battery: 1.0,
            gear: 1, distance: 0,
            laneOffset: 0, worldPos: 0, routeIdx: 0, curvature: 0,
            time: 14.0, weather: 'clear',
            npcs: this._spawnNpcs(),
            activeAlert: null, alertTimeout: 0,
            lastFuelAlert: 0, lastTempAlert: 0, lastOilAlert: 0,
            lastBattAlert: 0, lastSpeedingAlert: 0, lastTunnelAlert: 0,
            highSpeedSeconds: 0,
            recommendedRest: '',
            paused: true,
        };
        this._lastTs = 0;
        this._lastPublish = 0;
        this._setupInput();
        this._subscribeToAlerts();
    }

    _spawnNpcs() {
        const colors = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#ecf0f1'];
        return Array.from({ length: 14 }, (_, i) => ({
            pos: 200 + i * 280,
            lane: ((i * 7) % 3) - 1,
            speed: 40 + Math.random() * 60,
            color: colors[i % colors.length],
            type: i % 5 === 0 ? 'truck' : (i % 7 === 0 ? 'auto' : 'car'),
        }));
    }

    _setupInput() {
        window.addEventListener('keydown', e => {
            // Only fire when Cockpit (tab1) is active and the user isn't typing in an input
            const tab1 = document.getElementById('tab1');
            if (!tab1 || !tab1.classList.contains('active')) return;
            const tag = (e.target?.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
            this._keys[e.code] = true;
            if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) {
                e.preventDefault();
            }
        });
        window.addEventListener('keyup', e => { this._keys[e.code] = false; });
    }

    _subscribeToAlerts() {
        this.bus.subscribe('FATIGUE_FORECAST', d => {
            const r = d.enriched_system_prompt?.recommended_rest;
            if (r) this.state.recommendedRest = r;
        });
        this.bus.subscribe('PERCEPTION_UPDATE', d => {
            if (d.drowsiness_score > 0.7 && !this.state.paused)
                this._alert('DROWSY', 'Drowsiness detected — pull over at next rest area!', 'critical');
        });
    }

    _alert(type, msg, sev) {
        this.state.activeAlert  = { type, msg, sev };
        this.state.alertTimeout = 6;
        this.bus.publish('GAME_ALERT', { type, msg, severity: sev });
        if (window.playAlertBeep) playAlertBeep(sev);
    }

    _publishLiveState() {
        const s = this.state;
        const seg = HYDERABAD_ROUTE[s.routeIdx % HYDERABAD_ROUTE.length];
        this.bus.publish('GAME_STATE', {
            game_speed: s.speed, game_rpm: s.rpm,
            game_location: seg.name, game_segment_type: seg.type,
            game_engine_temp: s.engineTemp, game_fuel: s.fuel,
            game_oil_pressure: s.oilPressure, game_battery: s.battery,
            game_distance_km: s.distance, game_paused: s.paused,
        });
    }

    _update(dt) {
        if (this.state.paused) return;
        const s = this.state;
        const seg = HYDERABAD_ROUTE[s.routeIdx % HYDERABAD_ROUTE.length];

        const accelKey = this._keys['ArrowUp']    || this._keys['KeyW'];
        const brakeKey = this._keys['ArrowDown']  || this._keys['KeyS'];
        const leftKey  = this._keys['ArrowLeft']  || this._keys['KeyA'];
        const rightKey = this._keys['ArrowRight'] || this._keys['KeyD'];

        const speedLimit = seg.speed;
        const maxSpeed = Math.max(speedLimit + 30, 200);

        if (accelKey) s.targetSpeed = Math.min(maxSpeed, s.targetSpeed + 50 * dt);
        else if (!brakeKey) s.targetSpeed = Math.max(0, s.targetSpeed - 12 * dt);
        if (brakeKey) s.targetSpeed = Math.max(0, s.targetSpeed - 100 * dt);

        const acc = s.targetSpeed > s.speed ? 14 : -22;
        s.speed = Math.max(0, Math.min(maxSpeed, s.speed + acc * dt));

        // Steering — much more responsive (was 1.5/dt with strong auto-centre).
        // We now apply 3.5/dt input rate and only mild auto-centring so the player
        // visibly drifts left/right.  laneOffset is clamped to ±1 (full lane).
        const steerRate = 3.8;
        if (leftKey)  s.laneOffset -= steerRate * dt;
        if (rightKey) s.laneOffset += steerRate * dt;
        s.laneOffset = Math.max(-1.2, Math.min(1.2, s.laneOffset));
        if (!leftKey && !rightKey) {
            s.laneOffset *= (1 - Math.min(0.5, dt * 0.9));
            if (Math.abs(s.laneOffset) < 0.005) s.laneOffset = 0;
        }

        const gr = [0, 3.2, 2.1, 1.5, 1.1, 0.85, 0.7][Math.min(6, s.gear)];
        s.rpm = Math.max(800, Math.min(7000, s.speed * gr * 35 + 800));
        if (s.rpm > 5500 && s.gear < 6) s.gear++;
        if (s.rpm < 1800 && s.gear > 1) s.gear--;

        // Sim-app link: engine wear from sustained high speed
        if (s.speed > 100) s.highSpeedSeconds += dt;
        else s.highSpeedSeconds = Math.max(0, s.highSpeedSeconds - dt * 0.5);

        const rpmHeat = (s.rpm / 7000) * 0.022;
        const sustainHeat = Math.min(0.04, s.highSpeedSeconds * 0.0008);
        const ambientCool = 0.008;
        s.engineTemp = Math.max(0.30, Math.min(1.0,
            s.engineTemp + (rpmHeat + sustainHeat - ambientCool) * dt));

        s.fuel = Math.max(0, s.fuel - (0.0001 + (s.speed / 200) * 0.0008) * dt);

        if (s.engineTemp > 0.85) s.oilPressure = Math.max(0.2, s.oilPressure - 0.005 * dt);
        s.battery = Math.max(0.4, s.battery - 0.0001 * dt);

        s.worldPos += (s.speed / 3.6) * dt;
        s.distance = s.worldPos / 1000;
        s.routeIdx = Math.floor(s.worldPos / SEG_LENGTH_M) % HYDERABAD_ROUTE.length;
        s.curvature = Math.sin(s.worldPos / 800) * 0.045;
        s.time = (s.time + dt / 180) % 24;

        for (const npc of s.npcs) npc.pos += (npc.speed / 3.6) * dt;

        if (s.alertTimeout > 0) s.alertTimeout -= dt; else s.activeAlert = null;
        const now = Date.now();

        if (s.fuel < 0.15 && now - s.lastFuelAlert > 30000) {
            s.lastFuelAlert = now;
            this._alert('FUEL', 'Low fuel! Nearest: DLF Cyber City fuel station, 0.5km.', 'warning');
        }
        if (s.engineTemp > 0.85 && now - s.lastTempAlert > 18000) {
            s.lastTempAlert = now;
            this._alert('TEMP', 'Engine overheating! Slow down, head to Biodiversity Junction.', 'critical');
        }
        if (s.oilPressure < 0.4 && now - s.lastOilAlert > 25000) {
            s.lastOilAlert = now;
            this._alert('OIL', 'Low oil pressure — stop at ORR Emergency Bay!', 'critical');
        }
        if (s.battery < 0.5 && now - s.lastBattAlert > 25000) {
            s.lastBattAlert = now;
            this._alert('BATT', 'Battery weak — drive to TATA service in Hi-Tech City.', 'warning');
        }
        if (s.speed > seg.speed + 15 && now - s.lastSpeedingAlert > 12000) {
            s.lastSpeedingAlert = now;
            this._alert('SPEED', `Speeding in ${seg.name}! Limit ${seg.speed} km/h.`, 'warning');
        }
        if (seg.type === 'tunnel' && now - s.lastTunnelAlert > 15000) {
            s.lastTunnelAlert = now;
            this._alert('TUNNEL', 'Entering Durgam Cheruvu tunnel — headlights ON.', 'advisory');
        }

        if (now - this._lastPublish > 500) {
            this._lastPublish = now;
            this._publishLiveState();
        }
    }

    // ── RENDERING ──────────────────────────────────────────────────────────
    _render() {
        const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
        const s = this.state;
        const seg = HYDERABAD_ROUTE[s.routeIdx % HYDERABAD_ROUTE.length];

        const DASH_H = Math.min(108, Math.max(85, H * 0.16));
        const gameH = H - DASH_H;
        c.clearRect(0, 0, W, H);

        const inTunnel = seg.type === 'tunnel';
        const HORIZON = Math.floor(gameH * 0.42);

        if (inTunnel) this._renderTunnel(c, W, gameH, HORIZON, s, seg);
        else          this._renderOpenRoad(c, W, gameH, HORIZON, s, seg);

        this._drawBonnet(c, W, gameH, s, seg);

        if (!inTunnel && s.weather !== 'clear') this._drawWeather(c, W, gameH, s);

        if (!inTunnel && (s.time < 6 || s.time > 20)) {
            c.fillStyle = 'rgba(0,0,0,0.42)'; c.fillRect(0, 0, W, gameH);
            // Headlight beams illuminating the road
            const beamGrad = c.createRadialGradient(W/2, gameH, 20, W/2, gameH * 0.5, gameH * 0.55);
            beamGrad.addColorStop(0, 'rgba(255,240,180,0.12)');
            beamGrad.addColorStop(0.5, 'rgba(255,240,180,0.06)');
            beamGrad.addColorStop(1, 'rgba(255,240,180,0)');
            c.fillStyle = beamGrad; c.fillRect(0, 0, W, gameH);
        }

        this._drawHUD(c, W, gameH, s, seg);
        this._drawMinimap(c, W, gameH, s);
        this._drawEmbeddedDashboard(c, 0, gameH, W, DASH_H, s, seg);

        if (s.paused) {
            c.fillStyle = 'rgba(0,0,0,0.65)'; c.fillRect(0, 0, W, gameH);
            c.fillStyle = '#0af'; c.font = 'bold 24px monospace'; c.textAlign = 'center';
            c.fillText('GACHIBOWLI · HYDERABAD DRIVE SIM', W/2, gameH/2 - 28);
            c.fillStyle = '#44ff88'; c.font = '14px monospace';
            c.fillText('▶ Press START or ↑ to begin driving', W/2, gameH/2 + 4);
            c.fillStyle = '#aab2c2'; c.font = '12px monospace';
            c.fillText('↑ Accelerate · ↓ Brake · ← → Steer', W/2, gameH/2 + 26);
            c.fillStyle = '#778899'; c.font = '11px monospace';
            c.fillText('Locations: Parking · Urban · Highway · Tunnel · Emergency', W/2, gameH/2 + 48);
        }
    }

    _renderOpenRoad(c, W, H, HORIZON, s, seg) {
        const hour = s.time;
        let skyA, skyB;
        if      (hour >= 6  && hour < 9)  { skyA = '#ff9a56'; skyB = '#ffd89b'; }
        else if (hour >= 9  && hour < 18) { skyA = '#1565c0'; skyB = '#64b5f6'; }
        else if (hour >= 18 && hour < 21) { skyA = '#4a1a6b'; skyB = '#ff7043'; }
        else                              { skyA = '#0d0d2b'; skyB = '#1a237e'; }
        const sky = c.createLinearGradient(0, 0, 0, HORIZON);
        sky.addColorStop(0, skyA); sky.addColorStop(1, skyB);
        c.fillStyle = sky; c.fillRect(0, 0, W, HORIZON);

        this._drawSkyBody(c, W, HORIZON, hour);
        this._drawClouds(c, W, HORIZON, hour, s.worldPos);
        this._drawCityscape(c, W, HORIZON, hour, seg);
        this._drawDistantHills(c, W, HORIZON);

        // Atmospheric haze near horizon
        const hazeAlpha = hour >= 6 && hour < 20 ? 0.18 : 0.08;
        const haze = c.createLinearGradient(0, HORIZON - 40, 0, HORIZON + 30);
        haze.addColorStop(0, `rgba(180,200,220,0)`);
        haze.addColorStop(0.5, `rgba(180,200,220,${hazeAlpha})`);
        haze.addColorStop(1, `rgba(180,200,220,0)`);
        c.fillStyle = haze; c.fillRect(0, HORIZON - 40, W, 70);

        const t = seg.type;
        const gColor = (t === 'highway')   ? '#3a4350' :
                       (t === 'urban')     ? '#5a6470' :
                       (t === 'parking')   ? '#5d6a4f' :
                       (t === 'gas')       ? '#6a5a4a' :
                       (t === 'rest')      ? '#3d5a3d' :
                       (t === 'emergency') ? '#5e3a3a' : '#4a5560';
        const g = c.createLinearGradient(0, HORIZON, 0, H);
        g.addColorStop(0, gColor);
        g.addColorStop(1, hour >= 6 && hour < 20 ? '#2a3540' : '#0c1218');
        c.fillStyle = g; c.fillRect(0, HORIZON, W, H - HORIZON);

        this._drawRoad(c, W, H, HORIZON, s);
        this._drawTarmacStripes(c, W, H, HORIZON, s);
        this._drawMarkings(c, W, H, HORIZON, s);
        this._drawRoadside(c, W, H, HORIZON, s, seg);
        this._drawBillboards(c, W, H, HORIZON, s, seg);
        this._drawNpcs(c, W, H, HORIZON, s);
    }

    _renderTunnel(c, W, H, HORIZON, s, seg) {
        c.fillStyle = '#0a0d12'; c.fillRect(0, 0, W, H);

        const curve = s.curvature + s.laneOffset * 0.08;
        const vx = W/2 + curve * W * 0.6;

        // Ceiling — slightly lighter so walls are visible
        c.fillStyle = '#252d3a';
        c.beginPath();
        c.moveTo(0, 0); c.lineTo(W, 0); c.lineTo(W, HORIZON * 0.2);
        c.lineTo(vx, HORIZON); c.lineTo(0, HORIZON * 0.2); c.closePath(); c.fill();

        // Floor
        c.fillStyle = '#0e1218';
        c.beginPath();
        c.moveTo(0, H); c.lineTo(W, H); c.lineTo(W, H * 0.85);
        c.lineTo(vx, HORIZON); c.lineTo(0, H * 0.85); c.closePath(); c.fill();

        // Side walls — brighter with gradient for depth
        c.fillStyle = 'rgba(80,90,110,0.7)';
        c.beginPath();
        c.moveTo(0, HORIZON*0.2); c.lineTo(vx - W*0.06, HORIZON);
        c.lineTo(W*0.05, H*0.85); c.lineTo(0, H*0.85); c.closePath(); c.fill();
        c.beginPath();
        c.moveTo(W, HORIZON*0.2); c.lineTo(vx + W*0.06, HORIZON);
        c.lineTo(W*0.95, H*0.85); c.lineTo(W, H*0.85); c.closePath(); c.fill();
        // Wall tile lines for depth perception
        c.strokeStyle = 'rgba(100,115,140,0.3)'; c.lineWidth = 1;
        for (let i = 0; i < 8; i++) {
            const yy = HORIZON * 0.2 + (H * 0.65) * (i / 8);
            c.beginPath(); c.moveTo(0, yy); c.lineTo(W * 0.05, yy); c.stroke();
            c.beginPath(); c.moveTo(W, yy); c.lineTo(W * 0.95, yy); c.stroke();
        }

        // Ceiling lights flowing past
        for (let i = 0; i < 14; i++) {
            const offset = ((s.worldPos * 0.6 + i * 80) % 80) / 80;
            const yPos = HORIZON * (0.18 + 0.55 * offset);
            const w = 6 + 100 * offset;
            const a = 0.65 - 0.5 * offset;
            c.fillStyle = `rgba(255,235,180,${a})`;
            c.fillRect(W/2 - w/2, yPos - 3, w, 4);
        }

        this._drawRoad(c, W, H, HORIZON, s, '#1d2129', '#0d1115');
        this._drawTarmacStripes(c, W, H, HORIZON, s, true);
        this._drawMarkings(c, W, H, HORIZON, s, true);

        // Walkway lights
        for (let i = 0; i < 10; i++) {
            const t = (i + (s.worldPos * 0.04 % 1)) / 10;
            const px = 1 - Math.pow(1 - t, 2);
            const y = HORIZON + (H - HORIZON) * px;
            const sz = 1 + px * 4;
            c.fillStyle = '#44ff88';
            c.fillRect(W/2 - W * 0.30 * px - 6, y - sz/2, sz, sz);
            c.fillRect(W/2 + W * 0.30 * px + 6, y - sz/2, sz, sz);
        }

        this._drawNpcs(c, W, H, HORIZON, s, true);

        // Tunnel exit glow
        const exitGlow = c.createRadialGradient(vx, HORIZON, 5, vx, HORIZON, 50);
        exitGlow.addColorStop(0, 'rgba(255,230,160,0.45)');
        exitGlow.addColorStop(1, 'rgba(255,230,160,0)');
        c.fillStyle = exitGlow;
        c.beginPath(); c.arc(vx, HORIZON, 50, 0, Math.PI*2); c.fill();
    }

    _drawSkyBody(c, W, H, hour) {
        const pct = ((hour - 6 + 24) % 24) / 24;
        const sx = W * 0.15 + W * 0.7 * pct;
        const sy = H * 0.40 - Math.sin(pct * Math.PI) * H * 0.30;
        const isDay = hour >= 6 && hour < 19;
        c.save();
        if (isDay) {
            const g = c.createRadialGradient(sx, sy, 0, sx, sy, 55);
            g.addColorStop(0, 'rgba(255,255,200,0.95)');
            g.addColorStop(0.5, 'rgba(255,210,80,0.35)');
            g.addColorStop(1, 'rgba(255,210,50,0)');
            c.fillStyle = g; c.beginPath(); c.arc(sx, sy, 55, 0, Math.PI*2); c.fill();
            c.fillStyle = '#fffde0'; c.beginPath(); c.arc(sx, sy, 18, 0, Math.PI*2); c.fill();
        } else {
            const mg = c.createRadialGradient(sx, sy, 0, sx, sy, 40);
            mg.addColorStop(0, 'rgba(220,225,240,0.95)');
            mg.addColorStop(1, 'rgba(220,225,240,0)');
            c.fillStyle = mg; c.beginPath(); c.arc(sx, sy, 40, 0, Math.PI*2); c.fill();
            c.fillStyle = '#d0d8f0'; c.beginPath(); c.arc(sx, sy, 14, 0, Math.PI*2); c.fill();
            for (let i = 0; i < 60; i++) {
                c.fillStyle = `rgba(255,255,255,${0.2+Math.random()*0.7})`;
                c.fillRect((i*137.5)%W, (i*97.3)%(H*0.42), 1.5, 1.5);
            }
        }
        c.restore();
    }

    _drawClouds(c, W, H, hour, worldPos) {
        if (hour < 5 || hour > 21) return;
        c.save();
        c.fillStyle = `rgba(255,255,255,${hour > 18 ? 0.18 : 0.55})`;
        for (let i = 0; i < 6; i++) {
            const cx = ((i * 0.18 + worldPos * 0.0005) % 1) * W;
            const cy = H * (0.1 + (i * 0.07));
            const sz = 30 + (i % 3) * 12;
            c.beginPath();
            c.arc(cx, cy, sz, 0, Math.PI * 2);
            c.arc(cx + sz * 0.7, cy + 5, sz * 0.7, 0, Math.PI * 2);
            c.arc(cx - sz * 0.6, cy + 4, sz * 0.6, 0, Math.PI * 2);
            c.fill();
        }
        c.restore();
    }

    _drawDistantHills(c, W, H) {
        c.save();
        // Far hills (lighter, more distant)
        c.fillStyle = 'rgba(50,65,85,0.3)';
        c.beginPath(); c.moveTo(0, H);
        const farPts = [0, 0.08, 0.2, 0.35, 0.5, 0.62, 0.75, 0.88, 1];
        const farHs  = [H-8, H-18, H-12, H-28, H-20, H-32, H-16, H-22, H-8];
        for (let i = 0; i < farPts.length; i++) c.lineTo(farPts[i] * W, farHs[i]);
        c.lineTo(W, H); c.closePath(); c.fill();
        // Near hills (darker, closer)
        c.fillStyle = 'rgba(40,55,75,0.5)';
        c.beginPath(); c.moveTo(0, H);
        const pts = [0, 0.1, 0.18, 0.3, 0.42, 0.55, 0.65, 0.78, 0.9, 1];
        const hs  = [H-15, H-30, H-22, H-50, H-35, H-58, H-30, H-45, H-25, H-15];
        for (let i = 0; i < pts.length; i++) c.lineTo(pts[i] * W, hs[i]);
        c.lineTo(W, H); c.closePath(); c.fill();
        c.restore();
    }

    _drawCityscape(c, W, H, hour, seg) {
        c.save();
        const skyline = [
            [0.04,55,75],[0.10,38,115],[0.16,48,90],[0.22,32,150],
            [0.28,58,105],[0.34,42,160],[0.40,38,135],[0.46,62,95],
            [0.52,40,180],[0.58,48,140],[0.64,38,100],[0.70,52,160],
            [0.76,42,125],[0.83,58,95],[0.90,38,115],[0.96,46,80],
        ];
        const alpha = hour >= 6 && hour < 19 ? 0.42 : 0.7;
        for (const [xf, bw, ht] of skyline) {
            const bx = xf * W - bw/2;
            const by = H - ht;
            c.fillStyle = `rgba(20,25,40,${alpha})`;
            c.fillRect(bx, by, bw, ht);
            c.fillStyle = `rgba(35,42,60,${alpha})`;
            c.fillRect(bx + 4, by - 6, bw - 8, 6);
            if (hour < 6 || hour > 18) {
                for (let wy = by + 8; wy < H - 5; wy += 9) {
                    for (let wx = bx + 3; wx < bx + bw - 3; wx += 6) {
                        if (Math.random() > 0.45) {
                            c.fillStyle = 'rgba(255,235,150,0.7)';
                            c.fillRect(wx, wy, 3, 4);
                        }
                    }
                }
            }
        }
        // Charminar-ish silhouette
        if (seg && seg.type === 'urban') {
            const cx = W * 0.52, baseY = H - 5;
            c.fillStyle = `rgba(35,30,50,${alpha + 0.1})`;
            c.fillRect(cx - 22, baseY - 80, 44, 80);
            c.fillRect(cx - 26, baseY - 110, 8, 30);
            c.fillRect(cx + 18, baseY - 110, 8, 30);
            c.beginPath(); c.arc(cx - 22, baseY - 110, 6, 0, Math.PI*2); c.fill();
            c.beginPath(); c.arc(cx + 22, baseY - 110, 6, 0, Math.PI*2); c.fill();
        }
        c.restore();
    }

    _drawRoad(c, W, H, horizon, s, surfTop, surfBot) {
        // Vanishing point shifts slightly with curvature + mild steering
        const curve = s.curvature + s.laneOffset * 0.08;
        const vx = W/2 + curve * W * 0.7;
        // Bottom of road shifts in opposite direction (car moves within lane)
        const ls = -s.laneOffset * W * 0.15;
        const RHF = W * 0.05, RHN = W * 0.34;
        c.save();
        const segType = HYDERABAD_ROUTE[s.routeIdx % HYDERABAD_ROUTE.length].type;
        const isHwy = segType === 'highway' || segType === 'tunnel';
        const rg = c.createLinearGradient(0, horizon, 0, H);
        rg.addColorStop(0, surfTop || (isHwy ? '#2d3340' : '#3a4350'));
        rg.addColorStop(1, surfBot || (isHwy ? '#181d28' : '#222a35'));
        c.fillStyle = rg;
        c.beginPath();
        c.moveTo(vx - RHF, horizon); c.lineTo(vx + RHF, horizon);
        c.lineTo(W/2 + RHN + ls, H); c.lineTo(W/2 - RHN + ls, H); c.closePath(); c.fill();
        if (segType !== 'tunnel') {
            c.fillStyle = '#3d4a3a';
            c.beginPath();
            c.moveTo(vx - RHF - 12, horizon); c.lineTo(vx - RHF, horizon);
            c.lineTo(W/2 - RHN + ls, H); c.lineTo(W/2 - RHN - 22 + ls, H); c.closePath(); c.fill();
            c.beginPath();
            c.moveTo(vx + RHF, horizon); c.lineTo(vx + RHF + 12, horizon);
            c.lineTo(W/2 + RHN + 22 + ls, H); c.lineTo(W/2 + RHN + ls, H); c.closePath(); c.fill();
        }
        c.restore();
    }

    /**
     * Scrolling tarmac stripes — perspective-projected shadow bands across the road.
     * Creates a strong sense of forward motion proportional to speed.
     */
    _drawTarmacStripes(c, W, H, horizon, s, isTunnel) {
        const curve = s.curvature + s.laneOffset * 0.08;
        const vx = W/2 + curve * W * 0.7;
        const ls = -s.laneOffset * W * 0.15;
        const RHF = W * 0.05, RHN = W * 0.34;
        c.save();
        const STRIPES = 18;
        const offset = (s.worldPos * 0.3) % 1;
        for (let i = 0; i < STRIPES; i++) {
            const ti = (i + offset) / STRIPES;
            const px = 1 - Math.pow(1 - ti, 2.2);
            const yA = horizon + (H - horizon) * px;
            const yB = horizon + (H - horizon) * Math.min(1, px + 1.0 / STRIPES * 0.45);
            const shift = ls * px;
            const xLA = vx - RHF * (1 - px) - RHN * px + shift;
            const xRA = vx + RHF * (1 - px) + RHN * px + shift;
            const xLB = vx - RHF * (1 - (px + 0.05)) - RHN * (px + 0.05) + shift;
            const xRB = vx + RHF * (1 - (px + 0.05)) + RHN * (px + 0.05) + shift;
            const alpha = (i % 2 === 0 ? 0.12 : 0.04) * (0.4 + 0.6 * px);
            c.fillStyle = isTunnel
                ? `rgba(255,255,255,${alpha * 0.5})`
                : `rgba(0,0,0,${alpha})`;
            c.beginPath();
            c.moveTo(xLA, yA); c.lineTo(xRA, yA);
            c.lineTo(xRB, yB); c.lineTo(xLB, yB);
            c.closePath(); c.fill();
        }
        c.restore();
    }

    /**
     * Roadside billboards / hoardings advertising Hyderabad locations.
     * They swing past in proper perspective on alternating sides.
     */
    _drawBillboards(c, W, H, horizon, s, seg) {
        const billboards = [
            { txt: 'Welcome to Gachibowli',  sub: 'Cyberabad · IT Hub',    col: '#0af'    },
            { txt: 'IKEA · 2 km',             sub: 'Nallagandla',           col: '#ffaa00' },
            { txt: 'DLF Cyber City',         sub: 'Exit 200m',              col: '#9b59b6' },
            { txt: 'Hi-Tech City',           sub: 'Next Right',             col: '#3498db' },
            { txt: 'KIMS Hospital',          sub: '24/7 Emergency',         col: '#e74c3c' },
            { txt: 'Shamshabad ✈',           sub: 'Airport · 18 km',        col: '#27ae60' },
        ];
        const SEG = 240;  // billboards every 240m
        const startSeg = Math.floor(s.worldPos / SEG);
        c.save();
        for (let k = -1; k <= 2; k++) {
            const segIdx = startSeg + k;
            const segPos = segIdx * SEG;
            const rel = segPos - s.worldPos;
            if (rel < 5 || rel > 380) continue;
            const t = 1 - rel / 380;
            const px = 1 - Math.pow(1 - t, 1.7);
            const right = (segIdx % 2 === 0);
            const sx = W/2 + (right ? +1 : -1) * (W * 0.32 * px + 60);
            const sy = horizon + (H - horizon) * Math.pow(px, 1.4) - 60 * px;
            const bw = 90 * px;
            const bh = 50 * px;
            if (bw < 6) continue;
            const bb = billboards[Math.abs(segIdx) % billboards.length];
            // Posts
            c.fillStyle = '#3a3a3a';
            c.fillRect(sx - bw*0.45, sy + bh*0.6, 3 * px, bh * 0.8);
            c.fillRect(sx + bw*0.45 - 3*px, sy + bh*0.6, 3 * px, bh * 0.8);
            // Board frame
            c.fillStyle = '#1a1a1a';
            c.fillRect(sx - bw/2 - 2*px, sy - bh/2 - 2*px, bw + 4*px, bh + 4*px);
            // Board face
            c.fillStyle = bb.col;
            c.fillRect(sx - bw/2, sy - bh/2, bw, bh);
            // Text (only when readable)
            if (bw > 40) {
                c.fillStyle = '#fff';
                c.font = `bold ${Math.max(8, Math.floor(10 * px))}px sans-serif`;
                c.textAlign = 'center';
                c.fillText(bb.txt, sx, sy - 2);
                c.font = `${Math.max(7, Math.floor(8 * px))}px sans-serif`;
                c.fillText(bb.sub, sx, sy + 12 * px);
            }
        }
        c.restore();
    }

    _drawMarkings(c, W, H, horizon, s, brightTunnel) {
        const curve = s.curvature + s.laneOffset * 0.08;
        const vx = W/2 + curve * W * 0.7;
        const ls = -s.laneOffset * W * 0.15;
        const dash = (s.worldPos * 0.3) % 40;
        c.save();
        c.strokeStyle = brightTunnel ? '#ffffaa' : '#ffffff';
        c.lineWidth = 2; c.setLineDash([]);
        c.beginPath(); c.moveTo(vx - W*0.05, horizon); c.lineTo(W/2 - W*0.34 + ls, H); c.stroke();
        c.beginPath(); c.moveTo(vx + W*0.05, horizon); c.lineTo(W/2 + W*0.34 + ls, H); c.stroke();
        c.strokeStyle = brightTunnel ? '#ffff66' : '#ffe14a';
        c.lineWidth = 2.5;
        c.setLineDash([24, 18]); c.lineDashOffset = -dash;
        c.beginPath(); c.moveTo(vx, horizon); c.lineTo(W/2 + ls, H); c.stroke();
        c.strokeStyle = brightTunnel ? 'rgba(255,255,150,0.55)' : 'rgba(255,225,74,0.45)';
        c.lineWidth = 1.5;
        for (const off of [-0.5, 0.5]) {
            c.beginPath();
            c.moveTo(vx + off * W*0.025, horizon);
            c.lineTo(W/2 + off * W*0.17 + ls, H); c.stroke();
        }
        c.setLineDash([]); c.restore();
    }

    _drawRoadside(c, W, H, horizon, s, seg) {
        c.save();
        const ls = -s.laneOffset * W * 0.15;
        const posInSeg = s.worldPos % SEG_LENGTH_M;

        if (posInSeg < 100) {
            const opacity = Math.min(1, (100 - posInSeg) / 50);
            c.globalAlpha = opacity;
            const sx = W * 0.13 + ls * 0.5, sy = H * 0.50;
            c.fillStyle = seg.color || '#3498db';
            c.beginPath(); c.roundRect(sx - 75, sy - 22, 150, 44, 6); c.fill();
            c.strokeStyle = '#fff'; c.lineWidth = 1.5;
            c.beginPath(); c.roundRect(sx - 75, sy - 22, 150, 44, 6); c.stroke();
            c.fillStyle = '#fff';
            c.font = 'bold 11px monospace'; c.textAlign = 'center';
            c.fillText(seg.name.slice(0, 22), sx, sy);
            c.font = '9px monospace';
            c.fillText(`${seg.type.toUpperCase()} · ${seg.speed} km/h`, sx, sy + 14);
            c.globalAlpha = 1;
        }

        const t = seg.type;
        const isHwy = t === 'highway';
        for (let i = 0; i < 7; i++) {
            const ti = i / 7;
            const px = 1 - Math.pow(1 - ti, 2);
            const shift = ls * px;
            const rx = W/2 - W * 0.34 * px - 30 + shift;
            const lx = W/2 + W * 0.34 * px + 30 + shift;
            const y  = horizon + (H - horizon) * px;
            const sz = 4 + px * 22;
            const off = ((s.worldPos * 0.05 + i * 137) % 90 - 45) * px;
            if (isHwy) {
                c.strokeStyle = '#555'; c.lineWidth = 1 + 2 * px;
                c.beginPath(); c.moveTo(rx + off, y); c.lineTo(rx + off, y - sz * 1.5); c.stroke();
                c.beginPath(); c.moveTo(lx - off, y); c.lineTo(lx - off, y - sz * 1.5); c.stroke();
                if (s.time < 7 || s.time > 18) {
                    c.fillStyle = `rgba(255,225,140,${0.6 * px})`;
                    c.beginPath(); c.arc(rx + off, y - sz * 1.5, sz * 0.4, 0, Math.PI*2); c.fill();
                    c.beginPath(); c.arc(lx - off, y - sz * 1.5, sz * 0.4, 0, Math.PI*2); c.fill();
                }
            } else {
                // Realistic palm/neem trees with layered canopy
                const trunkH = sz * 0.8;
                const trunkW = Math.max(2, sz * 0.15);
                // Trunk — tapered brown
                c.fillStyle = '#4a3020';
                c.beginPath();
                c.moveTo(rx + off - trunkW, y);
                c.lineTo(rx + off - trunkW * 0.6, y - trunkH);
                c.lineTo(rx + off + trunkW * 0.6, y - trunkH);
                c.lineTo(rx + off + trunkW, y);
                c.closePath(); c.fill();
                c.beginPath();
                c.moveTo(lx - off - trunkW, y);
                c.lineTo(lx - off - trunkW * 0.6, y - trunkH);
                c.lineTo(lx - off + trunkW * 0.6, y - trunkH);
                c.lineTo(lx - off + trunkW, y);
                c.closePath(); c.fill();
                // Canopy — layered ovals (darker bottom, lighter top)
                const canR = sz * 0.9;
                c.fillStyle = '#1a5c1a';
                c.beginPath(); c.ellipse(rx + off, y - trunkH - canR*0.3, canR, canR*0.7, 0, 0, Math.PI*2); c.fill();
                c.beginPath(); c.ellipse(lx - off, y - trunkH - canR*0.3, canR, canR*0.7, 0, 0, Math.PI*2); c.fill();
                c.fillStyle = '#2d8a2d';
                c.beginPath(); c.ellipse(rx + off, y - trunkH - canR*0.5, canR*0.75, canR*0.55, 0, 0, Math.PI*2); c.fill();
                c.beginPath(); c.ellipse(lx - off, y - trunkH - canR*0.5, canR*0.75, canR*0.55, 0, 0, Math.PI*2); c.fill();
                c.fillStyle = '#3aaf3a';
                c.beginPath(); c.ellipse(rx + off, y - trunkH - canR*0.65, canR*0.5, canR*0.35, 0, 0, Math.PI*2); c.fill();
                c.beginPath(); c.ellipse(lx - off, y - trunkH - canR*0.65, canR*0.5, canR*0.35, 0, 0, Math.PI*2); c.fill();
            }
        }

        if (t === 'parking') {
            for (let i = 0; i < 5; i++) {
                const ti = (i + 0.4) / 5;
                const px = 1 - Math.pow(1 - ti, 2);
                const x = W/2 - W * 0.40 * px - 30;
                const y = horizon + (H - horizon) * px;
                c.fillStyle = `rgba(255,255,255,${0.6 * px})`;
                c.fillRect(x, y, 14 * px, 2 * px);
                c.fillRect(x + 30, y, 14 * px, 2 * px);
            }
            const sx = W * 0.85, sy = H * 0.55;
            c.fillStyle = '#1a73e8'; c.fillRect(sx, sy - 24, 28, 28);
            c.fillStyle = '#fff'; c.font = 'bold 18px monospace'; c.textAlign = 'center';
            c.fillText('P', sx + 14, sy - 6);
        }
        if (t === 'gas') {
            const sx = W * 0.84, sy = H * 0.60;
            c.fillStyle = '#f39c12'; c.fillRect(sx - 30, sy - 50, 60, 14);
            c.fillStyle = '#34495e'; c.fillRect(sx - 4, sy - 36, 8, 28);
            c.fillStyle = '#e74c3c'; c.fillRect(sx - 28, sy - 32, 12, 22);
            c.fillStyle = '#fff'; c.font = 'bold 9px monospace'; c.textAlign = 'center';
            c.fillText('FUEL', sx, sy - 41);
        }
        if (t === 'rest') {
            const sx = W * 0.86, sy = H * 0.62;
            c.fillStyle = '#27ae60';
            c.beginPath(); c.arc(sx + 20, sy - 20, 22, 0, Math.PI*2); c.fill();
            c.fillStyle = '#7f8c8d';
            c.fillRect(sx - 8, sy - 4, 28, 4);
            c.fillRect(sx - 6, sy, 3, 8);
            c.fillRect(sx + 17, sy, 3, 8);
            c.fillStyle = '#fff'; c.font = 'bold 9px monospace';
            c.fillText('REST', sx + 5, sy - 28);
        }
        if (t === 'emergency') {
            for (let i = 0; i < 5; i++) {
                const ti = (i + 0.5) / 5;
                const px = 1 - Math.pow(1 - ti, 2);
                const x  = W/2 - W * 0.32 * px;
                const y  = horizon + (H - horizon) * px;
                const w  = 14 * px, h = 24 * px;
                c.fillStyle = i % 2 === 0 ? '#ff2222' : '#ffffff';
                c.fillRect(x - w/2, y - h, w, h);
            }
            const sx = W * 0.85, sy = H * 0.58;
            c.fillStyle = '#c0392b'; c.fillRect(sx, sy - 22, 32, 22);
            c.fillStyle = '#fff'; c.font = 'bold 10px monospace'; c.textAlign = 'center';
            c.fillText('SOS', sx + 16, sy - 8);
        }
        c.restore();
    }

    _drawNpcs(c, W, H, horizon, s, dim) {
        const npcs = s.npcs.map(n => ({ ...n, rel: n.pos - s.worldPos }))
            .filter(n => n.rel > 5 && n.rel < 380)
            .sort((a, b) => b.rel - a.rel);
        const ls = -s.laneOffset * W * 0.15;
        for (const n of npcs) {
            const t  = 1 - n.rel / 380;
            const py = horizon + (H - horizon - 30) * Math.pow(t, 1.4);
            const lx = W/2 + n.lane * W * 0.12 * t + ls * t;
            const sc = 0.1 + t * 0.95;
            const isAuto  = n.type === 'auto';
            const isTruck = n.type === 'truck';
            const cw = sc * (isTruck ? 60 : isAuto ? 28 : 40);
            const ch = sc * (isTruck ? 42 : isAuto ? 30 : 32);
            c.save(); c.translate(lx, py);
            // Soft shadow
            c.fillStyle = `rgba(0,0,0,${0.4 * t})`;
            c.beginPath(); c.ellipse(0, ch/2 + 3*sc, cw*0.55, cw*0.14, 0, 0, Math.PI*2); c.fill();
            // Body w/ vertical gradient sheen
            const bg = c.createLinearGradient(0, -ch/2, 0, ch/2);
            const bodyCol = dim ? this._dim(n.color) : n.color;
            bg.addColorStop(0, this._lighten(bodyCol, 0.35));
            bg.addColorStop(0.5, bodyCol);
            bg.addColorStop(1, this._dim(bodyCol));
            c.fillStyle = bg;
            c.beginPath(); c.roundRect(-cw/2, -ch/2, cw, ch, 4*sc); c.fill();
            // Body outline
            c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = Math.max(1, sc * 1.2);
            c.beginPath(); c.roundRect(-cw/2, -ch/2, cw, ch, 4*sc); c.stroke();
            // Roof / cargo / hood
            if (isTruck) {
                c.fillStyle = 'rgba(0,0,0,0.55)';
                c.beginPath(); c.roundRect(-cw*0.45, -ch*0.5, cw*0.4, ch*0.55, 2*sc); c.fill();
                // Cargo box top
                c.fillStyle = this._dim(bodyCol);
                c.fillRect(-cw*0.05, -ch*0.5, cw*0.5, ch*0.55);
            } else if (isAuto) {
                c.fillStyle = '#f1c40f';
                c.beginPath(); c.arc(0, -ch*0.2, cw*0.5, Math.PI, 2*Math.PI); c.fill();
                c.strokeStyle = '#222'; c.lineWidth = 1;
                c.beginPath(); c.arc(0, -ch*0.2, cw*0.5, Math.PI, 2*Math.PI); c.stroke();
            } else {
                c.fillStyle = 'rgba(0,0,0,0.45)';
                c.beginPath(); c.roundRect(-cw*0.32, -ch*0.5, cw*0.64, ch*0.5, 2*sc); c.fill();
            }
            // Rear window (light blue)
            c.fillStyle = `rgba(140,180,220,${0.55 * t + 0.15})`;
            c.fillRect(-cw*0.27, -ch*0.42, cw*0.54, ch*0.30);
            // Rear lights — brighter when in tunnel/dim
            const lightAlpha = dim ? 1 : 0.85;
            c.fillStyle = `rgba(255,40,40,${lightAlpha})`;
            c.fillRect(-cw/2 + 2*sc, ch/2 - 6*sc, 8*sc, 4*sc);
            c.fillRect(cw/2 - 10*sc, ch/2 - 6*sc, 8*sc, 4*sc);
            // Glow halos on rear lights (only when readable)
            if (sc > 0.4) {
                c.fillStyle = `rgba(255,80,80,${0.35 * lightAlpha})`;
                c.beginPath(); c.arc(-cw/2 + 6*sc, ch/2 - 4*sc, 5*sc, 0, Math.PI*2); c.fill();
                c.beginPath(); c.arc(cw/2 - 6*sc, ch/2 - 4*sc, 5*sc, 0, Math.PI*2); c.fill();
            }
            // Wheels — visible on the body sides
            if (sc > 0.35) {
                c.fillStyle = '#0a0a0a';
                const wr = Math.max(2, sc * 4);
                c.beginPath(); c.arc(-cw*0.40, ch*0.40, wr, 0, Math.PI*2); c.fill();
                c.beginPath(); c.arc( cw*0.40, ch*0.40, wr, 0, Math.PI*2); c.fill();
                c.beginPath(); c.arc(-cw*0.40, -ch*0.40, wr, 0, Math.PI*2); c.fill();
                c.beginPath(); c.arc( cw*0.40, -ch*0.40, wr, 0, Math.PI*2); c.fill();
            }
            c.restore();
        }
    }

    _lighten(hex, amount = 0.3) {
        try {
            const m = String(hex).match(/^(?:rgb\(|#)([^)]+)/);
            let r, g, b;
            if (hex.startsWith('rgb')) {
                const parts = hex.match(/\d+/g).map(Number);
                [r, g, b] = parts;
            } else {
                const h = hex.replace('#','');
                r = parseInt(h.substr(0,2),16);
                g = parseInt(h.substr(2,2),16);
                b = parseInt(h.substr(4,2),16);
            }
            r = Math.min(255, Math.floor(r + (255 - r) * amount));
            g = Math.min(255, Math.floor(g + (255 - g) * amount));
            b = Math.min(255, Math.floor(b + (255 - b) * amount));
            return `rgb(${r},${g},${b})`;
        } catch { return hex; }
    }

    _dim(hex) {
        try {
            let r, g, b;
            if (String(hex).startsWith('rgb')) {
                const parts = hex.match(/\d+/g).map(Number);
                [r, g, b] = parts;
            } else {
                const h = hex.replace('#','');
                r = parseInt(h.substr(0,2),16);
                g = parseInt(h.substr(2,2),16);
                b = parseInt(h.substr(4,2),16);
            }
            return `rgb(${Math.floor(r*0.55)},${Math.floor(g*0.55)},${Math.floor(b*0.55)})`;
        } catch { return '#222'; }
    }

    _drawBonnet(c, W, H, s, seg) {
        c.save();
        const offset = s.laneOffset * 12;
        const bx = W/2 - 160 + offset, by = H - 88, bw = 320, bh = 88;
        const isTunnel = seg && seg.type === 'tunnel';
        const bg = c.createLinearGradient(bx, by, bx, by + bh);
        if (isTunnel) {
            bg.addColorStop(0, '#0a3530'); bg.addColorStop(0.7, '#06201c'); bg.addColorStop(1, '#020a08');
        } else {
            bg.addColorStop(0, '#2a7c50'); bg.addColorStop(0.5, '#1a5c36'); bg.addColorStop(1, '#0a2818');
        }
        c.fillStyle = bg;
        c.beginPath();
        c.moveTo(bx, by); c.lineTo(bx + bw, by);
        c.lineTo(bx + bw + 50, by + bh); c.lineTo(bx - 50, by + bh);
        c.closePath(); c.fill();

        // Reflective sheen along the top
        const sheen = c.createLinearGradient(bx, by, bx + bw, by);
        sheen.addColorStop(0,   'rgba(255,255,255,0)');
        sheen.addColorStop(0.4, 'rgba(255,255,255,0.18)');
        sheen.addColorStop(0.6, 'rgba(255,255,255,0.18)');
        sheen.addColorStop(1,   'rgba(255,255,255,0)');
        c.fillStyle = sheen;
        c.fillRect(bx + 20, by, bw - 40, 8);

        // Side highlights (curvature)
        c.fillStyle = 'rgba(255,255,255,0.06)';
        c.fillRect(bx + 4, by + 8, 18, bh - 14);
        c.fillRect(bx + bw - 22, by + 8, 18, bh - 14);

        // Centre crease
        c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(W/2 + offset, by + 4); c.lineTo(W/2 + offset, by + bh + 8); c.stroke();

        // Side mirrors hint (small angled blocks at the top edges)
        c.fillStyle = 'rgba(15,30,22,0.8)';
        c.beginPath();
        c.moveTo(bx + 8, by); c.lineTo(bx + 36, by);
        c.lineTo(bx + 30, by - 12); c.lineTo(bx + 12, by - 12);
        c.closePath(); c.fill();
        c.beginPath();
        c.moveTo(bx + bw - 8, by); c.lineTo(bx + bw - 36, by);
        c.lineTo(bx + bw - 30, by - 12); c.lineTo(bx + bw - 12, by - 12);
        c.closePath(); c.fill();

        // Steering-wheel rim peeking up at the bottom centre
        const swCx = W/2 + offset, swCy = by + bh + 10, swR = 70;
        c.strokeStyle = '#0c0c0c'; c.lineWidth = 8;
        c.beginPath(); c.arc(swCx, swCy, swR, Math.PI * 1.05, Math.PI * 1.95); c.stroke();
        c.strokeStyle = '#222'; c.lineWidth = 2;
        c.beginPath(); c.arc(swCx, swCy, swR - 4, Math.PI * 1.05, Math.PI * 1.95); c.stroke();
        c.restore();
    }

    _drawWeather(c, W, H, s) {
        c.save();
        if (s.weather === 'rain') {
            c.strokeStyle = 'rgba(150,180,255,0.5)'; c.lineWidth = 1;
            for (let i = 0; i < 130; i++) {
                const rx = ((i * 237.4 + s.worldPos * 5) % W);
                const ry = ((i * 113.7 + s.worldPos * 3) % H);
                c.beginPath(); c.moveTo(rx, ry); c.lineTo(rx-2, ry+14); c.stroke();
            }
            c.fillStyle = 'rgba(100,130,180,0.10)'; c.fillRect(0,0,W,H);
            // Wet road reflections
            const wetGrad = c.createLinearGradient(0, H * 0.65, 0, H);
            wetGrad.addColorStop(0, 'rgba(100,140,200,0)');
            wetGrad.addColorStop(0.5, 'rgba(100,140,200,0.08)');
            wetGrad.addColorStop(1, 'rgba(100,140,200,0.15)');
            c.fillStyle = wetGrad; c.fillRect(W*0.15, H*0.5, W*0.7, H*0.5);
        } else if (s.weather === 'fog') {
            const fogGrad = c.createLinearGradient(0, H*0.2, 0, H);
            fogGrad.addColorStop(0, 'rgba(180,185,200,0.1)');
            fogGrad.addColorStop(0.4, 'rgba(180,185,200,0.45)');
            fogGrad.addColorStop(1, 'rgba(180,185,200,0.6)');
            c.fillStyle = fogGrad; c.fillRect(0, H*0.20, W, H*0.8);
        }
        c.restore();
    }

    _drawHUD(c, W, H, s, seg) {
        c.save();
        // Location pill (top-centre)
        c.fillStyle = 'rgba(0,0,0,0.78)';
        c.beginPath(); c.roundRect(W/2 - 130, 8, 260, 30, 6); c.fill();
        c.strokeStyle = seg.color || '#3498db'; c.lineWidth = 1.5;
        c.beginPath(); c.roundRect(W/2 - 130, 8, 260, 30, 6); c.stroke();
        c.fillStyle = seg.color || '#3498db';
        c.font = 'bold 12px monospace'; c.textAlign = 'center';
        c.fillText(`📍 ${seg.name}`, W/2, 27);

        // Speed limit sign (top-left)
        c.fillStyle = '#fff'; c.strokeStyle = '#c00'; c.lineWidth = 3;
        c.beginPath(); c.arc(36, 36, 22, 0, Math.PI*2); c.fill(); c.stroke();
        c.fillStyle = '#000'; c.font = 'bold 14px monospace'; c.textAlign = 'center';
        c.fillText(seg.speed, 36, 41);
        c.fillStyle = '#777'; c.font = '8px monospace';
        c.fillText('km/h', 36, 64);

        // Alert banner
        if (s.activeAlert) {
            const a = s.activeAlert;
            const col = a.sev === 'critical' ? '#ff4444' :
                       a.sev === 'warning' ? '#ffaa00' : '#0af';
            const bg  = a.sev === 'critical' ? 'rgba(80,0,0,0.9)' :
                       a.sev === 'warning' ? 'rgba(60,40,0,0.9)' : 'rgba(0,30,60,0.9)';
            c.fillStyle = bg; c.strokeStyle = col; c.lineWidth = 2;
            c.beginPath(); c.roundRect(W/2 - 200, H*0.43 + 5, 400, 56, 8); c.fill(); c.stroke();
            c.fillStyle = col; c.font = 'bold 14px monospace'; c.textAlign = 'center';
            c.fillText('⚠ ' + a.msg.slice(0, 50), W/2, H*0.43 + 30);
            c.fillStyle = 'rgba(255,255,255,0.55)'; c.font = '10px monospace';
            c.fillText('[' + a.type + ']', W/2, H*0.43 + 50);
        }

        // LLM rest reco (top below location)
        if (s.recommendedRest && !s.paused) {
            c.fillStyle = 'rgba(0,40,20,0.85)';
            c.beginPath(); c.roundRect(W/2 - 160, 44, 320, 22, 4); c.fill();
            c.fillStyle = '#44ff88'; c.font = '11px monospace'; c.textAlign = 'center';
            c.fillText('🛏 ' + s.recommendedRest.slice(0, 42), W/2, 60);
        }
        c.restore();
    }

    _drawMinimap(c, W, H, s) {
        const mx = W - 145, my = 8, mw = 138, mh = 130;
        c.save();
        c.fillStyle = 'rgba(0,0,0,0.78)';
        c.strokeStyle = '#0af'; c.lineWidth = 1;
        c.beginPath(); c.roundRect(mx, my, mw, mh, 6); c.fill(); c.stroke();

        c.fillStyle = '#0af'; c.font = '9px monospace'; c.textAlign = 'center';
        c.fillText('HYDERABAD ROUTE', mx + mw/2, my + 11);

        const total = HYDERABAD_ROUTE.length;
        const cols = 4;
        for (let i = 0; i < total; i++) {
            const rt = HYDERABAD_ROUTE[i];
            const px = mx + 10 + (i % cols) * ((mw - 20) / (cols - 1));
            const py = my + 22 + Math.floor(i / cols) * 14;
            c.fillStyle = rt.color || '#3498db';
            c.beginPath(); c.arc(px, py, 3, 0, Math.PI*2); c.fill();
            // Connecting line
            if (i > 0) {
                const prev = HYDERABAD_ROUTE[i - 1];
                const ppx = mx + 10 + ((i-1) % cols) * ((mw - 20) / (cols - 1));
                const ppy = my + 22 + Math.floor((i-1) / cols) * 14;
                c.strokeStyle = 'rgba(80,90,110,0.5)';
                c.lineWidth = 0.8;
                c.beginPath(); c.moveTo(ppx, ppy); c.lineTo(px, py); c.stroke();
            }
        }

        // Player marker
        const ci = s.routeIdx % total;
        const ppx = mx + 10 + (ci % cols) * ((mw - 20) / (cols - 1));
        const ppy = my + 22 + Math.floor(ci / cols) * 14;
        c.fillStyle = '#fff'; c.strokeStyle = '#44ff88'; c.lineWidth = 2;
        c.beginPath(); c.arc(ppx, ppy, 5, 0, Math.PI*2); c.fill(); c.stroke();

        // Stats
        c.fillStyle = '#aab'; c.font = '8px monospace'; c.textAlign = 'left';
        c.fillText(`${s.distance.toFixed(1)} km`, mx + 6, my + mh - 18);
        const hh = Math.floor(s.time);
        const mm = Math.floor((s.time % 1) * 60);
        c.fillText(`${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`, mx + 6, my + mh - 6);
        c.fillStyle = '#0af'; c.textAlign = 'right';
        c.fillText(`${HYDERABAD_ROUTE[ci].type.toUpperCase()}`, mx + mw - 6, my + mh - 6);
        c.restore();
    }

    // Embedded dashboard at the bottom of the game canvas
    _drawEmbeddedDashboard(c, x, y, W, H, s, seg) {
        c.save();
        // Background
        const bg = c.createLinearGradient(x, y, x, y + H);
        bg.addColorStop(0, '#10131a');
        bg.addColorStop(1, '#05070b');
        c.fillStyle = bg; c.fillRect(x, y, W, H);
        c.strokeStyle = '#1e2535'; c.lineWidth = 1;
        c.strokeRect(x + 0.5, y + 0.5, W - 1, H - 1);

        // Subtle stitching line
        c.fillStyle = 'rgba(0,170,255,0.08)';
        c.fillRect(x, y, W, 2);

        const cy = y + H/2;

        // ── Speedometer (left) ─────────────────────────────────────
        const gaugeR = Math.min(38, H * 0.42);
        const speedX = x + gaugeR + 22;
        this._drawGauge(c, speedX, cy, gaugeR, s.speed, 0, 200, 'SPEED',
            `${Math.round(s.speed)}`, 'km/h',
            s.speed > seg.speed + 15 ? '#ff4444' :
            s.speed > seg.speed       ? '#ffaa00' : '#0af');

        // ── RPM gauge ─────────────────────────────────────────────
        const rpmX = speedX + gaugeR + gaugeR * 0.85 + 14;
        this._drawGauge(c, rpmX, cy, gaugeR * 0.78, s.rpm, 0, 7000, 'RPM',
            `${(s.rpm/1000).toFixed(1)}`, 'x1k',
            s.rpm > 5500 ? '#ff4444' : s.rpm > 3500 ? '#ffaa00' : '#44ff88');

        // ── Gear indicator ────────────────────────────────────────
        const gearX = rpmX + gaugeR + 18;
        c.fillStyle = '#0a0e16';
        c.fillRect(gearX - 18, cy - 18, 36, 36);
        c.strokeStyle = '#1e2535'; c.lineWidth = 1;
        c.strokeRect(gearX - 18, cy - 18, 36, 36);
        c.fillStyle = '#0af'; c.font = 'bold 22px monospace'; c.textAlign = 'center';
        c.fillText(s.gear, gearX, cy + 7);
        c.fillStyle = '#556070'; c.font = '8px monospace';
        c.fillText('GEAR', gearX, cy + 22);

        // ── Vertical bars: fuel, temp, oil, batt ─────────────────
        const barStart = gearX + 35;
        const barSpacing = Math.min(48, (W - barStart - 280) / 4);
        const barCfg = [
            ['FUEL', s.fuel,        '⛽', s.fuel < 0.15],
            ['TEMP', s.engineTemp,  '🌡', s.engineTemp > 0.85],
            ['OIL',  s.oilPressure, '🛢', s.oilPressure < 0.4],
            ['BATT', s.battery,     '🔋', s.battery < 0.5],
        ];
        for (let i = 0; i < barCfg.length; i++) {
            const bx = barStart + i * barSpacing;
            this._drawBar(c, bx, cy, barCfg[i][0], barCfg[i][1], barCfg[i][2], barCfg[i][3]);
        }

        // ── Indicators (right side) ──────────────────────────────
        const indX = barStart + barCfg.length * barSpacing + 18;
        const indY = y + 12;

        c.fillStyle = '#aab'; c.font = '9px monospace'; c.textAlign = 'left';
        c.fillText(seg.name.toUpperCase().slice(0, 24), indX, indY);

        c.fillStyle = s.paused ? '#ffaa00' : '#44ff88';
        c.font = 'bold 11px monospace';
        c.fillText(s.paused ? '⏸ PAUSED' : '▶ DRIVING', indX, indY + 14);

        c.fillStyle = '#778899'; c.font = '9px monospace';
        c.fillText(`${s.distance.toFixed(1)} km · ${seg.type}`, indX, indY + 28);

        // Speed limit indicator
        c.fillStyle = '#aab'; c.font = '9px monospace';
        c.fillText(`limit: ${seg.speed} km/h`, indX, indY + 42);

        // Active warning icons row
        let wx = indX;
        const warningY = indY + 58;
        c.font = '15px sans-serif';
        if (s.fuel < 0.15)        { c.fillStyle = '#ff8800'; c.fillText('⛽', wx, warningY); wx += 22; }
        if (s.engineTemp > 0.85)  { c.fillStyle = '#ff4444'; c.fillText('🌡', wx, warningY); wx += 22; }
        if (s.oilPressure < 0.4)  { c.fillStyle = '#ffaa00'; c.fillText('🛢', wx, warningY); wx += 22; }
        if (s.battery < 0.5)      { c.fillStyle = '#0af';    c.fillText('🔋', wx, warningY); wx += 22; }
        if (seg.type === 'tunnel'){ c.fillStyle = '#9b59b6'; c.fillText('💡', wx, warningY); wx += 22; }
        if (s.weather !== 'clear'){ c.fillStyle = '#3498db'; c.fillText(s.weather === 'rain' ? '🌧' : '🌫', wx, warningY); }

        // Turn signal indicators (animated when steering)
        const steerL = this._keys['ArrowLeft']  || this._keys['KeyA'];
        const steerR = this._keys['ArrowRight'] || this._keys['KeyD'];
        const blink = Math.floor(Date.now() / 300) % 2 === 0;
        const tsY = y + H - 18;
        c.font = '14px sans-serif'; c.textAlign = 'center';
        c.fillStyle = (steerL && blink) ? '#44ff88' : '#1e2535';
        c.fillText('◀', x + 18, tsY);
        c.fillStyle = (steerR && blink) ? '#44ff88' : '#1e2535';
        c.fillText('▶', x + W - 18, tsY);

        c.restore();
    }

    _drawGauge(c, cx, cy, r, val, min, max, lbl, valTxt, unit, color) {
        const pct = Math.max(0, Math.min(1, (val - min) / (max - min)));
        const sa = Math.PI * 0.75, ea = Math.PI * 2.25;
        const ca = sa + (ea - sa) * pct;
        c.save();
        // Background arc
        c.beginPath(); c.arc(cx, cy, r, sa, ea); c.strokeStyle = '#1e2535'; c.lineWidth = 6; c.stroke();
        // Value arc
        c.beginPath(); c.arc(cx, cy, r, sa, ca); c.strokeStyle = color;
        c.lineWidth = 6; c.lineCap = 'round'; c.stroke();
        // Inner glow
        c.beginPath(); c.arc(cx, cy, r - 8, 0, Math.PI * 2);
        c.fillStyle = 'rgba(0,0,0,0.4)'; c.fill();
        // Value
        c.fillStyle = color; c.font = `bold ${Math.floor(r * 0.5)}px monospace`;
        c.textAlign = 'center'; c.fillText(valTxt, cx, cy + 4);
        // Unit
        c.fillStyle = '#778899'; c.font = `${Math.floor(r * 0.24)}px monospace`;
        c.fillText(unit, cx, cy + r * 0.42);
        // Label above
        c.fillText(lbl, cx, cy - r - 4);
        c.restore();
    }

    _drawBar(c, cx, cy, lbl, val, icon, danger) {
        const bh = Math.min(48, 50), bw = 14;
        const by = cy - bh / 2;
        // Background
        c.fillStyle = '#15192a';
        c.beginPath(); c.roundRect(cx - bw/2, by, bw, bh, 3); c.fill();
        // Filled portion
        const col = val < 0.2 ? '#ff4444' : val < 0.4 ? '#ffaa00' : '#44ff88';
        c.fillStyle = col;
        c.beginPath(); c.roundRect(cx - bw/2, by + bh - bh * val, bw, bh * val, 3); c.fill();
        // Icon
        c.font = '13px sans-serif'; c.textAlign = 'center';
        c.fillStyle = danger ? '#ff4444' : '#aab';
        c.fillText(icon, cx, by - 2);
        // Label
        c.fillStyle = '#556070'; c.font = '8px monospace';
        c.fillText(lbl, cx, by + bh + 10);
    }

    // ── Public API ─────────────────────────────────────────────────────────
    startDriving()  { this.state.paused = false; this.state.targetSpeed = 50; }
    stopDriving()   { this.state.paused = true;  this.state.targetSpeed = 0; }
    togglePause()   { this.state.paused ? this.startDriving() : this.stopDriving(); }
    setWeather(w)   { this.state.weather = w; }
    jumpToSegment(idx) {
        if (typeof idx !== 'number' || idx < 0 || idx >= HYDERABAD_ROUTE.length) return;
        this.state.worldPos = idx * SEG_LENGTH_M + 5;
        this.state.routeIdx = idx;
        this.state.distance = this.state.worldPos / 1000;
    }
    injectFault(t) {
        const s = this.state;
        if (t === 'fuel')    { s.fuel = 0.08;        this._alert('FUEL', 'Fault injected: low fuel.', 'warning'); }
        if (t === 'temp')    { s.engineTemp = 0.92;  this._alert('TEMP', 'Fault injected: engine overheating.', 'critical'); }
        if (t === 'oil')     { s.oilPressure = 0.18; this._alert('OIL',  'Fault injected: low oil pressure.', 'critical'); }
        if (t === 'battery') { s.battery = 0.35;     this._alert('BATT', 'Fault injected: weak battery.', 'warning'); }
    }
    clearFault(t) {
        const s = this.state;
        // Restore the metric to a healthy value AND push the cooldown forward so the
        // alert stops firing immediately.
        const FAR_FUTURE = Date.now() + 60_000;
        if (t === 'fuel')    { s.fuel = 0.85;        s.lastFuelAlert     = FAR_FUTURE; }
        if (t === 'temp')    { s.engineTemp = 0.40;  s.lastTempAlert     = FAR_FUTURE; s.highSpeedSeconds = 0; }
        if (t === 'oil')     { s.oilPressure = 1.0;  s.lastOilAlert      = FAR_FUTURE; }
        if (t === 'battery') { s.battery = 1.0;      s.lastBattAlert     = FAR_FUTURE; }
        // Dismiss any active alert of this type
        if (s.activeAlert && s.activeAlert.type === t.toUpperCase()) {
            s.activeAlert = null;
            s.alertTimeout = 0;
        }
    }
    getState() { return { ...this.state }; }

    start() { this.running = true; this._lastTs = performance.now(); this._loop(); }
    stop()  { this.running = false; if (this._raf) cancelAnimationFrame(this._raf); }

    _loop() {
        if (!this.running) return;
        const now = performance.now();
        const dt = Math.min(0.1, (now - this._lastTs) / 1000);
        this._lastTs = now;
        this._update(dt);
        try { this._render(); } catch (e) { console.error('[DrivingGame] render error:', e); }
        this._raf = requestAnimationFrame(() => this._loop());
    }
}

window.DrivingGame = DrivingGame;
window.HYDERABAD_ROUTE = HYDERABAD_ROUTE;
