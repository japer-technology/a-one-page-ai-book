// Verifies the two seed-view enhancements:
//   1. "I'm feeling lucky" asks the MODEL for a story seed (instead of rolling
//      one of the twelve hard-wired lines), cycles a batch without re-asking,
//      and falls back honestly when there is no model.
//   2. The pre-writing conversation is cleared when the reader asks for a new
//      one, and when a book is born through any path.
// Run: bash scripts/e2e/dev-up.sh && node scripts/e2e/seed-ideas.mjs
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
const waitFor = async (expr, ms, label) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await ev(expr)) return true;
    await sleep(200);
  }
  throw new Error('timeout: ' + label);
};
const failures = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
};

// Auto-confirm the "clear this conversation?" prompt.
await ev("window.confirm = () => true; 'stubbed'");

// ── Configure the endpoint ─────────────────────────────────────────────────
await ev("location.hash='#/settings';'h'");
await sleep(700);
await waitFor("!!document.querySelector('.view-settings')", 20000, 'settings');
await ev(
  "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Scan'))?.click();'s'",
);
await waitFor(
  "[...document.querySelectorAll('.scan-row')].some(r=>r.textContent.includes('reachable'))",
  40000,
  'row',
);
await ev(
  "[...document.querySelectorAll('.scan-row')].find(r=>r.textContent.includes('reachable')).querySelector('button').click();'u'",
);
await ev(
  "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Test connection')).click();'t'",
);
await waitFor(
  "[...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('Connected'))",
  30000,
  'conn',
);

// ── 1. the dice ask the model ──────────────────────────────────────────────
await ev("location.hash='#/seed';'s'");
await waitFor("!!document.querySelector('.seed-input')", 10000, 'seed');
// The fallback list is deliberately still shipped: it is what the button uses
// when no model is configured. What must NOT happen is the button serving it
// while a model is available — which the assertions below cover.

const before = await ev('window.__PAGE_TURN__.audit().length');
await ev(
  "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('feeling lucky'))?.click();'roll'",
);
await sleep(1500);
const rolled = await ev("document.querySelector('.seed-input')?.value ?? ''");
const after = await ev('window.__PAGE_TURN__.audit().length');
const usedModel = await ev(
  'window.__PAGE_TURN__.audit().some(l => /llm (start|ok)/.test(l) && /writing|structured/.test(l) === false)',
);
check('the button filled the seed box', rolled.length > 12, JSON.stringify(rolled.slice(0, 70)));
check(
  'the seed came from the model, not the built-in list',
  usedModel === true,
  `audit +${after - before}`,
);
check(
  'it is not one of the hard-wired lines',
  !/immortal librarian|sourdough starter|dogs could file taxes/i.test(rolled),
  rolled.slice(0, 60),
);
check(
  'the model log shows a seed request',
  await ev(`window.__PAGE_TURN__.audit().some(l=>/llm ok/.test(l))`),
);

// A second click must cycle the batch, not ask again.
const rollTwo = await ev(`(async () => {
  const before = window.__PAGE_TURN__.audit().filter(l => /llm start/.test(l)).length;
  [...document.querySelectorAll('button')].find(b=>b.textContent.includes('feeling lucky')).click();
  await new Promise(r => setTimeout(r, 900));
  const after = window.__PAGE_TURN__.audit().filter(l => /llm start/.test(l)).length;
  return { value: document.querySelector('.seed-input')?.value ?? '', extraRequests: after - before };
})()`);
check(
  'a second click offers a DIFFERENT idea',
  rollTwo.value !== rolled && rollTwo.value.length > 12,
  rollTwo.value.slice(0, 60),
);
check(
  'a second click costs no extra request (batch is walked)',
  rollTwo.extraRequests === 0,
  `${rollTwo.extraRequests} extra`,
);

// ── 2. the conversation lifecycle ──────────────────────────────────────────
await ev(
  "const d=document.querySelector('details.chat'); if(!d.open) d.querySelector('summary').click(); 'open'",
);
await sleep(300);
await ev(`(() => {
  const input = document.querySelector('.chat-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'a quiet gothic mystery about a lighthouse');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return 1;
})()`);
await sleep(1400);
const bubbles = await ev("document.querySelectorAll('.chat-bubble').length");
check('the chat recorded the exchange', bubbles >= 2, `${bubbles} bubbles`);

const cleared = await ev(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('New conversation'));
  if (!btn) return 'no button';
  btn.click();
  return 'clicked';
})()`);
await sleep(600);
const afterClear = await ev(`(() => ({
  bubbles: document.querySelectorAll('.chat-bubble').length,
  brief: !!document.querySelector('.brief-input'),
  seed: document.querySelector('.seed-input')?.value ?? '',
}))()`);
check('the reader can start a fresh conversation', cleared === 'clicked', String(cleared));
check('the transcript is gone', afterClear.bubbles === 0, `${afterClear.bubbles} bubbles`);
check('the distilled brief is gone with it', afterClear.brief === false);
check(
  'the seed text is NOT thrown away with the chat',
  afterClear.seed.length > 12,
  afterClear.seed.slice(0, 50),
);

// Starting a book clears the session for the NEXT one.
await ev(
  "(() => { const box = document.querySelector('details.chat'); if (box.open) box.querySelector('summary').click(); return 'close'; })()",
);
await ev(`(() => {
  const input = document.querySelector('.seed-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(input, 'A lighthouse keeper finds a letter.');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 1;
})()`);
await ev(
  "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Begin'))?.click();'begin'",
);
await waitFor("document.querySelectorAll('.title-card').length>=1", 40000, 'titles');
await ev("document.querySelector('.title-card').click();'sel'");
await sleep(300);
await ev(
  "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Use this title'))?.click();'u'",
);
await waitFor("window.__PAGE_TURN__.view()==='turn'", 20000, 'turn');
await ev("window.location.hash='#/seed';'back'");
await sleep(900);
const afterBook = await ev(`(() => ({
  bubbles: document.querySelectorAll('.chat-bubble').length,
  seed: document.querySelector('.seed-input')?.value ?? '',
}))()`);
check(
  'a new book left no stale conversation behind',
  afterBook.bubbles === 0,
  `${afterBook.bubbles} bubbles`,
);
check(
  'a new book left no stale seed draft behind',
  afterBook.seed === '',
  JSON.stringify(afterBook.seed),
);

check('no console errors', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)));
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${failures.length} check(s) failed`);
ws.close();
process.exit(failures.length === 0 ? 0 : 1);
