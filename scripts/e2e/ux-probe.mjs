// UX probe: verify the world-class-UX fixes in the real app over CDP.
//   node scripts/e2e/ux-probe.mjs  (mock LLM + chromium must be running)
const CDP_BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await fetch(`${CDP_BASE}/json`).then((r) => r.json());
const target = targets.find((t) => t.type === 'page');
if (!target) throw new Error('no page target');
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
    await sleep(200);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const out = {};

// ---- 1. Configure the endpoint ----------------------------------------------
await waitFor("!!document.querySelector('.view-settings')", 10000, 'settings');
await evaluate(
  "[...document.querySelectorAll('.view-settings .btn-primary')].find(b => b.textContent.includes('Scan'))?.click(); 'scan'",
);
await waitFor(
  "[...document.querySelectorAll('.scan-row')].some(r => r.textContent.includes('reachable'))",
  40000,
  'reachable row',
);
await evaluate(
  "[...document.querySelectorAll('.scan-row')].find(r => r.textContent.includes('reachable')).querySelector('button').click(); 'use'",
);
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Test connection')).click(); 'test'",
);
await waitFor(
  "[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Connected'))",
  30000,
  'connected',
);

// ---- 2. Unsaved endpoint edits survive appearance previews -------------------
await evaluate(`(() => {
  const input = document.querySelector('input[list="endpoint-presets"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'http://127.0.0.1:9999/custom');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()`);
await evaluate(
  "[...document.querySelectorAll('.segmented .seg')].find(b => b.textContent === 'sepia').click(); 'sepia'",
);
await sleep(300);
out.urlSurvivedTheme = await evaluate(
  "document.querySelector('input[list=\"endpoint-presets\"]').value === 'http://127.0.0.1:9999/custom'",
);
await evaluate(
  "[...document.querySelectorAll('.segmented .seg')].find(b => b.textContent === 'dark').click(); 'dark-again'",
);
await sleep(300);
out.urlSurvivedThemeAgain = await evaluate(
  "document.querySelector('input[list=\"endpoint-presets\"]').value === 'http://127.0.0.1:9999/custom'",
);
// Restore the scanned URL so later steps work.
await evaluate(`(() => {
  const input = document.querySelector('input[list="endpoint-presets"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'http://127.0.0.1:1234');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'restored';
})()`);

// ---- 3. New book → titles → turn focus + sticky submit bar -------------------
await evaluate(
  "[...document.querySelectorAll('.nav-link')].find(b => b.textContent.includes('New book')).click(); 'seed'",
);
await waitFor("!!document.querySelector('.seed-input')", 10000, 'seed view');
await evaluate(`(() => {
  const input = document.querySelector('.seed-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(input, 'A lighthouse keeper finds a letter.');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()`);
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Begin')).click(); 'begin'",
);
await waitFor("document.querySelectorAll('.title-card').length >= 5", 30000, 'five titles');
await evaluate("document.querySelector('.title-card').click(); 'select'");
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Use this title')).click(); 'use'",
);
await waitFor("!!document.querySelector('.turn-panel')", 10000, 'turn console');
await sleep(400);
out.turnFocusOnDirection = await evaluate(
  "document.activeElement === document.querySelector('.direction-input')",
);
out.stickySubmitBar = await evaluate("!!document.querySelector('.turn-submit')");

// ---- 4. Generate page 1, keep it ---------------------------------------------
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Generate next page')).click(); 'gen'",
);
await waitFor(
  "[...document.querySelectorAll('.view-page .page-num')].some(n => n.textContent.includes('Page 1'))",
  30000,
  'page 1',
);
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Keep this page')).click(); 'keep'",
);
await waitFor("!!document.querySelector('.turn-panel')", 10000, 'turn again');

// ---- 5. Iron Author gates re-rolls -------------------------------------------
await evaluate(
  "[...document.querySelectorAll('.nav-link')].find(b => b.textContent.includes('Library')).click(); 'library'",
);
await waitFor("!!document.querySelector('.book-card')", 10000, 'book card');
await evaluate("document.querySelector('.book-card .menu-btn').click(); 'menu'");
await evaluate(
  "[...document.querySelectorAll('.menu-item')].find(b => b.textContent.includes('iron (no re-rolls)')).click(); 'iron'",
);
await evaluate("document.querySelector('.book-card .btn-primary').click(); 'continue'");
await waitFor("!!document.querySelector('.view-page .page-text')", 10000, 'page view');
const versionsBefore = await evaluate("document.querySelector('.version-now').textContent");
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Regenerate')).click(); 'regen'",
);
await sleep(600);
out.ironToast = await evaluate(
  "[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Iron Author'))",
);
out.versionsAfterIron = await evaluate("document.querySelector('.version-now').textContent");
out.ironGated = versionsBefore === out.versionsAfterIron;

// ---- 6. Focus-visible styles exist for keyboard users ------------------------
out.focusVisibleRule = await evaluate(`(() => {
  const sheets = [...document.styleSheets];
  let found = false;
  for (const sheet of sheets) {
    try {
      for (const rule of sheet.cssRules) {
        if (rule.selectorText && rule.selectorText.includes(':focus-visible')) { found = true; break; }
      }
    } catch { /* cross-origin sheet */ }
    if (found) break;
  }
  return found;
})()`);

console.log(JSON.stringify(out, null, 2));
ws.close();
process.exit(0);
