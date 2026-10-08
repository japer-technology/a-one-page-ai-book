// Verify how a FAILED background upkeep is reported: with a book that has only
// a first page, the automatic cast refresh cannot be parsed. The reader must
// not get a red "LLM API call failed" toast; the cast panel must say so, and
// its own Retry (an explicit click) must report normally.
const CDP_BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await fetch(`${CDP_BASE}/json`).then((r) => r.json());
const target =
  targets.find((t) => t.type === 'page' && String(t.url).includes('page-turn.html')) ??
  targets.find((t) => t.type === 'page' && !String(t.url).startsWith('chrome-extension'));
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
    throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 300));
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

const state = () =>
  evaluate(`(() => ({
    view: window.__PAGE_TURN__.view(),
    toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
    castState: document.querySelector('.cast-state-error')?.textContent.trim() ?? null,
    castError: document.querySelector('.cast-body .banner-error')?.textContent.trim() ?? null,
  }))()`);

// ── setup ───────────────────────────────────────────────────────────────────
await send('Page.enable');
await evaluate("location.hash = '#/settings'; 'hash'");
await sleep(600);
await waitFor("!!document.querySelector('.view-settings')", 20000, 'settings');
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Scan'))?.click(); 'scan'",
);
await waitFor(
  "[...document.querySelectorAll('.scan-row')].some(r => r.textContent.includes('reachable'))",
  40000,
  'reachable row',
);
await evaluate(
  "[...document.querySelectorAll('.scan-row')].find(r => r.textContent.includes('reachable')).querySelector('button').click(); 'use'",
);
await evaluate("document.querySelector('#endpoint-save-test').click(); 'test'");
await waitFor(
  "[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Connected'))",
  30000,
  'connected',
);
await evaluate(
  "[...document.querySelectorAll('.nav-link')].find(b => b.textContent.includes('New book'))?.click(); 'seed'",
);
await waitFor("!!document.querySelector('.seed-input')", 10000, 'seed');
await evaluate(`(() => {
  const input = document.querySelector('.seed-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(input, 'A lighthouse keeper finds a letter addressed to someone who died a hundred years ago.');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()`);
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Begin'))?.click(); 'begin'",
);
await waitFor("document.querySelectorAll('.title-card').length >= 1", 40000, 'titles');
await evaluate("document.querySelector('.title-card').click(); 'select'");
await sleep(300);
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Use this title'))?.click(); 'use'",
);
await waitFor("window.__PAGE_TURN__.view() === 'turn'", 20000, 'turn');
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Generate next page'))?.click(); 'gen'",
);
await waitFor("!!document.querySelector('.page-text')", 60000, 'page 1');
await sleep(3000);

// Clear the page-1 success toasts so only upkeep noise would remain.
await evaluate("document.querySelectorAll('.toast').forEach(t => t.remove()); 'cleared'");
await sleep(2500);

const failures = [];
const check = (label, ok, detail) => {
  console.log(
    `${ok ? '\u2713' : '\u2717'} ${label}${detail === undefined ? '' : ` \u2014 ${detail}`}`,
  );
  if (!ok) failures.push(label);
};

console.log('\n=== the automatic upkeep failed after page 1 ===');
const auto = await state();
check(
  'no red toast for a fire-and-forget upkeep failure',
  auto.toasts.length === 0,
  JSON.stringify(auto.toasts),
);
check(
  'the cast panel says the update failed',
  auto.castState === 'cast update failed',
  String(auto.castState),
);
check(
  'the panel shows the reason and a retry',
  /Retry/.test(auto.castError ?? ''),
  String(auto.castError),
);

// The panel's own Retry is an explicit click: it must report normally.
await evaluate(
  "[...document.querySelectorAll('.cast-body button')].find(b => b.textContent.trim() === 'Retry')?.click(); 'retry'",
);
await sleep(2500);
console.log("\n=== after clicking the cast panel's Retry (manual) ===");
const manual = await state();
check('an explicit retry DOES report', manual.toasts.length === 1, JSON.stringify(manual.toasts));

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${failures.length} check(s) failed`);
ws.close();
process.exit(failures.length === 0 ? 0 : 1);
