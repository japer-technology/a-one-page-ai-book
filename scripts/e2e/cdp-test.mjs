// Drive the REAL built app in headless Chromium over the Chrome DevTools
// Protocol: click Scan, wait for a reachable row, click Use, Save, then Test
// connection — asserting the whole discovery-to-generation chain against
// scripts/e2e/mock-llm.mjs. Chromium is launched by run.sh, already pointed
// at the app URL.
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

const out = {};
out.booted = await waitFor(
  "!!document.querySelector('.view-settings')",
  10000,
  'settings view render',
);
out.scanClicked = await evaluate(
  "document.querySelector('.view-settings .btn-primary').click(); 'clicked'",
);
out.reachableAppeared = await waitFor(
  "[...document.querySelectorAll('.scan-row')].some(r => r.textContent.includes('reachable'))",
  40000,
  'a reachable scan row',
);
out.scanRows = await evaluate(
  "[...document.querySelectorAll('.scan-row')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())",
);
out.used = await evaluate(
  "[...document.querySelectorAll('.scan-row')].find(r => r.textContent.includes('reachable')).querySelector('button').click(); 'used'",
);
out.modelAfterUse = await evaluate(
  'document.querySelector(\'input[list="discovered-models"]\').value',
);
out.saved = await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Save')).click(); 'saved'",
);
out.testClicked = await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Test connection')).click(); 'clicked'",
);
try {
  out.connectedToast = await waitFor(
    "[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Connected'))",
    30000,
    'Connected toast',
  );
} catch {
  out.connectedToast = false;
}
out.toasts = await evaluate("[...document.querySelectorAll('.toast')].map(t => t.textContent)");
out.modelField = await evaluate(
  'document.querySelector(\'input[list="discovered-models"]\').value',
);
out.urlField = await evaluate('document.querySelector(\'input[list="endpoint-presets"]\').value');

// ---- LAN scan over the loopback subnet (proves the grid logic in-browser) ----
out.lanSubnetTyped = await evaluate(
  "(() => { const i = document.getElementById('lan-subnet'); if (!i) return 'missing'; i.value = '127.0.0'; return 'typed'; })()",
);
out.lanClicked = await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Scan local network')).click(); 'clicked'",
);
try {
  out.lanHitAppeared = await waitFor(
    "[...document.querySelectorAll('.lan-row')].some(r => r.textContent.includes('127.0.0.1') && r.textContent.includes('reachable'))",
    60000,
    'a LAN row for 127.0.0.1',
  );
} catch {
  out.lanHitAppeared = false;
}
out.lanRows = await evaluate(
  "[...document.querySelectorAll('.lan-row')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())",
);
out.lanUsed = await evaluate(
  "[...document.querySelectorAll('.lan-row')].find(r => r.textContent.includes('127.0.0.1')).querySelector('button').click(); 'used'",
);
out.modelAfterLanUse = await evaluate(
  'document.querySelector(\'input[list="discovered-models"]\').value',
);
console.log(JSON.stringify(out, null, 2));

const ok =
  out.connectedToast === true &&
  out.modelField.length > 0 &&
  out.urlField === 'http://127.0.0.1:1234' &&
  out.lanHitAppeared === true &&
  out.modelAfterLanUse === 'mock-poet-3b';
ws.close();
process.exit(ok ? 0 : 1);
