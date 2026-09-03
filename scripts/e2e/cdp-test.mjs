// Drive the REAL built app in headless Chromium over the Chrome DevTools
// Protocol — the full user journey, including the part that used to break:
//
//   settings → scan (both mock servers reachable) → Use LM Studio →
//   Test connection (which persists the endpoint) → New book → seed →
//   titles (JSON) → use title →
//   PAGE 1 STREAMS (SSE) → keep → turn → switch endpoint to Ollama → Save →
//   continue → PAGE 2 STREAMS (NDJSON) → LAN scan finds the loopback server.
//
// Chromium is launched by run.sh, already pointed at the app URL.
const CDP_BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await fetch(`${CDP_BASE}/json`).then((r) => r.json());
const target = targets.find((t) => t.type === 'page');
if (!target)
  throw new Error('no page target — is Chromium running with --remote-debugging-port=9222?');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.result?.exceptionDetails)
    throw new Error(JSON.stringify(result.result.exceptionDetails));
  return result.result?.result?.value;
}
async function waitFor(expression, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) return true;
    await sleep(250);
  }
  throw new Error(`timed out waiting for: ${label}`);
}
async function waitForOr(expression, timeoutMs, label) {
  try {
    return await waitFor(expression, timeoutMs, label);
  } catch {
    return false;
  }
}

/** On failure: dump the visible app state so the log explains itself. */
async function dumpState() {
  return evaluate(
    "JSON.stringify({ main: document.querySelector('.main')?.innerText?.slice(0, 1200), state: window.__PAGE_TURN__ ? { view: window.__PAGE_TURN__.view(), params: window.__PAGE_TURN__.params(), bookId: window.__PAGE_TURN__.bookId(), genCounter: window.__PAGE_TURN__.genCounter(), genStateKeys: window.__PAGE_TURN__.genStateKeys(), audit: window.__PAGE_TURN__.audit() } : 'no-handle' })",
  );
}

const out = {};

// ---- 1. Settings: scan, use, save, test ------------------------------------
out.booted = await waitFor("!!document.querySelector('.view-settings')", 10000, 'settings render');
await evaluate("document.querySelector('.view-settings .btn-primary').click(); 'clicked'");
out.reachableAppeared = await waitFor(
  "[...document.querySelectorAll('.scan-row')].some(r => r.textContent.includes('reachable') && r.textContent.includes('LM Studio'))",
  40000,
  'LM Studio row reachable',
);
out.ollamaRowAppeared = await waitFor(
  "[...document.querySelectorAll('.scan-row')].some(r => r.textContent.includes('reachable') && r.textContent.includes('Ollama'))",
  10000,
  'Ollama row reachable',
);
out.scanRows = await evaluate(
  "[...document.querySelectorAll('.scan-row')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())",
);
await evaluate(
  "[...document.querySelectorAll('.scan-row')].find(r => r.textContent.includes('LM Studio')).querySelector('button').click(); 'used'",
);
out.modelAfterUse = await evaluate(
  'document.querySelector(\'input[list="discovered-models"]\').value',
);
// Regression: Test connection must persist the form, so a user who tests
// without pressing Save still gets a working endpoint for titles/pages.
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Test connection')).click(); 'clicked'",
);
out.connectedToast = await waitForOr(
  "[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Connected'))",
  30000,
  'Connected toast',
);
out.savedAfterTest = await evaluate('window.__PAGE_TURN__.model()');

// ---- 2. New book: seed → titles → page 1 streams SSE -----------------------
await evaluate(
  "[...document.querySelectorAll('.nav-link')].find(b => b.textContent.includes('New book')).click(); 'seed'",
);
await waitFor("!!document.querySelector('.seed-input')", 10000, 'seed view');
await evaluate(
  "document.querySelector('.seed-input').value = 'A lighthouse keeper finds a letter.'; 'typed'",
);
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Begin')).click(); 'begun'",
);
out.titleCards = await waitFor(
  "document.querySelectorAll('.title-card').length >= 5",
  30000,
  'five title cards',
);
out.firstTitle = await evaluate("document.querySelector('.title-card h2').textContent");
await evaluate("document.querySelector('.title-card').click(); 'selected'");
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Use this title')).click(); 'used'",
);
out.page1Appeared = await waitForOr(
  "[...document.querySelectorAll('.view-page .page-num')].some(n => n.textContent.includes('Page 1')) && !!document.querySelector('.view-page .page-text')",
  30000,
  'page 1 streamed via SSE',
);
if (!out.page1Appeared) {
  console.log('PAGE-1-FAILURE-STATE:', await dumpState());
}
out.page1Text = await evaluate(
  "document.querySelector('.view-page .page-text')?.textContent ?? ''",
);
// The page workshop: paragraph tools, story spine, living cast, version picker.
out.paragraphTools = await evaluate(
  "document.querySelectorAll('.view-page .para-tool').length > 0",
);
out.spineNav = await evaluate("!!document.querySelector('.view-page .spine')");
out.castPanel = await evaluate("!!document.querySelector('.view-page .cast')");
out.versionPicker = await evaluate("!!document.querySelector('.view-page .version-picker')");
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Keep this page')).click(); 'kept'",
);
out.turnPanelAppeared = await waitFor(
  "!!document.querySelector('.turn-panel')",
  10000,
  'turn panel',
);
// The director's console: emotion dials and standing rules.
out.emotionDials = await evaluate("!!document.querySelector('.view-turn .dial-grid')");
out.standingRules = await evaluate("!!document.querySelector('.view-turn .rules-area')");

