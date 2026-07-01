/**
 * tests/frontend_test.js — Real browser test using Puppeteer.
 *
 * Loads the actual frontend, captures console errors, network failures,
 * and exercises each feature. This catches the JS errors that the Python
 * tests completely miss.
 *
 * Requires backend on :5000 and frontend served on :3000.
 * Run: node tests/frontend_test.js
 */
const puppeteer = require('puppeteer');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const HEADLESS     = process.env.HEADLESS !== 'false';

const results = { pass: [], fail: [], console_errors: [], page_errors: [], net_fail: [] };

function ok(name)   { results.pass.push(name); console.log(`  PASS  ${name}`); }
function bad(name, d) { results.fail.push({ name, d }); console.log(`  FAIL  ${name} — ${d}`); }

(async () => {
    const browser = await puppeteer.launch({
        headless: HEADLESS ? 'new' : false,
        args: [
            '--use-fake-ui-for-media-stream',     // auto-grant mic permission
            '--use-fake-device-for-media-stream', // fake mic + camera
            '--no-sandbox',
            '--disable-setuid-sandbox',
        ],
    });
    const page = await browser.newPage();

    // Capture everything
    page.on('console', msg => {
        const t = msg.type();
        if (t === 'error') results.console_errors.push(msg.text());
    });
    page.on('pageerror', err => results.page_errors.push(err.message));
    page.on('requestfailed', req =>
        results.net_fail.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`));

    console.log(`\nLoading ${FRONTEND_URL} ...`);
    await page.goto(FRONTEND_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Give the app time to boot (camera, SSE, agents, MediaPipe CDN)
    await new Promise(r => setTimeout(r, 8000));

    console.log('\n── Structural checks ──');

    // 1. No uncaught page errors
    if (results.page_errors.length === 0) ok('no uncaught JS exceptions');
    else bad('uncaught JS exceptions', results.page_errors.join(' | '));

    // 2. Key globals exist
    const globals = await page.evaluate(() => ({
        bus:       typeof window.bus,
        ZeroClawBus: typeof window.ZeroClawBus,
        DrivingGame: typeof window.DrivingGame,
        Agent3Speech: typeof window.Agent3Speech,
        speakResponse: typeof window.speakResponse,
        playAlertBeep: typeof window.playAlertBeep,
        extractFeatures: typeof window.extractFeatures,
        routeQuery: typeof window.routeQuery,
    }));
    for (const [k, v] of Object.entries(globals)) {
        if (v !== 'undefined') ok(`global ${k} defined (${v})`);
        else bad(`global ${k} missing`, 'undefined');
    }

    // 3. Backend status badge turned green
    const badge = await page.evaluate(() =>
        document.getElementById('backend-status-text')?.textContent);
    if (badge && /connected/i.test(badge)) ok(`backend badge: "${badge}"`);
    else bad('backend badge not connected', `got "${badge}"`);

    // 4. Mic button exists and has click handler
    const micExists = await page.evaluate(() => !!document.getElementById('mic-btn'));
    if (micExists) ok('mic button present'); else bad('mic button missing', '');

    // 5. Click mic, verify state change
    await page.click('#mic-btn').catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
    const micState = await page.evaluate(() => ({
        text: document.getElementById('mic-btn')?.textContent,
        status: document.getElementById('mic-status')?.textContent,
    }));
    if (micState.text === 'STOP' || micState.status === 'RECORDING')
        ok(`mic recording state: ${JSON.stringify(micState)}`);
    else bad('mic did not enter recording state', JSON.stringify(micState));
    await page.click('#mic-btn').catch(() => {}); // stop

    // 6. Sync countdown decrements
    const t1 = await page.evaluate(() => document.getElementById('sync-countdown')?.textContent);
    await new Promise(r => setTimeout(r, 3000));
    const t2 = await page.evaluate(() => document.getElementById('sync-countdown')?.textContent);
    if (t1 !== t2) ok(`sync countdown ticking (${t1} -> ${t2})`);
    else bad('sync countdown frozen', `stuck at ${t1}`);

    // 7. RAG query returns and displays
    await page.evaluate(() => {
        document.querySelector('[data-tab="tab2"]')?.click();
    });
    await new Promise(r => setTimeout(r, 500));
    await page.type('#rag-input', 'low oil pressure warning light');
    await page.click('#rag-ask-btn');
    await new Promise(r => setTimeout(r, 8000));  // wait longer for real backend
    const ragResp = await page.evaluate(() =>
        document.getElementById('rag-response')?.textContent);
    if (ragResp && ragResp.length > 20 && !/searching/i.test(ragResp))
        ok(`RAG responded: "${ragResp.slice(0, 50)}..."`);
    else bad('RAG did not display answer', `got "${ragResp}"`);

    // 8. Driving game canvas is rendering (non-blank)
    await page.evaluate(() => document.querySelector('[data-tab="tab4"]')?.click());
    await new Promise(r => setTimeout(r, 2000));
    const gameRendering = await page.evaluate(() => {
        const c = document.getElementById('game-canvas');
        if (!c) return { error: 'no canvas' };
        const ctx = c.getContext('2d');
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let nonBlack = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i] > 10 || data[i+1] > 10 || data[i+2] > 10) nonBlack++;
        }
        return { w: c.width, h: c.height, nonBlackPct: (nonBlack / (data.length / 4) * 100).toFixed(1) };
    });
    if (gameRendering.nonBlackPct && parseFloat(gameRendering.nonBlackPct) > 5)
        ok(`game canvas rendering (${gameRendering.w}x${gameRendering.h}, ${gameRendering.nonBlackPct}% non-black)`);
    else bad('game canvas blank/not rendering', JSON.stringify(gameRendering));

    // 9. Game dashboard canvas rendering
    const dashRendering = await page.evaluate(() => {
        const c = document.getElementById('dash-canvas');
        if (!c) return { error: 'no dash canvas' };
        const ctx = c.getContext('2d');
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let nonBlack = 0;
        for (let i = 0; i < data.length; i += 4)
            if (data[i] > 10 || data[i+1] > 10 || data[i+2] > 10) nonBlack++;
        return { w: c.width, h: c.height, nonBlackPct: (nonBlack / (data.length / 4) * 100).toFixed(1) };
    });
    if (dashRendering.nonBlackPct && parseFloat(dashRendering.nonBlackPct) > 2)
        ok(`dashboard rendering (${dashRendering.nonBlackPct}% non-black)`);
    else bad('dashboard blank', JSON.stringify(dashRendering));

    // ── Report ──
    console.log('\n── Captured errors ──');
    if (results.page_errors.length) {
        console.log('PAGE ERRORS:');
        results.page_errors.forEach(e => console.log('  ! ' + e));
    }
    if (results.console_errors.length) {
        console.log('CONSOLE ERRORS:');
        [...new Set(results.console_errors)].slice(0, 15).forEach(e => console.log('  ! ' + e.slice(0, 200)));
    }
    if (results.net_fail.length) {
        console.log('NETWORK FAILURES:');
        [...new Set(results.net_fail)].slice(0, 15).forEach(e => console.log('  ! ' + e));
    }

    console.log(`\n── Summary ──`);
    console.log(`  PASS: ${results.pass.length}`);
    console.log(`  FAIL: ${results.fail.length}`);

    await browser.close();
    process.exit(results.fail.length > 0 ? 1 : 0);
})().catch(e => { console.error('TEST HARNESS ERROR:', e); process.exit(2); });
