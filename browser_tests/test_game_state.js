/**
 * browser_tests/test_game_state.js
 *
 * Validates game mechanics in a single evaluate call to avoid
 * CPU starvation under software GL (swiftshader).
 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
function assert(condition, name, detail = '') {
    if (condition) { console.log(`  PASS: ${name}`); pass++; }
    else { console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

async function runTests() {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new', protocolTimeout: 120000,
        args: ['--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=swiftshader'],
    });
    const page = await browser.newPage();
    const errors = [];
    const logs = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console',   m => logs.push(m.text()));

    await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise(r => setTimeout(r, 6000));

    assert(errors.filter(e => !e.includes('Permission denied') && !e.includes('favicon')).length === 0,
        'No page errors on load');
    assert(logs.some(l => l.includes('scene initialised OK')), '3D scene initialised OK');

    // STOP the render loop before running evaluate — prevents CPU starvation that
    // causes CDP protocol timeouts under software GL (swiftshader).
    await page.evaluate(() => {
        if (window._game) window._game.stop();
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));

    // Run ALL game logic tests in a single evaluate (prevents CPU starvation deadlock)
    const results = await page.evaluate(() => {
        const r = {};
        const g = window._game;
        if (!g) { r.noGame = true; return r; }

        r.gameClass    = g.constructor.name;
        r.cameraFov    = Math.round(g.camera?.fov ?? -1);
        r.npcCount     = g.state.npcs.length;
        r.npcMeshCount = g.npcMeshes.length;
        r.initialFuel  = g.state.fuel;
        r.initialTemp  = g.state.engineTemp;

        // Test: engine temp does NOT increase when paused
        g.state.paused = true;
        const tempBefore = g.state.engineTemp;
        try { g._update(5.0); } catch(_) {}
        r.tempAfterPausedUpdate = g.state.engineTemp;
        r.tempBefore = tempBefore;

        // Test: fuel decreases when driving
        g.state.paused = false;
        g.state.speed  = 60;
        const fuelBefore = g.state.fuel;
        try { g._update(10.0); } catch(_) {}
        r.fuelBefore = fuelBefore;
        r.fuelAfter  = g.state.fuel;

        // Test: fault alert is location-aware
        g.state.fuel         = 0.05;
        g.state.lastFuelAlert = 0;
        g.state.paused       = false;
        g.state.speed        = 50;
        try { g._update(0.1); } catch(_) {}
        r.fuelAlertMsg = g.state.activeAlert?.msg ?? '';

        // Test: NPC collider fires via spline
        g.state.paused       = false;
        g.state.speed        = 30;
        g.state.lastNpcAlert = 0;
        g.state.activeAlert  = null;
        g.state.npcs[0].pos  = g.state.worldPos + 2;
        try { g._update(0.1); } catch(_) {}
        r.colliderAlert = g.state.activeAlert?.type ?? 'none';

        // Test: jumpToSegment
        g.jumpToSegment(8);
        r.jumpRouteIdx = g.state.routeIdx;

        // Test: injectFault / clearFault
        g.injectFault('temp');
        r.tempAfterInject = g.state.engineTemp;
        g.clearFault('temp');
        r.tempAfterClear = g.state.engineTemp;

        // Test: getState() shape
        const s = g.getState();
        r.stateHasRequiredFields =
            typeof s.speed === 'number' && typeof s.fuel === 'number' &&
            typeof s.engineTemp === 'number' && typeof s.oilPressure === 'number' &&
            typeof s.battery === 'number' && typeof s.paused === 'boolean' &&
            typeof s.routeIdx === 'number';

        // Test: weather
        g.setWeather('rain');
        r.weatherRain = g.state.weather;
        g.setWeather('clear');
        r.weatherClear = g.state.weather;

        // Test: canvas + overlay exist
        r.gameCanvasExists   = !!document.getElementById('game-canvas');
        r.overlayCanvasExists = !!document.getElementById('game-overlay');
        r.responseElExists    = !!document.getElementById('response-display');
        r.micBtnExists        = !!document.getElementById('mic-btn');

        return r;
    });

    if (results.noGame) {
        assert(false, 'DrivingGame3D initialized (_game found on window)');
        await browser.close(); process.exit(1);
    }

    assert(results.gameClass === 'DrivingGame3D', `_game class is DrivingGame3D (got ${results.gameClass})`);
    assert(results.cameraFov === 55, `Camera FOV = 55° (got ${results.cameraFov})`);
    assert(results.npcCount === 18, `NPC count = 18 (got ${results.npcCount})`);
    assert(results.npcMeshCount === 18, `NPC mesh count = 18 (got ${results.npcMeshCount})`);
    assert(results.tempAfterPausedUpdate <= results.tempBefore + 0.001,
        `Engine temp does NOT increase when paused (${results.tempBefore.toFixed(3)} → ${results.tempAfterPausedUpdate.toFixed(3)})`);
    assert(results.fuelAfter < results.fuelBefore,
        `Fuel decreases when driving (${results.fuelBefore.toFixed(4)} → ${results.fuelAfter.toFixed(4)})`);
    assert(results.fuelAlertMsg.length > 0, 'Fuel alert fires when fuel < 15%');
    assert(!results.fuelAlertMsg.includes('DLF Cyber City'),
        `Fuel alert NOT hardcoded to DLF (msg: "${results.fuelAlertMsg.slice(0, 50)}")`);
    assert(results.colliderAlert === 'NPC',
        `NPC proximity collider fires (type=${results.colliderAlert})`);
    assert(results.jumpRouteIdx === 8, 'jumpToSegment(8) sets routeIdx=8');
    assert(results.tempAfterInject > 0.9, `injectFault(temp) sets engineTemp > 0.9 (got ${results.tempAfterInject?.toFixed(2)})`);
    assert(results.tempAfterClear < 0.6, `clearFault(temp) resets engineTemp < 0.6 (got ${results.tempAfterClear?.toFixed(2)})`);
    assert(results.stateHasRequiredFields, 'getState() returns all required fields');
    assert(results.weatherRain === 'rain', 'setWeather("rain") works');
    assert(results.weatherClear === 'clear', 'setWeather("clear") works');
    assert(results.gameCanvasExists, 'game-canvas element exists');
    assert(results.overlayCanvasExists, 'game-overlay canvas exists');
    assert(results.responseElExists, 'response-display element exists');
    assert(results.micBtnExists, 'mic-btn element exists');

    console.log('');
    console.log(`Results: ${pass} passed, ${fail} failed`);
    await browser.close();
    process.exit(fail > 0 ? 1 : 0);
}

runTests().catch(e => { console.error('Error:', e.message); process.exit(1); });
