// Verifies the LAN sweep is legible and honest:
//   - the size of a sweep is stated BEFORE it starts (a reader watching the
//     network panel see the count race past a thousand and reasonably conclude
//     the app has lost control);
//   - a sweep that finds the mock server reports it;
//   - a sweep the reader CANCELS is never reported as the confident, wrong
//     diagnosis "No LLM servers found — check the firewall".
// Run: bash scripts/e2e/dev-up.sh && node scripts/e2e/lan-scan.mjs
const CDP_BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await fetch(`${CDP_BASE}/json`).then((r) => r.json());
const target =
  targets.find((t) => t.type === 'page' && String(t.url).includes('page-turn.html')) ??
  targets.find((t) => t.type === 'page' && !String(t.url).startsWith('chrome-extension'));
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails?.text);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r));
};
await send('Runtime.enable');
async function ev(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result?.exceptionDetails)
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
}
const failures = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
};

const setSubnet = (value) =>
  ev(`(() => {
    const field = document.querySelector('.lan-subnet');
    if (!field) return 'no field';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
const scanState = () =>
  ev(`(() => ({
    texts: [...document.querySelectorAll('.view-settings span')].map(s => s.textContent).filter(t => /scanning|scanned|done:|stopped|probes/.test(t)),
    cancel: [...document.querySelectorAll('button')].some(b => /Cancel scan/.test(b.textContent)),
    rows: [...document.querySelectorAll('.lan-row')].map(r => r.textContent.replace(/\\s+/g, ' ').trim()),
    toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent),
  }))()`);

await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(2500);
await ev("location.hash='#/settings';'s'");
await sleep(1200);

// ── 1. the size is stated up front ─────────────────────────────────────────
const hint = await ev(`(() => {
  const p = [...document.querySelectorAll('.view-settings .field-hint')].find(e => /probes every address/.test(e.textContent));
  return p ? p.textContent : '';
})()`);
check(
  'the sweep size is stated before scanning',
  /~2\s?800|2 800 probes/.test(hint),
  hint.slice(0, 90),
);

// ── 2. a cancelled sweep is reported as stopped, not as "nothing found" ────
await ev("document.querySelectorAll('.toast').forEach(t => t.remove()); 'clear'");
await setSubnet('10.99.99');
await ev(
  "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Scan local network'))?.click();'start'",
);
await sleep(3000);
const running = await scanState();
check(
  'the live progress names the range, the ports and the probe budget',
  running.texts.some((t) => /10\.99\.99\.1–254/.test(t) && /ports/.test(t) && /probes/.test(t)),
  JSON.stringify(running.texts.slice(0, 2)),
);
check('the button offers to cancel', running.cancel === true);
await ev(
  "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Cancel scan'))?.click();'cancel'",
);
await sleep(1800);
const cancelled = await scanState();
check(
  'the cancelled sweep says it stopped',
  cancelled.texts.some((t) => /^stopped/.test(t)),
  JSON.stringify(cancelled.texts.slice(-2)),
);
check(
  'a cancelled sweep is NOT reported as “No LLM servers found”',
  !cancelled.toasts.some((t) => /No LLM servers found/.test(t)),
  JSON.stringify(cancelled.toasts),
);

// ── 3. a sweep that contains the mock server finds it ─────────────────────
await ev("document.querySelectorAll('.toast').forEach(t => t.remove()); 'clear'");
await setSubnet('127.0.0');
await ev(
  "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Scan local network'))?.click();'start2'",
);
await sleep(6000);
const found = await scanState();
check(
  'the sweep found and identified the mock server',
  found.rows.some((r) => /127\.0\.0\.1:1234/.test(r)) ||
    found.texts.some((t) => /1 responder/.test(t)),
  JSON.stringify({ rows: found.rows.slice(0, 2), texts: found.texts.slice(-2) }),
);
check(
  'finding a server raises no error toast',
  !found.toasts.some((t) => /could not|failed|error/i.test(t)),
  JSON.stringify(found.toasts),
);
// A sweep that DID find something must not claim otherwise.
check(
  'the summary counts the responder',
  found.texts.some((t) => /done: \d+ responder/.test(t)),
  JSON.stringify(found.texts.slice(-2)),
);

check('no console errors', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)));
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${failures.length} check(s) failed`);
ws.close();
process.exit(failures.length === 0 ? 0 : 1);
