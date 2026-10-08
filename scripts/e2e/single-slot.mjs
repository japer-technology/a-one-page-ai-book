// Regression test for the reported bug: "a book with only a first page shows
// errors about LLM API calls failing".
//
// Root cause: the app fired the living-cast refresh AND the rolling-summary
// refresh in the same tick as the page that had just landed. A local server
// with ONE generation slot — LM Studio's default, llama.cpp with `-np 1` —
// rejects the second concurrent request instead of queueing it, so the reader
// was shown red "LLM server responded …" notices about calls they never made.
//
// Run against a single-slot server:
//   PT_MOCK_SERIAL=1 bash scripts/e2e/dev-up.sh && node scripts/e2e/single-slot.mjs
// Exits non-zero when any error is shown, or when more than one request is in
// flight at a time.
const CDP_BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await fetch(`${CDP_BASE}/json`).then((r) => r.json());
const target =
  targets.find((t) => t.type === 'page' && String(t.url).includes('page-turn.html')) ??
  targets.find((t) => t.type === 'page' && !String(t.url).startsWith('chrome-extension'));
if (!target)
  throw new Error('no page target — is Chromium running with --remote-debugging-port=9222?');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('EXCEPTION ' + (msg.params.exceptionDetails?.text ?? ''));
  }
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
await send('Runtime.enable');
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.result?.exceptionDetails)
    throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 400));
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

const failures = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
};

/** Everything the app is complaining about right now. */
const complaints = () =>
  evaluate(`(() => ({
    view: window.__PAGE_TURN__.view(),
    toasts: [...document.querySelectorAll('.toast.toast-error')].map(t => t.textContent.trim()),
    banners: [...document.querySelectorAll('.banner-error')].map(t => t.textContent.trim().replace(/\\s+/g, ' ').slice(0, 140)),
    audit: window.__PAGE_TURN__.audit(),
  }))()`);

// ── Setup: endpoint + a book with exactly one page ───────────────────────────
console.log('• open settings');
await send('Page.enable');
await evaluate("location.hash = '#/settings'; 'hash'");
await sleep(600);
await waitFor("!!document.querySelector('.view-settings')", 20000, 'settings');

console.log('• scan for the local server');
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

console.log('• create a book and write page 1');
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
await sleep(3000); // let the background upkeep finish

console.log('\n=== the book with only a first page ===');
const afterPage1 = await complaints();
check('page 1 is on screen', afterPage1.view === 'page', afterPage1.view);
check('no error toast', afterPage1.toasts.length === 0, JSON.stringify(afterPage1.toasts));
check('no error banner', afterPage1.banners.length === 0, JSON.stringify(afterPage1.banners));

// Only what happened from the moment page 1 was asked for: the endpoint probe
// and the title batch before it are part of the setup, not of this claim.
const pageStart = afterPage1.audit.findIndex((line) => line.includes('generatePage start'));
const since = pageStart >= 0 ? afterPage1.audit.slice(pageStart) : afterPage1.audit;
const callMarkers = since.filter((line) => /llm(-json)? (start|ok|err)/.test(line));
const starts = callMarkers.filter((line) => /llm(-json)? start/.test(line)).length;
const ends = callMarkers.filter((line) => /llm(-json)? (ok|err)/.test(line)).length;
check('every request that started also finished', starts === ends, `${starts} start / ${ends} end`);
check(
  'no busy-server failure in the log',
  !afterPage1.audit.some((line) => /one request at a time|429|503|server is busy/i.test(line)),
);
check(
  'a first page costs one generation plus ONE upkeep call (the cast call, which the memory shares)',
  starts === 2,
  `${starts} request(s) since page 1 was asked for`,
);
check(
  'the OPFS mirror is not attempted on file:// (no SecurityError noise)',
  !afterPage1.audit.some((line) => /opfs/i.test(line)),
);

// ── Keep the page: the turn console must stay quiet too ──────────────────────
console.log('• keep the page');
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Keep this page'))?.click(); 'keep'",
);
await waitFor("window.__PAGE_TURN__.view() === 'turn'", 20000, 'turn');
await sleep(3000);
const onTurn = await complaints();
check(
  'no error toast on the turn console',
  onTurn.toasts.length === 0,
  JSON.stringify(onTurn.toasts),
);
check(
  'no error banner on the turn console',
  onTurn.banners.length === 0,
  JSON.stringify(onTurn.banners),
);

// ── The parallel candidate fan-out must serialize too ────────────────────────
console.log('• fan out two candidate versions');
await evaluate("window.location.hash = '#/library'; 'lib'");
await sleep(700);
await evaluate("document.querySelector('.book-card .btn-primary')?.click(); 'continue'");
await sleep(1200);
if ((await evaluate('window.__PAGE_TURN__.view()')) !== 'page') {
  // The frontier is the turn node: step back onto the page.
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Frontier'))?.click(); 'frontier'",
  );
  await sleep(900);
}
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Generate 2 more versions'))?.click(); 'cand'",
);
await sleep(4500);
const afterCandidates = await complaints();
check(
  'the fan-out produced versions with no error',
  afterCandidates.toasts.length === 0 && afterCandidates.banners.length === 0,
  JSON.stringify({ toasts: afterCandidates.toasts, banners: afterCandidates.banners }),
);
const versions = await evaluate(
  "document.querySelector('.version-now')?.textContent ?? '(no picker)'",
);
check('the version picker advanced past version 1', /of [2-9]/.test(versions), versions);

check('no console errors', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)));

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${failures.length} check(s) failed`);
ws.close();
process.exit(failures.length === 0 ? 0 : 1);
