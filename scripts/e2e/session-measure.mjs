// Measures what the app actually sends over a long session: total requests,
// the size of each prompt CHAIN, and whether any state grows without bound.
// Run with the mock logging enabled:
//   PT_MOCK_LOG=/tmp/pt-requests.jsonl bash scripts/e2e/dev-up.sh
//   node scripts/e2e/session-measure.mjs
const CDP_BASE = 'http://127.0.0.1:9222';
const LOG = process.env.PT_MOCK_LOG ?? '/tmp/pt-requests.jsonl';
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
const click = (js) => ev(`(() => { ${js} })()`);

await ev("location.hash='#/settings';'h'");
await sleep(700);
await waitFor("!!document.querySelector('.view-settings')", 20000, 'settings');
await click(
  "const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Scan')); b?.click(); return 1;",
);
await waitFor(
  "[...document.querySelectorAll('.scan-row')].some(r=>r.textContent.includes('reachable'))",
  40000,
  'row',
);
await click(
  "const r=[...document.querySelectorAll('.scan-row')].find(x=>x.textContent.includes('reachable')); r.querySelector('button').click(); return 1;",
);
await click(
  "const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Test connection')); b.click(); return 1;",
);
await waitFor(
  "[...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('Connected'))",
  30000,
  'conn',
);

// ── The pre-writing chat: how does the chain grow? ──────────────────────────
const chain = [];
await ev("location.hash='#/seed';'s'");
await waitFor("!!document.querySelector('.seed-input')", 10000, 'seed');
await click(
  "const d=document.querySelector('details.chat'); if(!d.open) d.querySelector('summary').click(); return 1;",
);
await sleep(300);
for (let i = 1; i <= 12; i++) {
  const before = await ev('window.__PAGE_TURN__.audit().length');
  await click(`(() => {
    const input = document.querySelector('.chat-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'idea number ${i} about a lighthouse and a letter');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 1;
  })()`);
  await sleep(1200);
  chain.push({
    turn: i,
    bubbles: await ev("document.querySelectorAll('.chat-bubble').length"),
    auditLines: (await ev('window.__PAGE_TURN__.audit().length')) - before,
  });
}

// ── Write a book, keep pages, iterate ──────────────────────────────────────
await click(
  "const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Distill into a brief')); b?.click(); return 1;",
);
await sleep(1500);
await click(
  "const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Begin')); b?.click(); return 1;",
);
await waitFor("document.querySelectorAll('.title-card').length>=1", 40000, 'titles');
await ev("document.querySelector('.title-card').click();'sel'");
await sleep(300);
await click(
  "const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Use this title')); b?.click(); return 1;",
);
await waitFor("window.__PAGE_TURN__.view()==='turn'", 20000, 'turn');
await click(
  "const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Generate next page')); b?.click(); return 1;",
);
await waitFor("!!document.querySelector('.page-text')", 60000, 'page1');
await sleep(2500);
for (let i = 0; i < 4; i++) {
  await click(
    "const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Regenerate')); b?.click(); return 1;",
  );
  await sleep(1200);
}
await click(
  "const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Generate 2 more versions')); b?.click(); return 1;",
);
await sleep(2500);
await click(
  "const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Keep this page')); b?.click(); return 1;",
);
await waitFor("window.__PAGE_TURN__.view()==='turn'", 20000, 'turn2');
await click(
  "const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Continue naturally')); b?.click(); return 1;",
);
await sleep(3000);

// ── Leave the seed view and come back: is the conversation still there? ────
await ev("location.hash='#/library';'l'");
await sleep(800);
await ev("location.hash='#/seed';'s'");
await sleep(800);
const state = await ev(`(() => ({
  view: window.__PAGE_TURN__.view(),
  chatBubblesAfterReturn: document.querySelectorAll('.chat-bubble').length,
  genStateKeys: window.__PAGE_TURN__.genStateKeys().length,
  audit: window.__PAGE_TURN__.audit().length,
  seedDraft: document.querySelector('.seed-input')?.value.slice(0, 40) ?? '',
}))()`);

const failures = [];
const check = (label, ok, detail) => {
  console.log(
    `${ok ? '\u2713' : '\u2717'} ${label}${detail === undefined ? '' : ` \u2014 ${detail}`}`,
  );
  if (!ok) failures.push(label);
};

console.log('\n=== the pre-writing chat chain ===');
for (const turn of chain) console.log(`  turn ${turn.turn}: ${turn.bubbles} bubbles`);

// The chain the MODEL sees must stop growing. Read it from the mock's log.
let sent = [];
try {
  const log = await import('node:fs').then((fs) => fs.readFileSync(LOG, 'utf8'));
  sent = log
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((l) => /writing-partner/.test(l.system))
    .map((l) => l.messages);
} catch {
  // No log: skip the chain assertion rather than fail on the harness.
}
if (sent.length > 0) {
  console.log(`  messages sent per chat turn: ${sent.join(', ')}`);
  // 1 system message + the windowed history (opening exchange + the last 8,
  // i.e. 16 history messages) = 17 in total, however long the chat runs.
  check(
    'the chat chain stops growing',
    Math.max(...sent) <= 17,
    `max ${Math.max(...sent)} messages`,
  );
  check(
    'the chat chain does grow to start with',
    sent[0] === 2 && sent[1] === 4,
    sent.slice(0, 2).join('/'),
  );
  check(
    'the last turns all carry the same windowed size',
    sent.length >= 4 && new Set(sent.slice(-3)).size === 1 && sent.at(-1) === 17,
    sent.slice(-4).join(', '),
  );
}

console.log('\n=== state after leaving and returning to the seed view ===');
check(
  'a new book cleared the conversation',
  state.chatBubblesAfterReturn === 0,
  `${state.chatBubblesAfterReturn} bubbles`,
);
check(
  'no generation panel was left behind',
  state.genStateKeys === 0,
  `${state.genStateKeys} keys`,
);

console.log(JSON.stringify({ state }, null, 2));
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${failures.length} check(s) failed`);
ws.close();
process.exit(failures.length === 0 ? 0 : 1);
