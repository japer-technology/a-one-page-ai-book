// Verifies the LAN sweep is legible, honest and bounded:
//   - the size of a sweep is stated before it starts, and the live progress
//     keeps the range and the ports on screen (a reader watching the network
//     panel sees the count race past a thousand and reasonably concludes the
//     app has lost control);
//   - a subnet that has not answered is NOT swept by the one-button scan, and
//     says so, because sweeping a range that is not ours leaves the browser
//     busy for minutes;
//   - an explicit sweep of a subnet that DOES contain the mock server finds and
//     identifies it;
//   - a sweep the reader CANCELS is never reported as the confident, wrong
//     diagnosis "No LLM servers found".
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
    texts: [document.querySelector('#lan-progress'), document.querySelector('#net-line')]
      .map(n => n?.textContent ?? '')
      .filter(t => /scanning|scanned|server\\(s\\) on|nothing answered|stopped|not swept/.test(t)),
    cancel: [...document.querySelectorAll('#llm-setup button')].some(b => /Cancel scan/.test(b.textContent)),
    rows: [...document.querySelectorAll('.lan-row')].map(r => r.textContent.replace(/\\s+/g, ' ').trim()),
    toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent),
  }))()`);
/** Wait for a verdict that mentions THIS subnet (older verdicts stay on screen). */
const waitForVerdict = async (base, timeoutMs = 60000) => {
  const needle = new RegExp(
    `(stopped|server\\(s\\) on|nothing answered on|not swept)[^]*${base.replace(/\./g, '\\.')}`,
  );
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await scanState();
    if (state.texts.some((t) => needle.test(t))) return state;
    await sleep(400);
  }
  return scanState();
};

await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(2500);
await ev("location.hash='#/settings';'s'");
// Detection decides which subnet is swept; wait for its verdict rather than
// guessing at how long it takes.
for (let i = 0; i < 60; i++) {
  const line = await ev("document.querySelector('#net-line')?.textContent ?? ''");
  if (line && !/Looking for your network/.test(line)) break;
  await sleep(250);
}
await sleep(400);

// The network the app worked out for itself, read BEFORE any test touches the
// subnet box (which the net line also reflects).
const detectedLine = await ev("document.querySelector('#net-line')?.textContent ?? ''");
const chipBase = await ev(
  "[...document.querySelectorAll('.subnet-chips .btn-chip')].find(c => c.textContent.includes('✓'))?.textContent.replace(' ✓','') ?? ''",
);
const detectedBase =
  (detectedLine.match(/(\d{1,3}\.\d{1,3}\.\d{1,3})\.0\/24/) ?? [])[1] ?? chipBase ?? '';

// ── 1. the size is stated up front ─────────────────────────────────────────
const hint = await ev(`(() => {
  const p = [...document.querySelectorAll('.view-settings .field-hint')].find(e => /up to 254 addresses/.test(e.textContent));
  return p ? p.textContent : '';
})()`);
check(
  'the sweep size is stated before scanning',
  /254 addresses/.test(hint) && /cancellable/.test(hint),
  hint.slice(0, 110),
);

// ── 2. an unverified subnet is not swept by the plain scan ─────────────────
await ev("document.querySelectorAll('.toast').forEach(t => t.remove()); 'clear'");
await setSubnet('10.99.99');
await ev("document.querySelector('#llm-setup .btn-primary')?.click();'start'");
const skipped = await waitForVerdict('10.99.99', 20000);
check(
  'a plain scan says it is not sweeping a subnet nothing answered on',
  skipped.texts.some((t) => /not swept/.test(t)),
  JSON.stringify(skipped.texts),
);

// ── 3. a detected network is swept by the plain scan, and cancels honestly ─
// The subnet under test is the one the app detected for real, not a made-up
// range: sweeping a range that is not ours blackholes thousands of connect
// attempts and leaves the whole browser slow for minutes, which would make
// every later check meaningless.
check(
  'the app worked out which network this machine is on',
  detectedBase !== '',
  `${detectedLine.slice(0, 120)} | base=${detectedBase}`,
);
if (detectedBase) {
  await ev("document.querySelectorAll('.toast').forEach(t => t.remove()); 'clear'");
  await setSubnet(detectedBase);
  await ev("document.querySelector('#llm-setup .btn-primary')?.click();'start2'");
  await sleep(2500);
  const running = await scanState();
  const escaped = detectedBase.replace(/\./g, '\\.');
  check(
    'the live progress names the range, the ports and how far it has got',
    running.texts.some(
      (t) =>
        new RegExp(`${escaped}\\.1–254`).test(t) &&
        /[0-9]+ ports/.test(t) &&
        /\d+\/254 scanned/.test(t),
    ),
    JSON.stringify(running.texts.slice(0, 2)),
  );
  check('the button offers to cancel', running.cancel === true);
  await ev("document.querySelector('#llm-setup .btn-danger')?.click();'cancel'");
  const cancelled = await waitForVerdict(detectedBase, 30000);
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
}

// ── 4. a sweep that contains the mock server finds it ─────────────────────
await ev("document.querySelectorAll('.toast').forEach(t => t.remove()); 'clear'");
await setSubnet('127.0.0');
await ev("document.querySelector('#lan-sweep-anyway')?.click();'start3'");
const found = await waitForVerdict('127.0.0', 90000);
check(
  'the sweep found and identified the mock server',
  found.rows.some((r) => /127\.0\.0\.1:(1234|11434)/.test(r)),
  JSON.stringify({ rows: found.rows.slice(0, 2), texts: found.texts.slice(-2) }),
);
check(
  'finding a server raises no error toast',
  !found.toasts.some((t) => /could not|failed|error/i.test(t)),
  JSON.stringify(found.toasts),
);
check(
  'the summary counts the server it found',
  found.texts.some((t) => /\d+ server\(s\) on 127\.0\.0/.test(t)),
  JSON.stringify(found.texts.slice(-2)),
);

check('no console errors', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)));
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${failures.length} check(s) failed`);
ws.close();
process.exit(failures.length === 0 ? 0 : 1);
