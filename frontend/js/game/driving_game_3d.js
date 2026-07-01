/**
 * CabinAI — Hyderabad/Gachibowli Driving Simulator (Three.js 3D port)
 *
 * Public API matches driving_game.js exactly so nothing else in main.js changes.
 *   start / stop / startDriving / stopDriving / togglePause
 *   setWeather / jumpToSegment / injectFault / clearFault / getState
 *   Bus: publishes GAME_STATE every 500ms and GAME_ALERT on faults.
 *        subscribes to FATIGUE_FORECAST, PERCEPTION_UPDATE, GESTURE_ACTION (via main.js).
 *
 * Three.js is loaded as a global from the local vendored UMD build (window.THREE).
 */
(function () {
'use strict';

const HYDERABAD_ROUTE = window.HYDERABAD_ROUTE || [
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
const ROUTE_TOTAL_M = SEG_LENGTH_M * HYDERABAD_ROUTE.length;
const ROAD_HALF_WIDTH = 4.5;
const NPC_COUNT = 18;

class DrivingGame3D {
    constructor(canvas, bus) {
        this.canvas = canvas;
        this.bus    = bus;
        this.running = false;
        this._raf   = null;
        this._keys  = {};

        this.state = {
            speed: 0, targetSpeed: 0, rpm: 800,
            fuel: 1.0, engineTemp: 0.30, oilPressure: 1.0, battery: 1.0,
            gear: 1, distance: 0,
            laneOffset: 0, worldPos: 0, routeIdx: 0, curvature: 0,
            time: 14.0, weather: 'clear',
            npcs: this._spawnNpcs(),
            activeAlert: null, alertTimeout: 0,
            lastFuelAlert: 0, lastTempAlert: 0, lastOilAlert: 0,
            lastBattAlert: 0, lastSpeedingAlert: 0, lastTunnelAlert: 0,
            lastNpcAlert: 0,
            highSpeedSeconds: 0,
            recommendedRest: '',
            paused: true,
        };
        this._lastTs = 0;
        this._lastPublish = 0;

        // 2D overlay canvas — drawn on top of the WebGL canvas each frame
        this._overlayCanvas = document.getElementById('game-overlay');
        this._overlayCtx = this._overlayCanvas ? this._overlayCanvas.getContext('2d') : null;

        if (typeof THREE === 'undefined') {
            console.error('[DrivingGame3D] THREE.js not loaded — falling back to 2D not handled here, set ?game=2d');
            return;
        }

        this._initScene();
        this._buildRoadAndWorld();
        this._setupInput();
        this._subscribeToAlerts();
        this._handleResize = this._onResize.bind(this);
        window.addEventListener('resize', this._handleResize);
        console.log('[DrivingGame3D] scene initialised OK — THREE r' + (THREE.REVISION || '?'));
    }

    // ── scene graph ────────────────────────────────────────────────────────

    _initScene() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color('#1565c0');
        this.scene.fog = new THREE.FogExp2(0x9bb6cf, 0.012);

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            powerPreference: 'high-performance',
        });
        this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this._onResize();

        this.camera = new THREE.PerspectiveCamera(
            55, this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight),
            0.5, 1200
        );

        this.sun = new THREE.DirectionalLight(0xfff2cf, 1.0);
        this.sun.position.set(80, 120, 60);
        this.scene.add(this.sun);

        this.hemi = new THREE.HemisphereLight(0xbbd5ff, 0x3a4030, 0.55);
        this.scene.add(this.hemi);

        this.tunnelAmbient = new THREE.AmbientLight(0xffe9a8, 0);
        this.scene.add(this.tunnelAmbient);

        this._buildSkyDome();

        const sunTex = this._makeRadialTexture('#ffefb0', '#ffffff', 0.4);
        this.sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: sunTex, color: 0xffffff, transparent: true,
            depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        this.sunSprite.scale.set(50, 50, 1);
        this.scene.add(this.sunSprite);
    }

    _onResize() {
        if (!this.renderer) return;
        const w = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 800;
        const h = this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || 480;
        this.canvas.width  = w * (window.devicePixelRatio || 1);
        this.canvas.height = h * (window.devicePixelRatio || 1);
        this.renderer.setSize(w, h, false);
        if (this.camera) {
            this.camera.aspect = w / Math.max(1, h);
            this.camera.updateProjectionMatrix();
        }
        // Sync overlay canvas pixel size
        if (this._overlayCanvas) {
            this._overlayCanvas.width  = w;
            this._overlayCanvas.height = h;
        }
    }

    _buildSkyDome() {
        const geo = new THREE.SphereGeometry(800, 24, 16);
        const mat = new THREE.ShaderMaterial({
            side: THREE.BackSide,
            depthWrite: false,
            uniforms: {
                topColor:    { value: new THREE.Color('#1565c0') },
                bottomColor: { value: new THREE.Color('#9bb6cf') },
                offset:      { value: 33 },
                exponent:    { value: 0.6 },
            },
            vertexShader: `
                varying vec3 vWorldPosition;
                void main() {
                    vec4 wp = modelMatrix * vec4(position, 1.0);
                    vWorldPosition = wp.xyz;
                    gl_Position = projectionMatrix * viewMatrix * wp;
                }`,
            fragmentShader: `
                uniform vec3 topColor;
                uniform vec3 bottomColor;
                uniform float offset;
                uniform float exponent;
                varying vec3 vWorldPosition;
                void main() {
                    float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
                    gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
                }`,
        });
        this.skyDome = new THREE.Mesh(geo, mat);
        this.scene.add(this.skyDome);
    }

    _makeRadialTexture(coreCol, edgeCol, edgeStop = 0.5) {
        const c = document.createElement('canvas'); c.width = c.height = 128;
        const ctx = c.getContext('2d');
        const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
        g.addColorStop(0,         coreCol);
        g.addColorStop(edgeStop,  edgeCol);
        g.addColorStop(1,         'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
    }

    _buildRoadAndWorld() {
        const points = [];
        const N = HYDERABAD_ROUTE.length;
        for (let i = 0; i < N; i++) {
            const t = i / N;
            const r = 220;
            const x = Math.cos(t * Math.PI * 2) * r + Math.sin(t * Math.PI * 4) * 60;
            const z = Math.sin(t * Math.PI * 2) * r + Math.cos(t * Math.PI * 6) * 40;
            points.push(new THREE.Vector3(x, 0, z));
        }
        this.routeCurve = new THREE.CatmullRomCurve3(points, true, 'catmullrom', 0.5);
        const totalLen = this.routeCurve.getLength();
        this._splineLengthScale = ROUTE_TOTAL_M / totalLen;

        // Dispose scratch tube geometry — we use the ribbon instead
        const tubeGeo = new THREE.TubeGeometry(this.routeCurve, N * 16, ROAD_HALF_WIDTH, 8, true);
        tubeGeo.dispose();

        this._buildRoadRibbon();
        this._buildGround();
        this._buildLaneMarkings();
        this._buildCityscape();
        this._buildSegmentProps();
        this._buildTunnel();
        this._buildNpcMeshes();
        this._buildWeatherParticles();
    }

    _buildRoadRibbon() {
        const samples = HYDERABAD_ROUTE.length * 32;
        const positions = [];
        const uvs       = [];
        const indices   = [];
        const W = ROAD_HALF_WIDTH;
        const tmpUp   = new THREE.Vector3(0, 1, 0);
        const tmpTan  = new THREE.Vector3();
        const tmpRight= new THREE.Vector3();
        const tmpP    = new THREE.Vector3();
        for (let i = 0; i <= samples; i++) {
            const u = i / samples;
            this.routeCurve.getPointAt(u, tmpP);
            this.routeCurve.getTangentAt(u, tmpTan);
            tmpRight.copy(tmpTan).cross(tmpUp).normalize();
            const lx = tmpP.x - tmpRight.x * W;
            const lz = tmpP.z - tmpRight.z * W;
            const rx = tmpP.x + tmpRight.x * W;
            const rz = tmpP.z + tmpRight.z * W;
            positions.push(lx, 0.02, lz);
            positions.push(rx, 0.02, rz);
            uvs.push(0, u * samples * 0.25);
            uvs.push(1, u * samples * 0.25);
            if (i < samples) {
                const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
                indices.push(a, b, c, b, d, c);
            }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
        geo.setIndex(indices);
        geo.computeVertexNormals();

        const asphaltTex = this._makeAsphaltTexture();
        asphaltTex.wrapS = asphaltTex.wrapT = THREE.RepeatWrapping;
        const mat = new THREE.MeshStandardMaterial({
            map: asphaltTex, roughness: 0.92, metalness: 0.05, color: 0xa8a8a8,
        });
        this.roadMesh = new THREE.Mesh(geo, mat);
        this.scene.add(this.roadMesh);
    }

    _makeAsphaltTexture() {
        const c = document.createElement('canvas'); c.width = c.height = 256;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#363b42'; ctx.fillRect(0, 0, 256, 256);
        for (let i = 0; i < 1800; i++) {
            const v = 40 + Math.floor(Math.random() * 40);
            ctx.fillStyle = `rgb(${v},${v},${v + 4})`;
            ctx.fillRect(Math.random() * 256, Math.random() * 256, 1.2, 1.2);
        }
        ctx.fillStyle = '#ffe14a';
        for (let y = 6; y < 256; y += 28) ctx.fillRect(125, y, 6, 16);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(2,  0, 1.5, 256);
        ctx.fillRect(252, 0, 1.5, 256);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        return tex;
    }

    _buildGround() {
        const g = new THREE.PlaneGeometry(2000, 2000, 1, 1);
        const m = new THREE.MeshStandardMaterial({
            color: 0x3d5a3d, roughness: 1.0, metalness: 0,
        });
        const ground = new THREE.Mesh(g, m);
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -0.05;
        this.scene.add(ground);
        this.ground = ground;
    }

    _buildLaneMarkings() {
        // Already painted into the asphalt texture via UV strip.
    }

    _buildCityscape() {
        const COUNT = 140;
        const boxGeo = new THREE.BoxGeometry(1, 1, 1);
        const litTex = this._makeBuildingTexture(true);
        const dayTex = this._makeBuildingTexture(false);
        const dayMat = new THREE.MeshStandardMaterial({
            map: dayTex, color: 0x9aa0aa, roughness: 0.85, metalness: 0.15,
        });
        const nightMat = new THREE.MeshStandardMaterial({
            map: litTex, color: 0x222530,
            emissive: 0xffeaa0, emissiveMap: litTex, emissiveIntensity: 0.6,
            roughness: 0.7, metalness: 0.2,
        });
        this.cityDay   = new THREE.InstancedMesh(boxGeo, dayMat,   COUNT);
        this.cityNight = new THREE.InstancedMesh(boxGeo, nightMat, COUNT);
        this.cityDay.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        this.cityNight.instanceMatrix.setUsage(THREE.StaticDrawUsage);

        const tmp = new THREE.Object3D();
        const tmpP = new THREE.Vector3();
        const tmpT = new THREE.Vector3();
        const up = new THREE.Vector3(0, 1, 0);
        const right = new THREE.Vector3();
        for (let i = 0; i < COUNT; i++) {
            const u = i / COUNT;
            this.routeCurve.getPointAt(u, tmpP);
            this.routeCurve.getTangentAt(u, tmpT);
            right.copy(tmpT).cross(up).normalize();
            const side = (i % 2 === 0) ? 1 : -1;
            const lateral = side * (12 + (i * 13.7) % 25);
            const x = tmpP.x + right.x * lateral;
            const z = tmpP.z + right.z * lateral;
            const w = 6 + ((i * 11.3) % 8);
            const d = 6 + ((i * 7.9)  % 8);
            const h = 8 + ((i * 23.4) % 35);
            tmp.position.set(x, h / 2, z);
            tmp.rotation.y = Math.atan2(tmpT.x, tmpT.z);
            tmp.scale.set(w, h, d);
            tmp.updateMatrix();
            this.cityDay.setMatrixAt(i, tmp.matrix);
            this.cityNight.setMatrixAt(i, tmp.matrix);
        }
        this.cityDay.instanceMatrix.needsUpdate = true;
        this.cityNight.instanceMatrix.needsUpdate = true;
        this.scene.add(this.cityDay);
        this.scene.add(this.cityNight);
        this.cityNight.visible = false;
    }

    _makeBuildingTexture(lit) {
        const c = document.createElement('canvas'); c.width = c.height = 128;
        const ctx = c.getContext('2d');
        ctx.fillStyle = lit ? '#0d1119' : '#5e6571';
        ctx.fillRect(0, 0, 128, 128);
        for (let y = 8; y < 128; y += 14) {
            for (let x = 6; x < 128; x += 12) {
                if (lit) {
                    ctx.fillStyle = Math.random() > 0.4
                        ? `rgba(255,${230 - Math.random() * 50},${120 + Math.random() * 60},${0.6 + Math.random() * 0.4})`
                        : 'rgba(20,25,30,0.95)';
                } else {
                    ctx.fillStyle = '#7a8290';
                }
                ctx.fillRect(x, y, 6, 9);
            }
        }
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
    }

    _buildSegmentProps() {
        this.propGroup = new THREE.Group();
        this.scene.add(this.propGroup);
        const tmpP = new THREE.Vector3();
        const tmpT = new THREE.Vector3();
        const up = new THREE.Vector3(0, 1, 0);
        const right = new THREE.Vector3();
        for (let i = 0; i < HYDERABAD_ROUTE.length; i++) {
            const seg = HYDERABAD_ROUTE[i];
            const u = i / HYDERABAD_ROUTE.length;
            this.routeCurve.getPointAt(u, tmpP);
            this.routeCurve.getTangentAt(u, tmpT);
            right.copy(tmpT).cross(up).normalize();
            const sx = tmpP.x + right.x * 7;
            const sz = tmpP.z + right.z * 7;
            const sign = this._buildPropForType(seg.type, seg);
            if (sign) {
                sign.position.set(sx, 0, sz);
                sign.lookAt(tmpP.x, sign.position.y, tmpP.z);
                this.propGroup.add(sign);
            }
            const bx = tmpP.x - right.x * 7;
            const bz = tmpP.z - right.z * 7;
            const bb = this._buildBillboard(seg.name, seg.color || '#3498db');
            bb.position.set(bx, 0, bz);
            bb.lookAt(tmpP.x, bb.position.y, tmpP.z);
            this.propGroup.add(bb);
        }
    }

    _buildPropForType(type, seg) {
        const g = new THREE.Group();
        if (type === 'parking') {
            const pole = new THREE.Mesh(
                new THREE.CylinderGeometry(0.06, 0.06, 2.4),
                new THREE.MeshStandardMaterial({ color: 0x555 }),
            ); pole.position.y = 1.2; g.add(pole);
            const sign = new THREE.Mesh(
                new THREE.PlaneGeometry(1.2, 1.2),
                new THREE.MeshStandardMaterial({
                    map: this._makeTextTexture('P', '#1a73e8', '#ffffff'),
                    side: THREE.DoubleSide, transparent: true,
                }),
            ); sign.position.y = 2.4; g.add(sign);
            return g;
        }
        if (type === 'gas') {
            const canopy = new THREE.Mesh(
                new THREE.BoxGeometry(4.0, 0.2, 3.0),
                new THREE.MeshStandardMaterial({ color: 0xf39c12 }),
            ); canopy.position.y = 3.2; g.add(canopy);
            const pole = new THREE.Mesh(
                new THREE.CylinderGeometry(0.1, 0.1, 3.2),
                new THREE.MeshStandardMaterial({ color: 0x34495e }),
            ); pole.position.y = 1.6; pole.position.x = -1.5; g.add(pole);
            const pump = new THREE.Mesh(
                new THREE.BoxGeometry(0.6, 1.2, 0.4),
                new THREE.MeshStandardMaterial({ color: 0xe74c3c }),
            ); pump.position.y = 0.6; pump.position.x = -1.5; g.add(pump);
            return g;
        }
        if (type === 'rest') {
            const treeT = new THREE.Mesh(
                new THREE.CylinderGeometry(0.15, 0.2, 1.6),
                new THREE.MeshStandardMaterial({ color: 0x4a3020 }),
            ); treeT.position.y = 0.8; g.add(treeT);
            const canopy = new THREE.Mesh(
                new THREE.SphereGeometry(1.2, 8, 6),
                new THREE.MeshStandardMaterial({ color: 0x2d8a2d, roughness: 1 }),
            ); canopy.position.y = 2.0; g.add(canopy);
            const bench = new THREE.Mesh(
                new THREE.BoxGeometry(1.6, 0.1, 0.4),
                new THREE.MeshStandardMaterial({ color: 0x7f8c8d }),
            ); bench.position.y = 0.55; bench.position.x = 1.2; g.add(bench);
            return g;
        }
        if (type === 'emergency') {
            const sosPole = new THREE.Mesh(
                new THREE.CylinderGeometry(0.06, 0.06, 2.6),
                new THREE.MeshStandardMaterial({ color: 0x555 }),
            ); sosPole.position.y = 1.3; g.add(sosPole);
            const sos = new THREE.Mesh(
                new THREE.PlaneGeometry(1.0, 0.5),
                new THREE.MeshStandardMaterial({
                    map: this._makeTextTexture('SOS', '#c0392b', '#ffffff'),
                    side: THREE.DoubleSide, transparent: true,
                }),
            ); sos.position.y = 2.5; g.add(sos);
            for (let i = 0; i < 3; i++) {
                const cone = new THREE.Mesh(
                    new THREE.ConeGeometry(0.25, 0.7, 8),
                    new THREE.MeshStandardMaterial({ color: 0xff2222 }),
                );
                cone.position.set(-1.5 + i * 0.7, 0.35, 0); g.add(cone);
            }
            return g;
        }
        if (type === 'urban') {
            const pole = new THREE.Mesh(
                new THREE.CylinderGeometry(0.05, 0.05, 2.2),
                new THREE.MeshStandardMaterial({ color: 0x3a3a3a }),
            ); pole.position.y = 1.1; g.add(pole);
            return g;
        }
        if (type === 'highway') {
            const post = new THREE.Mesh(
                new THREE.CylinderGeometry(0.07, 0.10, 5.0),
                new THREE.MeshStandardMaterial({ color: 0x444 }),
            ); post.position.y = 2.5; g.add(post);
            const arm = new THREE.Mesh(
                new THREE.BoxGeometry(1.2, 0.08, 0.08),
                new THREE.MeshStandardMaterial({ color: 0x444 }),
            ); arm.position.set(0.6, 4.95, 0); g.add(arm);
            const lamp = new THREE.Mesh(
                new THREE.BoxGeometry(0.4, 0.18, 0.25),
                new THREE.MeshStandardMaterial({
                    color: 0x222, emissive: 0xffe09a, emissiveIntensity: 0.0,
                }),
            ); lamp.position.set(1.1, 4.85, 0); g.add(lamp);
            g.userData.lampLight = lamp.material;
            return g;
        }
        return null;
    }

    _buildBillboard(text, color) {
        const g = new THREE.Group();
        const post = new THREE.Mesh(
            new THREE.CylinderGeometry(0.08, 0.08, 3.4),
            new THREE.MeshStandardMaterial({ color: 0x3a3a3a }),
        ); post.position.y = 1.7; g.add(post);
        const board = new THREE.Mesh(
            new THREE.PlaneGeometry(3.6, 1.4),
            new THREE.MeshStandardMaterial({
                map: this._makeTextTexture(text, color, '#ffffff'),
                side: THREE.DoubleSide, transparent: true,
            }),
        ); board.position.y = 4.0; g.add(board);
        return g;
    }

    _makeTextTexture(text, bg, fg) {
        const c = document.createElement('canvas');
        c.width = 512; c.height = 200;
        const ctx = c.getContext('2d');
        ctx.fillStyle = bg; ctx.fillRect(0, 0, 512, 200);
        ctx.fillStyle = fg;
        ctx.font = `bold ${text.length > 10 ? 38 : 64}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(text, 256, 100);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
    }

    _buildTunnel() {
        const tunnelIdx = HYDERABAD_ROUTE.findIndex(s => s.type === 'tunnel');
        if (tunnelIdx < 0) return;
        const tmpP = new THREE.Vector3();
        const tmpT = new THREE.Vector3();
        const up = new THREE.Vector3(0, 1, 0);
        const right = new THREE.Vector3();
        const TUNNEL_HALF_LEN = SEG_LENGTH_M / 2 / this._splineLengthScale;
        const uMid = tunnelIdx / HYDERABAD_ROUTE.length;
        const segments = 24;
        const group = new THREE.Group();
        const wallMat = new THREE.MeshStandardMaterial({
            color: 0x303843, roughness: 1.0, metalness: 0.05,
        });
        const lightMat = new THREE.MeshStandardMaterial({
            color: 0x222, emissive: 0xffe9a8, emissiveIntensity: 1.6,
        });

        for (let i = 0; i < segments; i++) {
            const u = (uMid - TUNNEL_HALF_LEN) + (TUNNEL_HALF_LEN * 2) * (i / segments);
            const uClamped = ((u % 1) + 1) % 1;
            this.routeCurve.getPointAt(uClamped, tmpP);
            this.routeCurve.getTangentAt(uClamped, tmpT);
            right.copy(tmpT).cross(up).normalize();
            const bxL = new THREE.Mesh(
                new THREE.BoxGeometry(0.5, 5, SEG_LENGTH_M / segments / this._splineLengthScale * 1.2),
                wallMat,
            );
            bxL.position.set(tmpP.x - right.x * (ROAD_HALF_WIDTH + 0.4), 2.5,
                              tmpP.z - right.z * (ROAD_HALF_WIDTH + 0.4));
            bxL.lookAt(tmpP.x + tmpT.x, 2.5, tmpP.z + tmpT.z);
            group.add(bxL);
            const bxR = bxL.clone();
            bxR.position.set(tmpP.x + right.x * (ROAD_HALF_WIDTH + 0.4), 2.5,
                              tmpP.z + right.z * (ROAD_HALF_WIDTH + 0.4));
            bxR.lookAt(tmpP.x + tmpT.x, 2.5, tmpP.z + tmpT.z);
            group.add(bxR);
            const ceil = new THREE.Mesh(
                new THREE.BoxGeometry(ROAD_HALF_WIDTH * 2 + 1, 0.4,
                                      SEG_LENGTH_M / segments / this._splineLengthScale * 1.2),
                wallMat,
            );
            ceil.position.set(tmpP.x, 5.0, tmpP.z);
            ceil.lookAt(tmpP.x + tmpT.x, 5.0, tmpP.z + tmpT.z);
            group.add(ceil);
            if (i % 2 === 0) {
                const strip = new THREE.Mesh(
                    new THREE.BoxGeometry(2.5, 0.1, 0.4),
                    lightMat,
                );
                strip.position.set(tmpP.x, 4.85, tmpP.z);
                strip.lookAt(tmpP.x + tmpT.x, 4.85, tmpP.z + tmpT.z);
                group.add(strip);
            }
        }
        this.scene.add(group);
        this.tunnelGroup = group;
    }

    _buildNpcMeshes() {
        this.npcMeshes = [];
        const colors = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#ecf0f1'];
        for (let i = 0; i < NPC_COUNT; i++) {
            const colHex = colors[i % colors.length];
            const isAuto  = i % 7 === 0;
            const isTruck = i % 5 === 0 && !isAuto;
            const g = new THREE.Group();
            const bodyW = isTruck ? 2.0 : isAuto ? 1.4 : 1.7;
            const bodyL = isTruck ? 5.0 : isAuto ? 2.4 : 3.6;
            const bodyH = isTruck ? 1.8 : isAuto ? 1.3 : 1.1;
            const body = new THREE.Mesh(
                new THREE.BoxGeometry(bodyW, bodyH, bodyL),
                new THREE.MeshStandardMaterial({
                    color: new THREE.Color(isAuto ? '#f1c40f' : colHex),
                    roughness: 0.4, metalness: 0.5,
                }),
            );
            body.position.y = bodyH / 2 + 0.25;
            g.add(body);
            const cabin = new THREE.Mesh(
                isAuto ? new THREE.SphereGeometry(0.7, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2)
                       : new THREE.BoxGeometry(bodyW * 0.86, bodyH * 0.7, bodyL * 0.55),
                new THREE.MeshStandardMaterial({
                    color: isAuto ? '#f1c40f' : 0x222a32,
                    roughness: 0.3, metalness: 0.7,
                    emissive: 0x000010,
                }),
            );
            if (isAuto) cabin.position.y = bodyH + 0.25;
            else        cabin.position.y = bodyH + 0.05 + bodyH * 0.35;
            g.add(cabin);
            const tailMat = new THREE.MeshStandardMaterial({
                color: 0xff2222, emissive: 0xff2222, emissiveIntensity: 0.7,
            });
            const tailGeo = new THREE.BoxGeometry(0.25, 0.18, 0.05);
            const tailL = new THREE.Mesh(tailGeo, tailMat);
            const tailR = new THREE.Mesh(tailGeo, tailMat);
            tailL.position.set(-bodyW * 0.35, 0.8, -bodyL / 2 - 0.03);
            tailR.position.set( bodyW * 0.35, 0.8, -bodyL / 2 - 0.03);
            g.add(tailL); g.add(tailR);
            const whGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.25, 12);
            whGeo.rotateZ(Math.PI / 2);
            const whMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.95 });
            for (const [wx, wz] of [
                [-bodyW * 0.45, -bodyL * 0.3],
                [ bodyW * 0.45, -bodyL * 0.3],
                [-bodyW * 0.45,  bodyL * 0.3],
                [ bodyW * 0.45,  bodyL * 0.3],
            ]) {
                const wh = new THREE.Mesh(whGeo, whMat);
                wh.position.set(wx, 0.32, wz);
                g.add(wh);
            }
            this.scene.add(g);
            this.npcMeshes.push(g);
        }
    }

    _buildWeatherParticles() {
        const COUNT = 3500;
        const positions = new Float32Array(COUNT * 3);
        for (let i = 0; i < COUNT; i++) {
            positions[i * 3 + 0] = (Math.random() - 0.5) * 80;
            positions[i * 3 + 1] = Math.random() * 30;
            positions[i * 3 + 2] = (Math.random() - 0.5) * 80;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const mat = new THREE.PointsMaterial({
            color: 0xb0c4ff, size: 0.06, transparent: true, opacity: 0.7,
            depthWrite: false,
        });
        this.rain = new THREE.Points(geo, mat);
        this.rain.visible = false;
        this.scene.add(this.rain);
    }

    // ── 2D overlay (dashboard + HUD drawn every frame on #game-overlay) ────

    _drawOverlay() {
        const c = this._overlayCtx;
        if (!c) return;
        const canvas = this._overlayCanvas;

        // Sync size to the WebGL canvas's CSS size
        const cw = this.canvas.clientWidth  || 800;
        const ch = this.canvas.clientHeight || 480;
        if (canvas.width !== cw || canvas.height !== ch) {
            canvas.width  = cw;
            canvas.height = ch;
        }

        c.clearRect(0, 0, cw, ch);

        const s = this.state;

        // ── Pause screen overlay ──────────────────────────────────────────
        if (s.paused) {
            c.fillStyle = 'rgba(0,0,0,0.62)';
            c.fillRect(0, 0, cw, ch);
            c.fillStyle = '#0af'; c.font = `bold ${Math.round(cw * 0.032)}px monospace`;
            c.textAlign = 'center';
            c.fillText('GACHIBOWLI · HYDERABAD DRIVE SIM', cw / 2, ch / 2 - ch * 0.07);
            c.fillStyle = '#44ff88'; c.font = `${Math.round(cw * 0.022)}px monospace`;
            c.fillText('Press START or ↑ to begin driving', cw / 2, ch / 2 - ch * 0.02);
            c.fillStyle = '#aab2c2'; c.font = `${Math.round(cw * 0.018)}px monospace`;
            c.fillText('↑ Accelerate · ↓ Brake · ← → Steer', cw / 2, ch / 2 + ch * 0.03);
        }

        // ── Dashboard — bottom 110 px strip ──────────────────────────────
        this._renderDashboardOverlay(c, cw, ch);

        // ── HUD — top portion ─────────────────────────────────────────────
        this._renderHudOverlay(c, cw, ch);
    }

    _renderDashboardOverlay(c, cw, ch) {
        const s = this.state;
        const seg = HYDERABAD_ROUTE[s.routeIdx % HYDERABAD_ROUTE.length];
        const DASH_H = 110;
        const dy = ch - DASH_H;

        // Background bar
        const bg = c.createLinearGradient(0, dy, 0, ch);
        bg.addColorStop(0, 'rgba(16,19,26,0.92)');
        bg.addColorStop(1, 'rgba(5,7,11,0.97)');
        c.fillStyle = bg;
        c.fillRect(0, dy, cw, DASH_H);
        c.strokeStyle = '#0af'; c.lineWidth = 1.5;
        c.strokeRect(0, dy, cw, DASH_H);

        const cy = dy + DASH_H / 2;

        // Speed gauge
        const gaugeR = Math.min(42, DASH_H * 0.38);
        const speedX = gaugeR + 20;
        this._tDrawGauge(c, speedX, cy, gaugeR, s.speed, 0, 200, 'SPEED',
            `${Math.round(s.speed)}`, 'km/h',
            s.speed > seg.speed + 15 ? '#ff4444' :
            s.speed > seg.speed       ? '#ffaa00' : '#0af');

        // RPM gauge
        const rpmX = speedX + gaugeR + 60;
        this._tDrawGauge(c, rpmX, cy, gaugeR * 0.82, s.rpm, 0, 7000, 'RPM',
            `${(s.rpm / 1000).toFixed(1)}`, 'x1k',
            s.rpm > 5500 ? '#ff4444' : s.rpm > 3500 ? '#ffaa00' : '#44ff88');

        // Gear box
        const gearX = rpmX + gaugeR + 50;
        c.fillStyle = '#0a0e16';
        c.fillRect(gearX - 28, cy - 28, 56, 56);
        c.strokeStyle = '#1e2535'; c.lineWidth = 1;
        c.strokeRect(gearX - 28, cy - 28, 56, 56);
        c.fillStyle = '#0af'; c.font = 'bold 32px monospace'; c.textAlign = 'center';
        c.fillText(s.gear, gearX, cy + 10);
        c.fillStyle = '#556070'; c.font = '11px monospace';
        c.fillText('GEAR', gearX, cy + 28);

        // 4 bars: FUEL, COOLANT, OIL PSI, 12V BAT
        const barStart = gearX + 42;
        const barCfg = [
            ['FUEL',    s.fuel,        '⛽', s.fuel < 0.15,        '#2ecc71', false],
            ['COOLANT', s.engineTemp,  '🌡', s.engineTemp > 0.85,  '#e74c3c', true ],
            ['OIL PSI', s.oilPressure, '🛢', s.oilPressure < 0.4,  '#f39c12', false],
            ['12V BAT', s.battery,     '🔋', s.battery < 0.5,      '#3498db', false],
        ];
        for (let i = 0; i < barCfg.length; i++) {
            const bx = barStart + i * 52;
            const [lbl, val, icon, danger, accent, highBad] = barCfg[i];
            this._tDrawBar(c, bx, cy, lbl, val, icon, danger, accent, highBad);
        }

        // Segment info + status
        const indX = barStart + barCfg.length * 52 + 18;
        c.fillStyle = '#aab'; c.font = '11px monospace'; c.textAlign = 'left';
        c.fillText(seg.name.toUpperCase().slice(0, 26), indX, dy + 18);
        c.fillStyle = s.paused ? '#ffaa00' : '#44ff88'; c.font = 'bold 14px monospace';
        c.fillText(s.paused ? '⏸ PAUSED' : '▶ DRIVING', indX, dy + 36);
        c.fillStyle = '#778899'; c.font = '11px monospace';
        c.fillText(`${s.distance.toFixed(1)} km · ${seg.type}`, indX, dy + 52);
        c.fillStyle = '#aab';
        c.fillText(`limit: ${seg.speed} km/h`, indX, dy + 66);

        // Warning icons
        let wx = indX;
        const warningY = dy + 88;
        c.font = '18px sans-serif';
        if (s.fuel < 0.15)        { c.fillStyle = '#ff8800'; c.fillText('⛽', wx, warningY); wx += 28; }
        if (s.engineTemp > 0.85)  { c.fillStyle = '#ff4444'; c.fillText('🌡', wx, warningY); wx += 28; }
        if (s.oilPressure < 0.4)  { c.fillStyle = '#ffaa00'; c.fillText('🛢', wx, warningY); wx += 28; }
        if (s.battery < 0.5)      { c.fillStyle = '#0af';    c.fillText('🔋', wx, warningY); wx += 28; }
        if (seg.type === 'tunnel'){ c.fillStyle = '#9b59b6'; c.fillText('💡', wx, warningY); wx += 28; }
        if (s.weather !== 'clear'){ c.fillStyle = '#3498db';
            c.fillText(s.weather === 'rain' ? '🌧' : '🌫', wx, warningY); }

        // Turn signal indicators
        const blink = Math.floor(Date.now() / 300) % 2 === 0;
        c.font = '18px sans-serif'; c.textAlign = 'center';
        c.fillStyle = ((this._keys['ArrowLeft']  || this._keys['KeyA']) && blink) ? '#44ff88' : '#1e2535';
        c.fillText('◀', 14, ch - 8);
        c.fillStyle = ((this._keys['ArrowRight'] || this._keys['KeyD']) && blink) ? '#44ff88' : '#1e2535';
        c.fillText('▶', cw - 14, ch - 8);
    }

    _renderHudOverlay(c, cw, ch) {
        const s = this.state;
        const seg = HYDERABAD_ROUTE[s.routeIdx % HYDERABAD_ROUTE.length];

        // Location pill (top-centre)
        const pillW = Math.min(420, cw * 0.5);
        c.fillStyle = 'rgba(0,0,0,0.78)';
        c.fillRect(cw / 2 - pillW / 2, 12, pillW, 46);
        c.strokeStyle = seg.color || '#3498db'; c.lineWidth = 2.5;
        c.strokeRect(cw / 2 - pillW / 2, 12, pillW, 46);
        c.fillStyle = seg.color || '#3498db';
        c.font = 'bold 18px monospace'; c.textAlign = 'center';
        c.fillText(`📍 ${seg.name}`, cw / 2, 42);

        // Speed limit sign (top-left)
        c.fillStyle = '#fff'; c.strokeStyle = '#c00'; c.lineWidth = 5;
        c.beginPath(); c.arc(52, 52, 34, 0, Math.PI * 2); c.fill(); c.stroke();
        c.fillStyle = '#000'; c.font = 'bold 22px monospace'; c.textAlign = 'center';
        c.fillText(seg.speed, 52, 60);
        c.fillStyle = '#666'; c.font = '12px monospace';
        c.fillText('km/h', 52, 96);

        // Minimap (top-right)
        const mmW = Math.min(200, cw * 0.22);
        const mmH = Math.min(180, mmW * 0.9);
        const mx = cw - mmW - 10;
        const my = 10;
        c.fillStyle = 'rgba(0,0,0,0.78)'; c.fillRect(mx, my, mmW, mmH);
        c.strokeStyle = '#0af'; c.lineWidth = 1.5; c.strokeRect(mx, my, mmW, mmH);
        c.fillStyle = '#0af'; c.font = '11px monospace'; c.textAlign = 'center';
        c.fillText('HYDERABAD ROUTE', mx + mmW / 2, my + 16);
        const total = HYDERABAD_ROUTE.length;
        const cols = 4;
        for (let i = 0; i < total; i++) {
            const rt = HYDERABAD_ROUTE[i];
            const px = mx + 14 + (i % cols) * ((mmW - 28) / (cols - 1));
            const py = my + 34 + Math.floor(i / cols) * 22;
            c.fillStyle = rt.color || '#3498db';
            c.beginPath(); c.arc(px, py, 5, 0, Math.PI * 2); c.fill();
        }
        const ci = s.routeIdx % total;
        const ppx = mx + 14 + (ci % cols) * ((mmW - 28) / (cols - 1));
        const ppy = my + 34 + Math.floor(ci / cols) * 22;
        c.fillStyle = '#fff'; c.strokeStyle = '#44ff88'; c.lineWidth = 3;
        c.beginPath(); c.arc(ppx, ppy, 7, 0, Math.PI * 2); c.fill(); c.stroke();
        c.fillStyle = '#aab'; c.font = '11px monospace'; c.textAlign = 'left';
        const hh = Math.floor(s.time);
        const mm = Math.floor((s.time % 1) * 60);
        c.fillText(`${s.distance.toFixed(1)} km`, mx + 8, my + mmH - 20);
        c.fillText(`${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`, mx + 8, my + mmH - 6);

        // Active alert banner — compact pill, not full-width box
        if (s.activeAlert) {
            const a = s.activeAlert;
            const col = a.sev === 'critical' ? '#ff4444' : a.sev === 'warning' ? '#ffaa00' : '#0af';
            const bgcol = a.sev === 'critical' ? 'rgba(70,0,0,0.88)' :
                          a.sev === 'warning'  ? 'rgba(55,35,0,0.88)' : 'rgba(0,25,50,0.88)';
            // Compact: auto-width based on text, max 70% of canvas width
            c.font = 'bold 12px monospace';
            const label = '⚠ ' + a.type + ': ' + a.msg.slice(0, 60);
            const tw = c.measureText(label).width;
            const aw = Math.min(tw + 24, cw * 0.70);
            const ax = cw / 2 - aw / 2;
            const alertY = 68;
            const ah = 32;
            c.fillStyle = bgcol; c.strokeStyle = col; c.lineWidth = 1.5;
            c.fillRect(ax, alertY, aw, ah);
            c.strokeRect(ax, alertY, aw, ah);
            c.fillStyle = col; c.textAlign = 'center';
            c.fillText(label, cw / 2, alertY + ah * 0.65);
        }

        // Rest recommendation pill
        if (s.recommendedRest && !s.paused) {
            const ry = s.activeAlert ? 168 : 72;
            const rw = Math.min(520, cw * 0.62);
            c.fillStyle = 'rgba(0,40,20,0.85)';
            c.fillRect(cw / 2 - rw / 2, ry, rw, 30);
            c.fillStyle = '#44ff88'; c.font = '14px monospace'; c.textAlign = 'center';
            c.fillText('🛏 ' + s.recommendedRest.slice(0, 58), cw / 2, ry + 20);
        }
    }

    _tDrawGauge(c, cx, cy, r, val, min, max, lbl, valTxt, unit, color) {
        const pct = Math.max(0, Math.min(1, (val - min) / (max - min)));
        const sa = Math.PI * 0.75, ea = Math.PI * 2.25;
        const ca = sa + (ea - sa) * pct;
        c.beginPath(); c.arc(cx, cy, r, sa, ea); c.strokeStyle = '#1e2535'; c.lineWidth = 8; c.stroke();
        c.beginPath(); c.arc(cx, cy, r, sa, ca); c.strokeStyle = color;
        c.lineWidth = 8; c.lineCap = 'round'; c.stroke();
        c.beginPath(); c.arc(cx, cy, r - 11, 0, Math.PI * 2);
        c.fillStyle = 'rgba(0,0,0,0.4)'; c.fill();
        c.fillStyle = color; c.font = `bold ${Math.floor(r * 0.5)}px monospace`;
        c.textAlign = 'center'; c.fillText(valTxt, cx, cy + 6);
        c.fillStyle = '#778899'; c.font = `${Math.floor(r * 0.24)}px monospace`;
        c.fillText(unit, cx, cy + r * 0.52);
        c.fillText(lbl, cx, cy - r - 6);
    }

    _tDrawBar(c, cx, cy, lbl, val, icon, danger, accent, highIsBad) {
        const bh = 72, bw = 20;
        const by = cy - bh / 2;
        c.fillStyle = '#15192a';
        c.fillRect(cx - bw / 2, by, bw, bh);
        const health = highIsBad ? (1 - val) : val;
        const col = health < 0.2 ? '#ff4444' : health < 0.4 ? '#ffaa00' : (accent || '#44ff88');
        c.fillStyle = col;
        c.fillRect(cx - bw / 2, by + bh - bh * val, bw, bh * val);
        c.strokeStyle = 'rgba(255,255,255,0.2)'; c.lineWidth = 1;
        const tickY = by + bh - bh * (highIsBad ? 0.85 : 0.2);
        c.beginPath(); c.moveTo(cx - bw / 2, tickY); c.lineTo(cx + bw / 2, tickY); c.stroke();
        c.font = '16px sans-serif'; c.textAlign = 'center';
        c.fillStyle = danger ? '#ff4444' : (accent || '#aab');
        c.fillText(icon, cx, by - 3);
        c.fillStyle = danger ? '#ff6666' : '#8893a5'; c.font = '10px monospace';
        c.fillText(lbl, cx, by + bh + 14);
    }

    // ── input + bus ────────────────────────────────────────────────────────

    _spawnNpcs() {
        const colors = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#ecf0f1'];
        return Array.from({ length: NPC_COUNT }, (_, i) => ({
            pos: 200 + i * 280,
            lane: ((i * 7) % 3) - 1,
            speed: 40 + Math.random() * 60,
            color: colors[i % colors.length],
            type: i % 5 === 0 ? 'truck' : (i % 7 === 0 ? 'auto' : 'car'),
        }));
    }

    _setupInput() {
        this._keydownHandler = e => {
            const tab1 = document.getElementById('tab1');
            if (!tab1 || !tab1.classList.contains('active')) return;
            const tag = (e.target?.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
            this._keys[e.code] = true;
            if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) {
                e.preventDefault();
            }
        };
        this._keyupHandler = e => { this._keys[e.code] = false; };
        window.addEventListener('keydown', this._keydownHandler);
        window.addEventListener('keyup',   this._keyupHandler);
    }

    _subscribeToAlerts() {
        this.bus.subscribe('FATIGUE_FORECAST', d => {
            const r = d?.enriched_system_prompt?.recommended_rest;
            if (r) this.state.recommendedRest = r;
        });
        this.bus.subscribe('PERCEPTION_UPDATE', d => {
            if (d?.drowsiness_score > 0.7 && !this.state.paused)
                this._alert('DROWSY', 'Drowsiness detected — pull over at next rest area!', 'critical');
        });
    }

    _alert(type, msg, sev) {
        this.state.activeAlert  = { type, msg, sev };
        this.state.alertTimeout = 6;
        this.bus.publish('GAME_ALERT', { type, msg, severity: sev });
        if (window.playAlertBeep) window.playAlertBeep(sev);
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

    // ── physics ────────────────────────────────────────────────────────────

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

        if (s.speed > 100) s.highSpeedSeconds += dt;
        else s.highSpeedSeconds = Math.max(0, s.highSpeedSeconds - dt * 0.5);

        // Engine temp: only accumulate heat when engine is actually turning
        const engineRunning = s.speed > 0;
        const rpmHeat     = engineRunning ? (s.rpm / 7000) * 0.045 : 0;
        const sustainHeat = engineRunning ? Math.min(0.06, s.highSpeedSeconds * 0.0015) : 0;
        const coolRate    = 0.012 + (1 - s.rpm / 7000) * 0.05 + (s.speed < 40 ? 0.03 : 0);
        s.engineTemp = Math.max(0.30, Math.min(1.0,
            s.engineTemp + (rpmHeat + sustainHeat - coolRate) * dt));

        // Fuel
        const fuelBurn = (0.0015 + (s.speed / 120) * 0.006 + (s.rpm / 7000) * 0.004);
        s.fuel = Math.max(0, s.fuel - fuelBurn * dt);

        // Oil pressure — inside paused guard so no change when stopped
        if (s.engineTemp > 0.80 || s.rpm > 6000)
            s.oilPressure = Math.max(0.15, s.oilPressure - 0.03 * dt);
        else
            s.oilPressure = Math.min(1.0, s.oilPressure + 0.01 * dt);

        // Battery — inside paused guard so no change when stopped
        if (s.rpm > 1500) s.battery = Math.min(1.0, s.battery + 0.004 * dt);
        else              s.battery = Math.max(0.30, s.battery - 0.002 * dt);

        s.worldPos += (s.speed / 3.6) * dt;
        s.distance = s.worldPos / 1000;
        s.routeIdx = Math.floor(s.worldPos / SEG_LENGTH_M) % HYDERABAD_ROUTE.length;
        s.curvature = Math.sin(s.worldPos / 800) * 0.045;
        s.time = (s.time + dt / 180) % 24;

        for (const npc of s.npcs) npc.pos += (npc.speed / 3.6) * dt;

        if (s.alertTimeout > 0) s.alertTimeout -= dt; else s.activeAlert = null;

        // All fault alerts gated to car moving (!s.paused is already ensured at top of _update)
        const now = Date.now();
        if (s.fuel < 0.15 && now - s.lastFuelAlert > 30000) {
            s.lastFuelAlert = now;
            // Find nearest gas/parking segment ahead from current position
            const cur = s.routeIdx;
            let nearestFuel = 'nearest fuel station';
            let nearestDist = 0;
            for (let off = 1; off <= HYDERABAD_ROUTE.length; off++) {
                const seg2 = HYDERABAD_ROUTE[(cur + off) % HYDERABAD_ROUTE.length];
                if (seg2.type === 'gas' || seg2.type === 'parking') {
                    nearestFuel = seg2.name;
                    nearestDist = (off * SEG_LENGTH_M / 1000).toFixed(1);
                    break;
                }
            }
            this._alert('FUEL', `Low fuel! Nearest stop: ${nearestFuel} (${nearestDist} km).`, 'warning');
        }
        if (s.engineTemp > 0.85 && now - s.lastTempAlert > 18000) {
            s.lastTempAlert = now;
            this._alert('TEMP', 'Engine overheating! Slow down, head to Biodiversity Junction.', 'critical');
        }
        if (s.oilPressure < 0.4 && now - s.lastOilAlert > 25000) {
            s.lastOilAlert = now;
            const cur = s.routeIdx;
            let nearestEmerg = 'ORR Emergency Bay';
            for (let off = 1; off <= HYDERABAD_ROUTE.length; off++) {
                const seg2 = HYDERABAD_ROUTE[(cur + off) % HYDERABAD_ROUTE.length];
                if (seg2.type === 'emergency' || seg2.type === 'parking') {
                    nearestEmerg = seg2.name;
                    break;
                }
            }
            this._alert('OIL', `Low oil pressure! Pull over at ${nearestEmerg}.`, 'critical');
        }
        if (s.battery < 0.5 && now - s.lastBattAlert > 25000) {
            s.lastBattAlert = now;
            const cur = s.routeIdx;
            let nearestService = 'Hi-Tech City';
            for (let off = 1; off <= HYDERABAD_ROUTE.length; off++) {
                const seg2 = HYDERABAD_ROUTE[(cur + off) % HYDERABAD_ROUTE.length];
                if (seg2.type === 'parking' || seg2.type === 'urban') {
                    nearestService = seg2.name;
                    break;
                }
            }
            this._alert('BATT', `12V battery weak — drive to ${nearestService} service.`, 'warning');
        }
        if (s.speed > seg.speed + 15 && now - s.lastSpeedingAlert > 12000) {
            s.lastSpeedingAlert = now;
            this._alert('SPEED', `Speeding in ${seg.name}! Limit ${seg.speed} km/h.`, 'warning');
        }
        if (seg.type === 'tunnel' && now - s.lastTunnelAlert > 15000) {
            s.lastTunnelAlert = now;
            this._alert('TUNNEL', 'Entering Durgam Cheruvu tunnel — headlights ON.', 'advisory');
        }

        // NPC proximity alert — use spline positions directly (mesh positions
        // are set in _updateNpcs which runs AFTER _update, so check the spline).
        if (s.speed > 5 && now - s.lastNpcAlert > 12000 && this.routeCurve) {
            const playerU = ((s.worldPos % ROUTE_TOTAL_M) / ROUTE_TOTAL_M + 1) % 1;
            const pPos = this.routeCurve.getPointAt(playerU);
            for (const npc of s.npcs) {
                const npcU = ((npc.pos % ROUTE_TOTAL_M) / ROUTE_TOTAL_M + 1) % 1;
                const distAhead = ((npcU - playerU + 1) % 1) * ROUTE_TOTAL_M;
                // Only check NPCs that are close ahead (0–12m) or behind (0–6m)
                if (distAhead > 12 && distAhead < ROUTE_TOTAL_M - 6) continue;
                const npcP = this.routeCurve.getPointAt(npcU);
                const dx = npcP.x - pPos.x;
                const dz = npcP.z - pPos.z;
                if (dx * dx + dz * dz < 81) { // 9m radius
                    s.lastNpcAlert = now;
                    this._alert('NPC', 'Vehicle close — check your following distance!', 'advisory');
                    break;
                }
            }
        }

        if (now - this._lastPublish > 500) {
            this._lastPublish = now;
            this._publishLiveState();
        }
    }

    // ── camera + dynamic scene ─────────────────────────────────────────────

    _updateCameraFromState() {
        const s = this.state;
        const totalU = (s.worldPos / ROUTE_TOTAL_M) % 1;
        const u = ((totalU % 1) + 1) % 1;
        const tmpP = new THREE.Vector3();
        const tmpT = new THREE.Vector3();
        const right = new THREE.Vector3();
        this.routeCurve.getPointAt(u, tmpP);
        this.routeCurve.getTangentAt(u, tmpT);
        right.copy(tmpT).cross(new THREE.Vector3(0, 1, 0)).normalize();

        // Camera preset: 'cockpit' (default), 'hood', 'chase'
        const preset = this._camPreset || 'cockpit';
        let height, lookAheadM, lateralScale;
        if (preset === 'hood') {
            height = 0.6; lookAheadM = 12; lateralScale = 1.0;
        } else if (preset === 'chase') {
            // Chase cam: behind and above the car
            const behind = tmpT.clone().multiplyScalar(-10);
            this.camera.position.set(
                tmpP.x + behind.x + right.x * (s.laneOffset * 1.5),
                4.5,
                tmpP.z + behind.z + right.z * (s.laneOffset * 1.5),
            );
            const lookAt = new THREE.Vector3(
                tmpP.x + tmpT.x * 5,
                1.0,
                tmpP.z + tmpT.z * 5,
            );
            this.camera.lookAt(lookAt);
            return;
        } else {
            // cockpit (default) — driver's eye level
            height = 1.6; lookAheadM = 14; lateralScale = 1.2;
        }

        this.camera.position.set(
            tmpP.x + right.x * (s.laneOffset * lateralScale),
            height,
            tmpP.z + right.z * (s.laneOffset * lateralScale),
        );
        const lookAt = new THREE.Vector3(
            tmpP.x + tmpT.x * lookAheadM + right.x * (s.laneOffset * 0.4),
            height * 0.9,
            tmpP.z + tmpT.z * lookAheadM + right.z * (s.laneOffset * 0.4),
        );
        // lookAt resets the quaternion cleanly — then add a small steering bank.
        this.camera.lookAt(lookAt);
        // Bank into the turn: rotateZ on a fresh lookAt is safe (no accumulation).
        this.camera.rotateZ(-s.laneOffset * 0.03);
    }

    setCamPreset(preset) {
        this._camPreset = preset; // 'cockpit' | 'hood' | 'chase'
    }

    _updateNpcs() {
        const tmpP = new THREE.Vector3();
        const tmpT = new THREE.Vector3();
        const up = new THREE.Vector3(0, 1, 0);
        const right = new THREE.Vector3();
        const playerU = (this.state.worldPos % ROUTE_TOTAL_M) / ROUTE_TOTAL_M;
        for (let i = 0; i < this.state.npcs.length; i++) {
            const n = this.state.npcs[i];
            const m = this.npcMeshes[i];
            if (!m) continue;
            const npcU = ((n.pos % ROUTE_TOTAL_M) / ROUTE_TOTAL_M + 1) % 1;
            const distAhead = ((npcU - playerU + 1) % 1) * ROUTE_TOTAL_M;
            if (distAhead > 250 && distAhead < ROUTE_TOTAL_M - 30) {
                m.visible = false; continue;
            }
            m.visible = true;
            this.routeCurve.getPointAt(npcU, tmpP);
            this.routeCurve.getTangentAt(npcU, tmpT);
            right.copy(tmpT).cross(up).normalize();
            // Lane offset: -1/0/+1 maps to ±2.5m within the 4.5m half-road
            const lateral = n.lane * 2.5;
            m.position.set(
                tmpP.x + right.x * lateral,
                0.35,   // sit just on the road surface
                tmpP.z + right.z * lateral,
            );
            // lookAt along the tangent direction so NPC faces forward on the curve
            m.lookAt(
                m.position.x + tmpT.x,
                m.position.y,
                m.position.z + tmpT.z,
            );
        }
    }

    _updateLightingForTime() {
        const hour = this.state.time;
        const isDay = hour >= 6 && hour < 19;
        const tDay = (hour - 6) / 13;
        const az = (isDay ? tDay : (hour >= 19 ? (hour - 19) / 11 : (hour + 5) / 11)) * Math.PI;
        const alt = isDay ? Math.sin(tDay * Math.PI) * 0.9 : -0.2;
        const r = 200;
        this.sun.position.set(Math.cos(az) * r, Math.max(20, alt * 200), Math.sin(az) * r);
        this.sun.intensity = isDay ? 1.0 : 0.05;
        this.hemi.intensity = isDay ? 0.55 : 0.2;
        this.sunSprite.position.copy(this.sun.position).multiplyScalar(0.85);
        this.sunSprite.material.color.set(isDay ? 0xfff2cf : 0xd0d8f0);

        if (this.skyDome) {
            let topCol, botCol, fogCol;
            if      (hour >= 6  && hour < 9)  { topCol = '#ff9a56'; botCol = '#ffd89b'; fogCol = '#e8c280'; }
            else if (hour >= 9  && hour < 18) { topCol = '#1565c0'; botCol = '#9bb6cf'; fogCol = '#a3b8ce'; }
            else if (hour >= 18 && hour < 21) { topCol = '#4a1a6b'; botCol = '#ff7043'; fogCol = '#a85a55'; }
            else                              { topCol = '#0d0d2b'; botCol = '#1a237e'; fogCol = '#10131e'; }
            this.skyDome.material.uniforms.topColor.value.set(topCol);
            this.skyDome.material.uniforms.bottomColor.value.set(botCol);
            this.scene.fog.color.set(fogCol);
            this.scene.background = new THREE.Color(fogCol);
        }

        if (this.cityDay && this.cityNight) {
            this.cityDay.visible   = isDay;
            this.cityNight.visible = !isDay;
        }

        const seg = HYDERABAD_ROUTE[this.state.routeIdx % HYDERABAD_ROUTE.length];
        const inTunnel = seg.type === 'tunnel';
        this.tunnelAmbient.intensity = inTunnel ? 0.45 : 0.0;
        if (inTunnel) this.scene.fog.density = 0.005;

        if (this.rain) {
            this.rain.visible = this.state.weather === 'rain';
            if (this.state.weather === 'fog') this.scene.fog.density = 0.05;
            else if (!inTunnel) this.scene.fog.density = (this.state.weather === 'rain' ? 0.025 : 0.012);
        }
    }

    _updateRain() {
        if (!this.rain || !this.rain.visible) return;
        const pos = this.rain.geometry.attributes.position;
        const arr = pos.array;
        const camP = this.camera.position;
        for (let i = 0; i < arr.length; i += 3) {
            arr[i + 1] -= 0.7;
            if (arr[i + 1] < 0) {
                arr[i + 0] = camP.x + (Math.random() - 0.5) * 80;
                arr[i + 1] = 18 + Math.random() * 20;
                arr[i + 2] = camP.z + (Math.random() - 0.5) * 80;
            }
        }
        pos.needsUpdate = true;
    }

    // ── public API (matches 2D game) ───────────────────────────────────────

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
        const FAR_FUTURE = Date.now() + 60_000;
        if (t === 'fuel')    { s.fuel = 0.85;        s.lastFuelAlert = FAR_FUTURE; }
        if (t === 'temp')    { s.engineTemp = 0.40;  s.lastTempAlert = FAR_FUTURE; s.highSpeedSeconds = 0; }
        if (t === 'oil')     { s.oilPressure = 1.0;  s.lastOilAlert  = FAR_FUTURE; }
        if (t === 'battery') { s.battery = 1.0;      s.lastBattAlert = FAR_FUTURE; }
        if (s.activeAlert && s.activeAlert.type === t.toUpperCase()) {
            s.activeAlert = null; s.alertTimeout = 0;
        }
    }
    getState() { return { ...this.state }; }

    start() {
        this.running = true;
        this._lastTs = performance.now();
        this._loop();
    }
    stop() {
        this.running = false;
        if (this._raf) cancelAnimationFrame(this._raf);
        if (this._keydownHandler) window.removeEventListener('keydown', this._keydownHandler);
        if (this._keyupHandler)   window.removeEventListener('keyup',   this._keyupHandler);
        if (this._handleResize)   window.removeEventListener('resize',  this._handleResize);
    }

    _loop() {
        if (!this.running) return;
        const now = performance.now();
        const dt = Math.min(0.1, (now - this._lastTs) / 1000);
        this._lastTs = now;
        try {
            this._update(dt);
            this._updateCameraFromState();
            this._updateNpcs();
            this._updateLightingForTime();
            this._updateRain();
            this.renderer.render(this.scene, this.camera);
            this._drawOverlay();
        } catch (e) {
            console.error('[DrivingGame3D] loop error:', e);
        }
        this._raf = requestAnimationFrame(() => this._loop());
    }
}

if (window.DrivingGame && !window.DrivingGame2D) window.DrivingGame2D = window.DrivingGame;
window.DrivingGame = DrivingGame3D;
window.DrivingGame3D = DrivingGame3D;
window.HYDERABAD_ROUTE = HYDERABAD_ROUTE;

})();