// ---- 3. Switch to Ollama and stream page 2 over NDJSON ---------------------
await evaluate(
  "[...document.querySelectorAll('.nav-link')].find(b => b.textContent.includes('Settings')).click(); 'settings'",
);
await waitFor("!!document.querySelector('.view-settings')", 10000, 'settings again');
await evaluate(
  "[...document.querySelectorAll('.scan-row')].find(r => r.textContent.includes('Ollama')).querySelector('button').click(); 'used-ollama'",
);
out.modelAfterOllamaUse = await evaluate(
  'document.querySelector(\'input[list="discovered-models"]\').value',
);
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Save')).click(); 'saved-ollama'",
);
await evaluate(
  "[...document.querySelectorAll('.nav-link')].find(b => b.textContent.includes('Library')).click(); 'library'",
);
await waitFor("!!document.querySelector('.book-card')", 10000, 'book card');
await evaluate(
  "[...document.querySelectorAll('.book-card button')].find(b => b.textContent.includes('Continue')).click(); 'continue'",
);
// Continue lands on the frontier = the kept page 1; keep it again to reach the turn panel.
out.page1Again = await waitForOr(
  "[...document.querySelectorAll('.view-page .page-num')].some(n => n.textContent.includes('Page 1'))",
  10000,
  'page 1 again after Continue',
);
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Keep this page')).click(); 'kept-again'",
);
await waitFor("!!document.querySelector('.turn-panel')", 10000, 'turn panel again');
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Continue naturally')).click(); 'next'",
);
out.page2Appeared = await waitForOr(
  "[...document.querySelectorAll('.view-page .page-num')].some(n => n.textContent.includes('Page 2')) && !!document.querySelector('.view-page .page-text')",
  30000,
  'page 2 streamed via Ollama NDJSON',
);
if (!out.page2Appeared) {
  console.log('PAGE-2-FAILURE-STATE:', await dumpState());
}
out.page2Text = await evaluate(
  "document.querySelector('.view-page .page-text')?.textContent ?? ''",
);

// ---- 3b. Story map renders the tree as a timeline --------------------------
await evaluate(
  "[...document.querySelectorAll('.nav-link')].find(b => b.textContent.includes('Story map')).click(); 'archive'",
);
out.archiveAppeared = await waitFor(
  "!!document.querySelector('.archive-timeline') && document.querySelectorAll('.archive-entry').length >= 2",
  10000,
  'story map with two timeline entries',
);

// ---- 3c. Time-lapse replay regression: live entries must light up ----------
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Replay the journey')).click(); 'replay'",
);
out.replayHighlighted = await waitForOr(
  "document.querySelectorAll('.archive-entry.replaying').length === 1",
  4000,
);
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Stop replay')).click(); 'stop-replay'",
);

// ---- 3d. Reader regression: no render loop when speech synthesis exists ----
await evaluate(
  "Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { getVoices: () => [{ name: 'Mock Voice' }], speak: () => {}, cancel: () => {} } }); 'mocked'",
);
const rendersBefore = await evaluate('window.__PAGE_TURN__.renders()');
await evaluate(
  "[...document.querySelectorAll('.nav-link')].find(b => b.textContent.includes('Read')).click(); 'read'",
);
out.readerRendered = await waitForOr("!!document.querySelector('.view-reader')", 10000);
out.readerVoicePicked = await evaluate(
  "document.querySelector('.voice-select')?.textContent.includes('Mock Voice') ?? false",
);
out.readerRenderDelta = (await evaluate('window.__PAGE_TURN__.renders()')) - rendersBefore;

// ---- 4. LAN scan over the loopback subnet -----------------------------------
await evaluate(
  "[...document.querySelectorAll('.nav-link')].find(b => b.textContent.includes('Settings')).click(); 'settings'",
);
await waitFor("!!document.getElementById('lan-subnet')", 10000, 'lan subnet input');
await evaluate("document.getElementById('lan-subnet').value = '127.0.0'; 'typed'");
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Scan local network')).click(); 'clicked'",
);
out.lanHitAppeared = await waitForOr(
  "[...document.querySelectorAll('.lan-row')].some(r => r.textContent.includes('127.0.0.1') && r.textContent.includes('reachable'))",
  60000,
  'LAN row for 127.0.0.1',
);
out.lanRows = await evaluate(
  "[...document.querySelectorAll('.lan-row')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())",
);
await evaluate(
  "[...document.querySelectorAll('.lan-row')].find(r => r.textContent.includes('127.0.0.1')).querySelector('button').click(); 'used-lan'",
);
out.modelAfterLanUse = await evaluate(
  'document.querySelector(\'input[list="discovered-models"]\').value',
);

console.log(JSON.stringify(out, null, 2));

const ok =
  out.connectedToast === true &&
  out.savedAfterTest?.model === 'mock-poet-3b' &&
  out.titleCards === true &&
  out.page1Appeared === true &&
  (out.page1Text ?? '').includes('The letter') &&
  out.paragraphTools === true &&
  out.spineNav === true &&
  out.castPanel === true &&
  out.versionPicker === true &&
  out.turnPanelAppeared === true &&
  out.emotionDials === true &&
  out.standingRules === true &&
  out.modelAfterOllamaUse === 'mock-ollama-7b' &&
  out.page2Appeared === true &&
  (out.page2Text ?? '').includes('The letter') &&
  out.archiveAppeared === true &&
  out.replayHighlighted === true &&
  out.readerRendered === true &&
  out.readerVoicePicked === true &&
  out.readerRenderDelta <= 10 &&
  out.lanHitAppeared === true &&
  out.modelAfterLanUse === 'mock-poet-3b';
ws.close();
process.exit(ok ? 0 : 1);
