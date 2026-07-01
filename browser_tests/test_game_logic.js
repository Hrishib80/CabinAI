/**
 * browser_tests/test_game_logic.js
 *
 * Node.js unit tests for game logic — does NOT require a browser.
 * Loads the game JS in Node with a minimal THREE stub, then tests
 * all the physics, collision, and state logic directly.
 */
const path = require('path');
const fs   = require('fs');

let pass = 0, fail = 0;
function assert(ok, name, detail = '') {
    if (ok) { console.log('  PASS:', name); pass++; }
    else     { console.log('  FAIL:', name, detail || ''); fail++; }
}

// ── Minimal THREE stub (no rendering, just the math classes we use) ──────
const THREE_STUB = {
    PerspectiveCamera: class { constructor(fov) { this.fov = fov; this.position = {set(){}};
        this.lookAt = () => {}; this.rotateZ = () => {}; this.updateProjectionMatrix = () => {}; } },
    WebGLRenderer: class { constructor() { this.outputColorSpace = ''; }
        setPixelRatio() {} setSize() {} render() {} },
    Scene: class { add() {} },
    Color:  class { constructor() {} set() {} },
    FogExp2: class { constructor() { this.color = { set() {} }; this.density = 0.01; } },
    Vector3: class {
        constructor(x=0,y=0,z=0){ this.x=x; this.y=y; this.z=z; }
        copy(v){ this.x=v.x; this.y=v.y; this.z=v.z; return this; }
        cross(v){ const nx=this.y*v.z-this.z*v.y, ny=this.z*v.x-this.x*v.z, nz=this.x*v.y-this.y*v.x;
            this.x=nx; this.y=ny; this.z=nz; return this; }
        normalize(){ const l=Math.sqrt(this.x**2+this.y**2+this.z**2)||1;
            this.x/=l; this.y/=l; this.z/=l; return this; }
        multiplyScalar(s){ this.x*=s; this.y*=s; this.z*=s; return this; }
        clone(){ return new THREE_STUB.Vector3(this.x,this.y,this.z); }
    },
    CatmullRomCurve3: class {
        constructor(pts){ this.pts = pts; }
        getPointAt(u, out) {
            const i = Math.floor(u * (this.pts.length-1));
            const p = this.pts[Math.min(i, this.pts.length-1)];
            if (out) { out.x=p.x; out.y=p.y||0; out.z=p.z; return out; }
            return new THREE_STUB.Vector3(p.x, p.y||0, p.z);
        }
        getTangentAt(u, out) {
            const tangent = new THREE_STUB.Vector3(0,0,1);
            if (out) { out.x=tangent.x; out.y=tangent.y; out.z=tangent.z; return out; }
            return tangent;
        }
        getLength() { return 6800; }
    },
    // Stubs for geometry/material/mesh — we don't test rendering
    BufferGeometry: class { setAttribute(){} setIndex(){} computeVertexNormals(){} dispose(){}
        rotateZ(){return this;} rotateX(){return this;} rotateY(){return this;} },
    Float32BufferAttribute: class { constructor(a,n){ this.array=a; this.itemSize=n; } },
    TubeGeometry: class { dispose(){} },
    PlaneGeometry: class {},
    BoxGeometry: class {},
    SphereGeometry: class {},
    CylinderGeometry: class { rotateZ(){ return this; } rotateX(){ return this; } dispose(){} },
    ConeGeometry: class {},
    TorusGeometry: class {},
    CanvasTexture: class { constructor(){ this.needsUpdate=false; } colorSpace=''; anisotropy=1;
        wrapS=0; wrapT=0; },
    MeshStandardMaterial: class { constructor(o){ Object.assign(this,o); } },
    MeshBasicMaterial: class { constructor(o){ Object.assign(this,o); } },
    SpriteMaterial: class { constructor(o){ Object.assign(this,o||{}); this.color={set(){}}; } },
    PointsMaterial: class { constructor(o){ Object.assign(this,o||{}); } },
    ShaderMaterial: class { constructor(o){ this.uniforms=o?.uniforms||{}; } },
    Mesh: class { constructor(){ this.position={x:0,y:0,z:0,set(x,y,z){this.x=x;this.y=y;this.z=z;},copy(){}};
        this.rotation={x:0,y:0,z:0}; this.scale={set(){}}; this.material={}; this.visible=true;
        this.userData={}; }
        add(){} lookAt(){} rotateZ(){} clone(){ return new THREE_STUB.Mesh(); } updateMatrix(){} },
    Group: class { constructor(){ this.position={x:0,y:0,z:0,set(){}};
        this.rotation={x:0,y:0,z:0}; this.children=[]; this.userData={}; }
        add(c){ this.children.push(c); } lookAt(){} },
    Sprite: class { constructor(){ this.position={x:0,y:0,z:0,copy(v){this.x=v.x;this.y=v.y;this.z=v.z;},
        multiplyScalar(){return this;}}; this.scale={set(){}}; this.material={color:{set(){}}}; } },
    Points: class { constructor(g,m){ this.geometry=g; this.material=m; this.visible=false; } },
    InstancedMesh: class { constructor(g,m,n){ this.count=n; this.instanceMatrix={
        setUsage(){}, needsUpdate:false }; }
        setMatrixAt(){} add(){} },
    AmbientLight: class { constructor(c,i){ this.intensity=i||1; } },
    DirectionalLight: class { constructor(c,i){ this.intensity=i||1; this.position={set(){}}; } },
    HemisphereLight: class { constructor(c,g,i){ this.intensity=i||1; } },
    Object3D: class { constructor(){ this.position={x:0,y:0,z:0,set(){}};
        this.rotation={y:0}; this.scale={set(){}}; }
        updateMatrix(){} },
    AdditiveBlending: 2,
    StaticDrawUsage: 35044,
    SRGBColorSpace: 'srgb',
    BackSide: 1,
    DoubleSide: 2,
    RepeatWrapping: 1000,
    INT8Type: 1006,
    BufferAttribute: class { constructor(a,n){ this.array=a; this.itemSize=n; } },
    RenderTarget: class { constructor(){ this.texture={}; } },
    REVISION: '158',
};

