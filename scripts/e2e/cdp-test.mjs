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

async function changeValue(selector, value, event = 'change') {
  await evaluate(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    control.value = ${JSON.stringify(value)};
    control.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true }));
  })()`);
}

async function fontOf(selector) {
  return evaluate(
    `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).fontFamily`,
  );
}

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

// Appearance must survive navigation and must not wipe an unsaved endpoint.
await changeValue('input[list="discovered-models"]', 'unsaved-model', 'input');
const formats = ['story', 'letter', 'diary', 'newspaper', 'mapnote', 'recipe'];
const fonts = ['georgia', 'palatino', 'charter', 'serif', 'sans'];
const readingFonts = {};
out.wardrobeFontsMatch = true;
for (const font of fonts) {
  await changeValue('#reading-font', font);
  readingFonts[font] = await fontOf('.brand');
  for (const format of formats) {
    await changeValue(`.wardrobe-select[data-format="${format}"]`, font);
    // Exercise the built CSS in the browser, including every document class.
    const actual = await evaluate(`(() => {
      const sample = document.createElement('div');
      sample.className = 'page-text doc-${format}';
      document.querySelector('.main').append(sample);
      const family = getComputedStyle(sample).fontFamily;
      sample.remove();
      return family;
    })()`);
    out.wardrobeFontsMatch &&= actual === readingFonts[font];
  }
}
out.readingFontsDistinct = new Set(Object.values(readingFonts)).size === fonts.length;
for (const format of formats) {
  await changeValue(`.wardrobe-select[data-format="${format}"]`, 'auto');
}
await changeValue('#reading-font', 'palatino');
out.autoFontsFollowReadingFont = await evaluate(`(() => {
  const expected = getComputedStyle(document.querySelector('.brand')).fontFamily;
  return ${JSON.stringify(formats)}.every(format => {
    const sample = document.createElement('div');
    sample.className = 'page-text doc-' + format;
    document.querySelector('.main').append(sample);
    const actual = getComputedStyle(sample).fontFamily;
    sample.style.fontFamily = 'var(--mono)';
    const mono = getComputedStyle(sample).fontFamily;
    sample.remove();
    return actual === (format === 'mapnote' ? mono : expected);
  });
})()`);
out.mapnoteAutoLabel = await evaluate(
  `document.querySelector('.wardrobe-select[data-format="mapnote"] option[value="auto"]').textContent.includes('monospace')`,
);
await changeValue('.wardrobe-select[data-format="story"]', 'sans');
await changeValue('.wardrobe-select[data-format="letter"]', 'charter');
await changeValue('.font-scale', '1.2');
out.appearanceKeepsEndpointDraft = await evaluate(
  `document.querySelector('input[list="discovered-models"]').value === 'unsaved-model' && window.__PAGE_TURN__.model().model === 'mock-poet-3b'`,
);
await changeValue('input[list="discovered-models"]', 'mock-poet-3b', 'input');

// ---- 2. New book: seed → titles → page 1 streams SSE -----------------------
await evaluate(
  "[...document.querySelectorAll('.nav-link')].find(b => b.textContent.includes('New book')).click(); 'seed'",
);
await waitFor("!!document.querySelector('.seed-input')", 10000, 'seed view');
// The seed input is a controlled draft now (typing survives re-renders), so
// drive it like a real keystroke: setter + input event.
await evaluate(`(() => {
  const input = document.querySelector('.seed-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(input, 'A lighthouse keeper finds a letter.');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()`);
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
// Page one is a real page turn now: the title leads to the turn console.
out.firstTurnAppeared = await waitFor(
  "!!document.querySelector('.turn-panel')",
  10000,
  'turn console for page one',
);
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Generate next page')).click(); 'generate-page-one'",
);
// The header's "being processed" light must show while the model works.
out.workingLight = await waitFor(
  "!!document.querySelector('#nav-working') && document.querySelector('#nav-working').style.display !== 'none'",
  8000,
  'header processing light',
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
out.storyFontApplied = (await fontOf('.view-page .page-text')) === readingFonts.sans;
out.textScaleApplied = await evaluate(
  "Math.abs(parseFloat(getComputedStyle(document.querySelector('.view-page .page-text')).fontSize) - 16 * 1.2 * 1.16) < 0.01",
);
// The page workshop: paragraph tools, story spine, living cast, version picker.
out.paragraphTools = await evaluate(
  "document.querySelectorAll('.view-page .para-tool').length > 0",
);
// Selection-based span toolbar (word/sentence control): select text, expect
// the floating toolbar, switch to Edit mode, then cancel it cleanly.
await evaluate(`(() => {
  const para = document.querySelector('.view-page .para-body');
  const range = document.createRange();
  range.setStart(para.firstChild, 0);
  range.setEnd(para.firstChild, 12);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  para.closest('.page-craft').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return 'selected';
})()`);
out.spanToolbarAppeared = await waitFor(
  "!!document.querySelector('.span-toolbar')",
  5000,
  'span toolbar',
);
await evaluate(
  "[...document.querySelectorAll('.span-toolbar button')].find(b => b.textContent.includes('Edit')).click(); 'edit'",
);
out.spanEditAppeared = await waitFor(
  "!!document.querySelector('.span-toolbar textarea')",
  5000,
  'span edit box',
);
await evaluate(
  "[...document.querySelectorAll('.span-toolbar button')].find(b => b.textContent.includes('Cancel')).click(); 'cancelled'",
);
out.spanToolbarGone = await waitFor(
  "!document.querySelector('.span-toolbar')",
  5000,
  'span toolbar dismissed',
);
out.spineNav = await evaluate("!!document.querySelector('.view-page .spine')");
out.castPanel = await evaluate("!!document.querySelector('.view-page .cast')");
out.versionPicker = await evaluate("!!document.querySelector('.view-page .version-picker')");
out.lintCard = await evaluate("!!document.querySelector('.view-page .lint-card')");
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
out.turnStoryFontApplied = (await fontOf('.faded-text')) === readingFonts.sans;

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
// Library search regression: typing a query must NOT hide every book.
await evaluate(`(() => {
  const input = document.querySelector('.search');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'The Dead Letter');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()`);
out.searchKeepsBooks = await waitFor(
  "!!document.querySelector('.book-card') && document.querySelector('.book-card').style.display !== 'none'",
  5000,
  'search shows matching books',
);
out.bookCover = await waitFor(
  "!!document.querySelector('.book-card .book-cover')",
  5000,
  'book cover painted',
);
out.shelfStats = await waitFor(
  "!!document.querySelector('.shelf-stats')",
  5000,
  'shelf stats strip',
);
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
await changeValue('.turn-panel select:has(option[value="letter"])', 'letter');
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Generate next page')).click(); 'next'",
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
out.letterFontApplied = (await fontOf('.view-page .page-text')) === readingFonts.charter;

// Cast CRUD: add TWO people, then a relationship between them.
const addPerson = async (name) => {
  await evaluate(
    "[...document.querySelectorAll('.cast .cast-group-head button')].find(b => b.textContent.includes('person')).click(); 'add-person'",
  );
  await waitFor("!!document.querySelector('.cast-form')", 5000, 'cast add form');
  await evaluate(`(() => {
    const input = document.querySelector('.cast-form input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(name)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
  await evaluate(
    "[...document.querySelectorAll('.cast-form button')].find(b => b.textContent.includes('Save')).click(); 'saved-person'",
  );
};
await addPerson('Mara');
out.castPersonAdded = await waitFor(
  "[...document.querySelectorAll('.cast-entry .cast-name')].some(n => n.textContent.includes('Mara'))",
  5000,
  'Mara in the cast',
);
await addPerson('Joss');
await waitFor(
  "[...document.querySelectorAll('.cast-entry .cast-name')].some(n => n.textContent.includes('Joss'))",
  5000,
  'Joss in the cast',
);
await evaluate(
  "[...document.querySelectorAll('.cast-relations button')].find(b => b.textContent.includes('relationship')).click(); 'add-relation'",
);
await waitFor("!!document.querySelector('.rel-form')", 5000, 'relation form');
await evaluate(`(() => {
  const selects = document.querySelectorAll('.rel-form select');
  const kind = document.querySelector('.rel-form .rel-kind');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(selects[0], 'Mara');
  selects[0].dispatchEvent(new Event('change', { bubbles: true }));
  setter.call(selects[1], 'Joss');
  selects[1].dispatchEvent(new Event('change', { bubbles: true }));
  const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  inputSetter.call(kind, 'sisters');
  kind.dispatchEvent(new Event('input', { bubbles: true }));
  return 'filled';
})()`);
await evaluate(
  "[...document.querySelectorAll('.rel-form button')].find(b => b.textContent.includes('Add')).click(); 'added-relation'",
);
out.relationAdded = await waitFor(
  "[...document.querySelectorAll('.rel-list .cast-name')].some(n => n.textContent.includes('sisters'))",
  5000,
  'relationship recorded',
);
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Keep this page')).click()",
);
out.turnLetterFontApplied = (await fontOf('.faded-text')) === readingFonts.charter;

// ---- 3b. Story map renders the tree as a timeline --------------------------
await evaluate(
  "[...document.querySelectorAll('.nav-link')].find(b => b.textContent.includes('Story map')).click(); 'archive'",
);
out.archiveAppeared = await waitFor(
  "!!document.querySelector('.archive-timeline') && document.querySelectorAll('.archive-entry').length >= 2",
  10000,
  'story map with two timeline entries',
);
for (let i = 0; i < 2; i++) {
  await evaluate(
    "[...document.querySelectorAll('.archive-entry button')].find(b => b.textContent === '◧ Compare').click()",
  );
}
out.comparisonFontsApplied =
  (await fontOf('.compare-text.doc-story')) === readingFonts.sans &&
  (await fontOf('.compare-text.doc-letter')) === readingFonts.charter;

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
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Begin reading')).click()",
);
out.readerStoryFontApplied = (await fontOf('.reader-sheet .page-text')) === readingFonts.sans;
await evaluate('document.querySelector(\'button[title="Next page (→)"]\').click()');
out.readerLetterFontApplied = (await fontOf('.reader-sheet .page-text')) === readingFonts.charter;

// ---- 4. LAN scan over the loopback subnet -----------------------------------
// Theme regression: sepia must re-skin the document AND the wall behind it.
await evaluate(
  "[...document.querySelectorAll('.nav-link')].find(b => b.textContent.includes('Settings')).click(); 'settings'",
);
await waitFor("!!document.querySelector('.view-settings')", 10000, 'settings for theme');
await evaluate(
  "[...document.querySelectorAll('.segmented .seg')].find(b => b.textContent === 'sepia').click(); 'sepia'",
);
out.themeApplied = await waitFor(
  "document.documentElement.dataset.theme === 'sepia'",
  5000,
  'sepia theme applied',
);
out.wallChanged = await evaluate(
  "(getComputedStyle(document.body).backgroundImage !== '' && getComputedStyle(document.body).backgroundImage.includes('radial-gradient')) ? true : false",
);
await evaluate(
  "[...document.querySelectorAll('.segmented .seg')].find(b => b.textContent === 'dark').click(); 'dark-again'",
);
await evaluate(
  "[...document.querySelectorAll('.nav-link')].find(b => b.textContent.includes('Settings')).click(); 'settings-again'",
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

// Reload from durable storage, not just the in-memory settings draft.
await sleep(1000);
await send('Page.reload');
await waitFor("!!document.querySelector('#reading-font')", 10000, 'settings after reload');
out.appearanceSurvivesReload = await evaluate(`(() => {
  return document.querySelector('#reading-font').value === 'palatino' &&
    document.querySelector('.wardrobe-select[data-format="story"]').value === 'sans' &&
    document.querySelector('.wardrobe-select[data-format="letter"]').value === 'charter' &&
    document.querySelector('.font-scale').value === '1.2' &&
    document.documentElement.dataset.font === 'palatino';
})()`);
await evaluate(
  "[...document.querySelectorAll('.nav-link')].find(b => b.textContent.includes('Library')).click()",
);
await evaluate(
  "[...document.querySelectorAll('.book-card button')].find(b => b.textContent.includes('Continue')).click()",
);
out.reloadedPageFontApplied = (await fontOf('.view-page .page-text')) === readingFonts.charter;

// The finished-book screen must keep the closing page's document typography.
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Keep this page')).click()",
);
await evaluate(
  "[...document.querySelectorAll('label')].find(l => l.textContent.includes('Bring the story to a close')).querySelector('input').click()",
);
await changeValue('.turn-panel select:has(option[value="letter"])', 'letter');
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Generate next page')).click()",
);
await waitFor(
  "[...document.querySelectorAll('button')].some(b => b.textContent.includes('keep this closing page'))",
  30000,
  'closing page',
);
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('keep this closing page')).click()",
);
out.endingFontApplied = (await fontOf('.view-theend .page-text')) === readingFonts.charter;

console.log(JSON.stringify(out, null, 2));

const ok =
  out.connectedToast === true &&
  out.savedAfterTest?.model === 'mock-poet-3b' &&
  out.titleCards === true &&
  out.firstTurnAppeared === true &&
  out.workingLight === true &&
  out.page1Appeared === true &&
  (out.page1Text ?? '').includes('The letter') &&
  out.paragraphTools === true &&
  out.spanToolbarAppeared === true &&
  out.spanEditAppeared === true &&
  out.spanToolbarGone === true &&
  out.spineNav === true &&
  out.castPanel === true &&
  out.versionPicker === true &&
  out.lintCard === true &&
  out.turnPanelAppeared === true &&
  out.emotionDials === true &&
  out.standingRules === true &&
  out.searchKeepsBooks === true &&
  out.bookCover === true &&
  out.shelfStats === true &&
  out.modelAfterOllamaUse === 'mock-ollama-7b' &&
  out.page2Appeared === true &&
  (out.page2Text ?? '').includes('The letter') &&
  out.castPersonAdded === true &&
  out.relationAdded === true &&
  out.archiveAppeared === true &&
  out.replayHighlighted === true &&
  out.readerRendered === true &&
  out.readerVoicePicked === true &&
  out.readerRenderDelta <= 10 &&
  out.themeApplied === true &&
  out.wallChanged === true &&
  out.wardrobeFontsMatch === true &&
  out.readingFontsDistinct === true &&
  out.autoFontsFollowReadingFont === true &&
  out.mapnoteAutoLabel === true &&
  out.appearanceKeepsEndpointDraft === true &&
  out.storyFontApplied === true &&
  out.textScaleApplied === true &&
  out.turnStoryFontApplied === true &&
  out.letterFontApplied === true &&
  out.turnLetterFontApplied === true &&
  out.comparisonFontsApplied === true &&
  out.readerStoryFontApplied === true &&
  out.readerLetterFontApplied === true &&
  out.appearanceSurvivesReload === true &&
  out.reloadedPageFontApplied === true &&
  out.endingFontApplied === true &&
  out.lanHitAppeared === true &&
  out.modelAfterLanUse === 'mock-poet-3b';
ws.close();
process.exit(ok ? 0 : 1);
