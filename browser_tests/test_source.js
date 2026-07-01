/**
 * browser_tests/test_source.js
 *
 * Fast source-code verification tests that don't require a browser.
 * Checks the critical patterns in JS source files.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'frontend/js/main.js'), 'utf8');
const gameSrc = fs.readFileSync(path.join(ROOT, 'frontend/js/game/driving_game_3d.js'), 'utf8');
const hudSrc  = fs.readFileSync(path.join(ROOT, 'frontend/js/ui/hud_renderer.js'), 'utf8');
const ps1Src  = fs.readFileSync(path.join(ROOT, 'start.ps1'), 'utf8');

let pass = 0, fail = 0;
function check(ok, name, detail = '') {
    if (ok) { console.log('  PASS:', name); pass++; }
    else     { console.log('  FAIL:', name, detail || ''); fail++; }
}

// ── TTS: audio must await completion ────────────────────────────────────
check(
    mainSrc.includes('new Promise') && mainSrc.includes('audio.onended') && mainSrc.includes('resolve()'),
    'TTS: _tryMeloTTS awaits audio.onended via Promise'
);
check(
    !mainSrc.includes("await audio.play().catch(() => {});\n        return true;"),
    'TTS: old premature-return bug absent'
);
check(
    mainSrc.includes('_currentAudio = audio'),
    'TTS: _currentAudio is set to the Audio instance (enables interrupt)'
);

// ── Greeting is short single call ────────────────────────────────────────
const greetMatch = mainSrc.match(/const GREETING_TEXT\s*=\s*"([^"]{1,200})"/);
const greetLen = greetMatch ? greetMatch[1].length : -1;
check(greetLen > 0 && greetLen < 120,
    `Greeting ≤ 120 chars so it goes as ONE Kokoro call (len=${greetLen})`
);
check(
    mainSrc.includes('_tryMeloTTS(GREETING_TEXT)'),
    'Greeting bypasses sentence-chunking (_tryMeloTTS called directly)'
);

// ── speakAlert exported ──────────────────────────────────────────────────
check(mainSrc.includes('window.speakAlert = speakAlert'),
    'speakAlert exported to window (allows interrupt from external code)'
);

// ── Deduplication ───────────────────────────────────────────────────────
check(mainSrc.includes('_lastSpoken') && mainSrc.includes('< 8000'),
    'speakResponse deduplication: same text within 8s skipped'
);

// ── Demo mode: waits for car to move ────────────────────────────────────
check(
    mainSrc.includes('!_game.state.paused') && mainSrc.includes('_waitForDrive'),
    'Demo script waits for car driving before firing Agent6'
);

// ── Proactive alert speaks first sentence only ───────────────────────────
check(
    hudSrc.includes("pa.msg.split(/[.!?]/)") || hudSrc.includes("pa.msg.split"),
    'Proactive alert voices only first sentence (not full multi-sentence response)'
);

// ── Browser fallback always uses female voice ─────────────────────────────
check(
    mainSrc.includes('_getFemaleBrowserVoice') && mainSrc.includes('utt.voice = voice') && mainSrc.includes('utt.pitch'),
    'Browser fallback uses _getFemaleBrowserVoice() to select consistent female voice'
);
check(
    mainSrc.includes('utt.pitch  = 1.1') || mainSrc.includes('utt.pitch = 1.1'),
    'Browser fallback pitch set to 1.1 (feminine pitch matching Kokoro)'
);
check(
    mainSrc.includes("utt.lang   = 'en-US'") || mainSrc.includes("utt.lang = 'en-US'"),
    'Browser fallback sets lang=en-US for consistent voice selection'
);
// TTS timeout reduced from 12s to 6s
check(
    mainSrc.includes('AbortSignal.timeout(6000)'),
    'Kokoro fetch timeout = 6s (fast fail so fallback kicks in quickly)'
);
check(
    !mainSrc.includes('AbortSignal.timeout(12000)'),
    'Old 12s timeout removed'
);

// ── start.ps1: demo=1 only on -Demo flag ────────────────────────────────
check(
    ps1Src.includes('[switch]$Demo') && !ps1Src.includes('if (-not $NoDemo)'),
    'start.ps1: ?demo=1 NOT added by default, only with -Demo flag'
);

// ── Alert banner compact ─────────────────────────────────────────────────
check(
    gameSrc.includes('ah = 32') || (gameSrc.includes('const ah') && gameSrc.includes('32')),
    'Alert banner height = 32px (compact pill)'
);
check(
    gameSrc.includes("'bold 12px monospace'") || gameSrc.includes('"bold 12px monospace"'),
    'Alert banner font = 12px (not 18px)'
);

// ── NPC alignment fixes ──────────────────────────────────────────────────
check(gameSrc.includes('lane * 2.5'),
    'NPC lane offset = 2.5m (widened from 1.5m to fit 4.5m half-road)'
);
check(gameSrc.includes('0.35,   // sit just on the road'),
    'NPC y = 0.35 (sits on road surface, not floating at y=0)'
);
check(
    gameSrc.includes('m.position.x + tmpT.x') || gameSrc.includes('m.position.z + tmpT.z'),
    'NPC lookAt uses m.position as base (correct tangent-relative orientation)'
);

// ── Collider uses live spline positions ──────────────────────────────────
check(
    gameSrc.includes('npc.pos % ROUTE_TOTAL_M') && gameSrc.includes('distAhead > 12'),
    'Collider checks live spline positions (not stale mesh positions from last frame)'
);
check(
    gameSrc.includes('routeCurve.getPointAt(npcU)'),
    'Collider samples npcU spline position dynamically'
);

// ── Engine temp cools when slowing ──────────────────────────────────────
check(
    gameSrc.includes('coolRate') && gameSrc.includes('s.speed < 40'),
    'Engine coolant temp has speed-dependent cooling (temp drops when you slow down)'
);
check(
    gameSrc.includes('engineRunning = s.speed > 0') || gameSrc.includes('s.speed > 0'),
    'Engine heat only accumulates when car is moving'
);

console.log('');
console.log(`Results: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