// Provide document/window stubs for browser API references in the game
global.THREE = THREE_STUB;
global.window = global;
// Full 2D context stub that silently accepts all calls
const CTX2D_STUB = new Proxy({}, {
    get(target, prop) {
        if (prop === 'canvas') return { width: 800, height: 220 };
        if (prop === 'measureText') return () => ({ width: 50 });
        if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
        if (prop === 'createRadialGradient') return () => ({ addColorStop() {} });
        if (prop === 'createPattern') return () => ({});
        return () => {};
    },
    set() { return true; },
});

global.document = {
    getElementById: (id) => {
        const base = { clientWidth: 800, clientHeight: 500, width: 800, height: 500,
            parentElement: { clientWidth:800, clientHeight:500,
                getBoundingClientRect: () => ({width:800,height:500}) } };
        if (id === 'game-canvas') return { ...base,
            getContext: (type) => type === 'webgl2' || type === 'webgl' ? null : CTX2D_STUB };
        if (id === 'game-overlay') return { ...base, getContext: () => CTX2D_STUB };
        return null;
    },
    createElement: (tag) => {
        if (tag === 'canvas') return { getContext: () => CTX2D_STUB, width: 512, height: 220 };
        return {};
    },
    querySelectorAll: () => [],
};
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = (fn) => { /* don't actually call it */ return 1; };
global.cancelAnimationFrame = () => {};
global.addEventListener = () => {};
global.removeEventListener = () => {};
global.playAlertBeep = () => {};

// Stub bus
const BUS_EVENTS = {};
const bus = {
    publish: (evt, data) => {},
    subscribe: (evt, fn) => {},
    getState: () => ({}),
    state: {},
};

// Load the game file
const src = fs.readFileSync(path.join(__dirname, '../frontend/js/game/driving_game_3d.js'), 'utf8');
// The game is an IIFE — evaluate it
(new Function('window', 'document', 'THREE', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'addEventListener', 'removeEventListener', 'playAlertBeep', src))(
    global, global.document, THREE_STUB, global.performance,
    global.requestAnimationFrame, global.cancelAnimationFrame,
    global.addEventListener, global.removeEventListener, global.playAlertBeep
);

const DrivingGame3D = global.DrivingGame;
const HYDERABAD_ROUTE = global.HYDERABAD_ROUTE;

assert(typeof DrivingGame3D === 'function', 'DrivingGame3D class defined after IIFE eval');
assert(Array.isArray(HYDERABAD_ROUTE) && HYDERABAD_ROUTE.length === 17,
    `HYDERABAD_ROUTE exported with 17 segments (got ${HYDERABAD_ROUTE?.length})`);

// Construct a game instance
const canvas = global.document.getElementById('game-canvas');
let game;
try {
    game = new DrivingGame3D(canvas, bus);
} catch (e) {
    assert(false, 'DrivingGame3D constructor succeeds', e.message);
    process.exit(1);
}
assert(game !== null, 'DrivingGame3D instance created');
assert(game.state !== undefined, 'game.state exists');
assert(game.state.fuel === 1.0, 'Initial fuel = 1.0');
assert(game.state.engineTemp >= 0.29 && game.state.engineTemp <= 0.31,
    `Initial engineTemp ≈ 0.30 (got ${game.state.engineTemp})`);
assert(game.state.paused === true, 'Initial state is paused');
assert(game.state.npcs.length === 18, `NPC count = 18 (got ${game.state.npcs.length})`);

