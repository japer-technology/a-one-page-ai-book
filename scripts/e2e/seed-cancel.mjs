// Verifies the seed view's cancellation hygiene: a request the READER stopped
// (navigation aborts the in-flight call) is not a model failure.
//
//   - the pre-writing chat must not record a fake assistant turn
//     ("(The model didn't answer: Generation cancelled.)") for a reply nobody
//     was waiting for any more;
//   - a cancelled "I'm feeling lucky" roll must not toast a failure or fill the
//     seed box with a built-in idea behind the reader's back.
//
// The endpoint is pointed at a non-routable address (10.255.255.1) so the
// request genuinely hangs until navigation aborts it; the mock endpoint is
// restored at the end so later scripts are unaffected.
//
// Run: bash scripts/e2e/dev-up.sh && node scripts/e2e/seed-cancel.mjs
const CDP_BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await fetch(`${CDP_BASE}/json`).then((r) => r.json());
const target =
  targets.find((t) => t.type === 'page' && String(t.url).includes('page-turn.html')) ??
  targets.find((t) => t.type === 'page' && !String(t.url).startsWith('chrome-extension'));
if (!target) throw new Error('no page target — is Chromium running?');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
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
async function waitFor(expr, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ev(expr)) return true;
    await sleep(150);
  }
  console.log(`  !! TIMEOUT ${label}`);
  return false;
}
const failures = [];
const check = (label, ok, detail) => {
  console.log(
    `${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
  );
  if (!ok) failures.push(label);
};
const setValue = (selector, value) =>
  ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'missing';
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'set';
  })()`);
const clickText = (text) =>
  ev(
    `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim().includes(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`,
  );
/** Type an endpoint into the settings form and save it. */
async function useEndpoint(baseUrl, model) {
  await ev(`location.hash = '#/settings'; 'ok'`);
  await waitFor(`!!document.querySelector('.view-settings')`, 10000, 'settings');
  await setValue('input[list="endpoint-presets"]', baseUrl);
  await sleep(200);
  await ev(`(() => {
    const sel = document.querySelector('#endpoint-model');
    if (!sel) return 'no-select';
    const custom = [...sel.options].find(o => o.value === '\\u0000custom');
    if (custom) { sel.value = '\\u0000custom'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    return sel.value;
  })()`);
  await sleep(150);
  await ev(`(() => {
    const el = document.querySelector('#endpoint-model-custom');
    if (!el) return 'no-custom';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(model)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`);
  await sleep(150);
  await ev(`document.querySelector('#endpoint-save')?.click(); 'saved'`);
  await sleep(500);
}

// Fresh module state (the chat transcript and the lucky-idea pool are
// module-level) and the CURRENT build.
await send('Page.enable');
await send('Page.reload');
await sleep(2500);

// ── The endpoint becomes a black hole, so requests really hang ─────────────
await useEndpoint('http://10.255.255.1:1234', 'unreachable-model');

// ── 1. Chat: send, navigate away mid-reply, come back ─────────────────────
await ev(`location.hash = '#/seed'; 'seed'`);
await waitFor(`!!document.querySelector('.seed-input')`, 10000, 'seed view');
await ev(`document.querySelector('details.chat summary')?.click(); 'open'`);
await sleep(200);
await setValue('.chat-input', 'a story about a lighthouse');
await clickText('Send');
await sleep(250);
check(
  'the chat request is in flight',
  (await ev(`window.__PAGE_TURN__.requests().inFlight`)) > 0,
  await ev(`JSON.stringify(window.__PAGE_TURN__.requests())`),
);
await ev(`location.hash = '#/library'; 'away'`);
await sleep(1200);
await ev(`location.hash = '#/seed'; 'back'`);
await waitFor(`!!document.querySelector('.seed-input')`, 10000, 'seed again');
await ev(`document.querySelector('details.chat summary')?.click(); 'reopen'`);
await sleep(200);
const bubbles = await ev(`[...document.querySelectorAll('.chat-text')].map(n => n.textContent)`);
check(
  'no fake "didn’t answer" turn was recorded',
  !bubbles.some((b) => /didn’t answer|didn't answer|Generation cancelled/i.test(b ?? '')),
  bubbles,
);
check(
  'the reader’s own message is still there',
  bubbles.some((b) => b.includes('lighthouse')),
  bubbles.length,
);

// ── 2. Lucky roll: same abort, no fallback overwrite, no failure toast ────
await setValue('.seed-input', 'KEEP-ME');
await clickText('feeling lucky');
await sleep(200);
await ev(`location.hash = '#/library'; 'away2'`);
await sleep(1200);
await ev(`location.hash = '#/seed'; 'back2'`);
await waitFor(`!!document.querySelector('.seed-input')`, 10000, 'seed again, twice');
const seedNow = await ev(`document.querySelector('.seed-input')?.value`);
const toasts = await ev(`[...document.querySelectorAll('.toast')].map(t => t.textContent)`);
check('a cancelled roll did not overwrite the seed box', seedNow === 'KEEP-ME', seedNow);
check(
  'a cancelled roll toasted no failure',
  // The generation funnel's own "Generation cancelled." notice is the app's
  // long-standing behaviour for any abort; what must not happen is the
  // fallback blurb blaming the model for a roll nobody was waiting for.
  !toasts.some((t) => /could not roll/i.test(t ?? '')),
  toasts,
);

// ── Leave the mock endpoint saved for whatever runs next ──────────────────
await useEndpoint('http://127.0.0.1:1234', 'mock-storyteller-7b');

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${failures.length} check(s) failed`);
ws.close();
process.exit(failures.length === 0 ? 0 : 1);
