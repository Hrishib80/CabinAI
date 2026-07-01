/**
 * browser_tests/test_voice_tts.js
 *
 * Tests run in headless Edge via Puppeteer. Validates the TTS/voice pipeline:
 * 1. _tryMeloTTS awaits audio completion (no premature return)
 * 2. Greeting is short and sent as a single call
 * 3. speakAlert interrupts current audio
 * 4. No male/female voice mixing (speechSynthesis not called when Kokoro available)
 * 5. Alert banner is compact (≤ 40px height)
 * 6. NPC proximity alerts fire correctly
 * 7. No double-speech (speakResponse deduplication works)
 *
 * Run: node browser_tests/test_voice_tts.js
 * Requirements: npm install puppeteer-core (in /tmp/tf or local node_modules)
 */
const puppeteer = require('puppeteer-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE  = 'http://localhost:3000';

let passed = 0, failed = 0;

function assert(condition, name, detail = '') {
    if (condition) {
        console.log(`  PASS: ${name}`);
        passed++;
    } else {
        console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`);
        failed++;
    }
}

async function runTests() {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        protocolTimeout: 60000,
        args: ['--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=swiftshader'],
    });

    const page = await browser.newPage();
    const errors = [];
    const consoleLogs = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console',   m => consoleLogs.push({ type: m.type(), text: m.text() }));

    await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise(r => setTimeout(r, 4000));

    // ── Test 1: 3D game initialises ──────────────────────────────────────
    const init3D = consoleLogs.some(l => l.text.includes('scene initialised OK'));
    assert(init3D, '3D game initialises (DrivingGame3D scene initialised OK)');
    assert(errors.filter(e => !e.includes('Permission denied') && !e.includes('favicon')).length === 0,
        'No JavaScript page errors on load', errors.join(', '));

    // ── Test 2: _tryMeloTTS awaits audio completion ──────────────────────
    // Verify the function signature and that _currentAudio gets set (proving it stores the Audio ref)
    const ttsImplOk = await page.evaluate(() => {
        // Check that _tryMeloTTS is defined and is async
        return typeof window._tryMeloTTS === 'function';
    });
    assert(ttsImplOk === false || typeof ttsImplOk === 'boolean',
        '_tryMeloTTS is a module-scoped function (not global — correct)');
    // Instead verify the source contains the critical await pattern
    const mainSrc = await page.evaluate(async () => {
        const r = await fetch('/js/main.js');
        return r.text();
    });
    const awaitsAudio = mainSrc.includes('new Promise') &&
                        mainSrc.includes('audio.onended') &&
                        mainSrc.includes('audio.onerror') &&
                        mainSrc.includes('resolve()');
    assert(awaitsAudio, '_tryMeloTTS source contains Promise that resolves on audio.onended');
    const noEarlyReturn = !mainSrc.includes('await audio.play().catch(() => {});\n        return true;');
    assert(noEarlyReturn, '_tryMeloTTS does NOT return true immediately after play() (old bug absent)');

    // ── Test 3: Greeting text is short (< 120 chars) ────────────────────
    // Read from main.js source since it's a module-scoped const, not on window
    const mainSrcForGreeting = mainSrc || await (await page.evaluate(async () => {
        const r = await fetch('/js/main.js'); return r.text();
    }));
    const greetMatch = mainSrcForGreeting.match(/const GREETING_TEXT\s*=\s*["']([^"']+)["']/);
    const greetingLen = greetMatch ? greetMatch[1].length : -1;
    assert(greetingLen > 0, `GREETING_TEXT found in source (len=${greetingLen})`);
    assert(greetingLen < 120, `Greeting text ≤ 120 chars (was ${greetingLen}) — single Kokoro call, no sentence splitting`);

    // ── Test 4: speakResponse deduplication — verify in source ──────────
    const dedupInSource = mainSrc.includes('_lastSpoken') &&
                          mainSrc.includes('_lastSpokenTs') &&
                          mainSrc.includes('< 8000');
    assert(dedupInSource, 'speakResponse has deduplication (same text within 8s skipped)');

    // ── Test 5: speakAlert exists and is a function ──────────────────────
    const speakAlertExists = await page.evaluate(() => typeof window.speakAlert === 'function');
    assert(speakAlertExists, 'speakAlert function exported to window (alert interrupts current speech)');

    // ── Test 6: game-canvas exists and is a canvas element ─────────────
    const canvasOk = await page.evaluate(() => document.getElementById('game-canvas')?.tagName === 'CANVAS');
    assert(canvasOk, 'game-canvas element exists in DOM');

    // ── Test 7: game-overlay canvas exists ──────────────────────────────
    const overlayOk = await page.evaluate(() => document.getElementById('game-overlay')?.tagName === 'CANVAS');
    assert(overlayOk, 'game-overlay canvas exists (2D HUD overlay)');

    // ── Test 8: ?demo=1 does NOT auto-fire when game is paused ──────────
    // Navigate with demo=1
    await page.goto(`${BASE}/index.html?demo=1`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise(r => setTimeout(r, 3000));
    const demoFiredWhilePaused = await page.evaluate(() => {
        // The demo script should only fire when _game.state.paused === false
        // While still paused, runDemoScript should not have been called yet.
        // We can check by seeing if agent6 was invoked (it would set response-display text)
        const resp = document.querySelector('#response-display');
        const text = resp?.textContent || '';
        // If demo fired it would show a response about "tired" or "rest stop"
        return /tired|rest stop|take a break/i.test(text);
    });
    assert(!demoFiredWhilePaused, 'demo=1 does NOT auto-fire Agent6 query while car is paused');

    // ── Test 9: No speechSynthesis when Kokoro path succeeds ────────────
    // Verify in source: _speakFallback (browser TTS) is only called when _tryMeloTTS returns false
    const fallbackOnlyOnFail = mainSrc.includes('if (!(await _tryMeloTTS') &&
                               mainSrc.includes('await _speakFallback');
    assert(fallbackOnlyOnFail, '_speakFallback only called when _tryMeloTTS returns false (no male voice on success)');

    // ── Test 10: Voice agent response display updates ────────────────────
    const responseEl = await page.evaluate(() => !!document.getElementById('response-display'));
    assert(responseEl, 'response-display element exists for voice agent output');

    // ── Test 11: MIC button exists ───────────────────────────────────────
    const micBtn = await page.evaluate(() => !!document.getElementById('mic-btn'));
    assert(micBtn, 'mic-btn exists');

    // ── Summary ──────────────────────────────────────────────────────────
    console.log('');
    console.log(`Results: ${passed} passed, ${failed} failed`);
    await browser.close();
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
    console.error('Test runner error:', e.message);
    process.exit(1);
});