// Test: engine temp does NOT increase when paused
const tempBefore = game.state.engineTemp;
game.state.paused = true;
game._update(5.0);
assert(game.state.engineTemp <= tempBefore + 0.001,
    `Temp stable when paused (${tempBefore.toFixed(3)} → ${game.state.engineTemp.toFixed(3)})`);

// Test: fuel decreases when driving
game.state.paused = false;
game.state.speed = 60;
const fuelBefore = game.state.fuel;
game._update(10.0);
assert(game.state.fuel < fuelBefore,
    `Fuel decreases when driving (${fuelBefore.toFixed(4)} → ${game.state.fuel.toFixed(4)})`);

// Test: engine heats when driving fast
game.state.speed = 150;
game.state.highSpeedSeconds = 90;
const tempBeforeFast = game.state.engineTemp;
game._update(3.0);
assert(game.state.engineTemp > tempBeforeFast,
    `Engine heats when driving fast (${tempBeforeFast.toFixed(3)} → ${game.state.engineTemp.toFixed(3)})`);

// Test: fault alerts are location-aware (not hardcoded DLF)
game.state.fuel = 0.05;
game.state.lastFuelAlert = 0;
game.state.paused = false;
game.state.speed  = 50;
game._update(0.1);
const alertMsg = game.state.activeAlert?.msg ?? '';
assert(alertMsg.length > 0, 'Fuel alert fires when fuel < 15%');
assert(!alertMsg.includes('DLF Cyber City'),
    `Alert NOT hardcoded to DLF Cyber City: "${alertMsg.slice(0, 60)}"`);

// Test: jumpToSegment
game.jumpToSegment(8);
assert(game.state.routeIdx === 8, 'jumpToSegment(8) → routeIdx=8 (Biodiversity Junction)');
game.jumpToSegment(0);
assert(game.state.routeIdx === 0, 'jumpToSegment(0) → routeIdx=0');

// Test: injectFault / clearFault
game.injectFault('temp');
assert(game.state.engineTemp > 0.9, `injectFault(temp) sets engineTemp > 0.9 (got ${game.state.engineTemp.toFixed(2)})`);
game.clearFault('temp');
assert(game.state.engineTemp < 0.6, `clearFault(temp) resets engineTemp < 0.6 (got ${game.state.engineTemp.toFixed(2)})`);

game.injectFault('fuel');
assert(game.state.fuel < 0.1, 'injectFault(fuel) sets fuel < 0.1');
game.clearFault('fuel');
assert(game.state.fuel > 0.8, 'clearFault(fuel) resets fuel > 0.8');

// Test: getState returns correct shape
const s = game.getState();
assert(
    typeof s.speed === 'number' && typeof s.fuel === 'number' &&
    typeof s.engineTemp === 'number' && typeof s.oilPressure === 'number' &&
    typeof s.battery === 'number' && typeof s.paused === 'boolean' &&
    typeof s.routeIdx === 'number' && typeof s.recommendedRest === 'string',
    'getState() returns all required fields with correct types'
);

// Test: setWeather
game.setWeather('rain');
assert(game.state.weather === 'rain', 'setWeather("rain") works');
game.setWeather('fog');
assert(game.state.weather === 'fog', 'setWeather("fog") works');
game.setWeather('clear');
assert(game.state.weather === 'clear', 'setWeather("clear") works');

// Test: startDriving / stopDriving
game.startDriving();
assert(game.state.paused === false && game.state.targetSpeed === 50,
    'startDriving() clears paused and sets targetSpeed=50');
game.stopDriving();
assert(game.state.paused === true && game.state.targetSpeed === 0,
    'stopDriving() sets paused=true and targetSpeed=0');

// Test: setCamPreset
game.setCamPreset('chase');
assert(game._camPreset === 'chase', 'setCamPreset("chase") sets _camPreset');
game.setCamPreset('cockpit');
assert(game._camPreset === 'cockpit', 'setCamPreset("cockpit") sets _camPreset');

// Test: NPC proximity collider uses spline (structural check)
game.state.paused = false;
game.state.speed  = 30;
game.state.lastNpcAlert = 0;
game.state.activeAlert  = null;
const playerPos = game.state.worldPos;
game.state.npcs[0].pos = playerPos + 3; // 3m ahead on spline
game._update(0.1);
assert(
    game.state.activeAlert?.type === 'NPC',
    `NPC collider fires when NPC is 3m ahead (alert type=${game.state.activeAlert?.type})`
);

// Test: NPC lane offset = 2.5 (structural check in source)
const gameSrc = fs.readFileSync(path.join(__dirname, '../frontend/js/game/driving_game_3d.js'), 'utf8');
assert(gameSrc.includes('lane * 2.5'), 'NPC lane offset = 2.5m in source');
assert(gameSrc.includes('0.35,   // sit just on the road'), 'NPC y=0.35 in source');

console.log('');
console.log(`Results: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
