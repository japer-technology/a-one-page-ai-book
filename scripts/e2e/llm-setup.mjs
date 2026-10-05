// Walk the new LLM setup flow in the real app and report what it does.
//   node scripts/e2e/setup-audit.mjs
const CDP_BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = await fetch(`${CDP_BASE}/json`).then((r) => r.json());
const target = targets.find((t) => t.type === 'page' && String(t.url).includes('page-turn.html'));
if (!target) {
  console.error(
    'No page-turn.html target on :9222 — start the app first (bash scripts/e2e/dev-up.sh, or point Chromium at dist/page-turn.html).',
  );
  process.exit(2);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown')
    errors.push(m.params.exceptionDetails?.exception?.description ?? 'exception');
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
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
    return `EXCEPTION ${JSON.stringify(r.result.exceptionDetails).slice(0, 300)}`;
  return r.result?.result?.value;
}
async function waitFor(expr, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ev(expr)) return true;
    await sleep(200);
  }
  console.log(`  !! timed out: ${label}`);
  return false;
}

await ev(`location.hash = '#/settings'; 'ok'`);
await waitFor(`!!document.querySelector('.view-settings')`, 8000, 'settings');

// Start from a genuinely empty install (snap chromium keeps its own /tmp, so
// wiping the profile directory from the shell does not clear the app's DB).
if (process.argv.includes('--fresh')) {
  await ev(`(async () => {
    localStorage.clear();
    for (const db of await indexedDB.databases()) if (db.name) indexedDB.deleteDatabase(db.name);
    return 'cleared';
  })()`);
  await sleep(1500);
  await send('Page.enable');
  await send('Page.reload');
  await sleep(2500);
  await waitFor(`!!document.querySelector('.view-settings')`, 8000, 'settings after reset');
  console.log('(storage cleared — fresh install)');
}
// Give detection a moment to settle.
await sleep(3000);

console.log('=== Step 0: detection ===');
const netLine = await ev(`document.querySelector('#net-line')?.textContent ?? ''`);
console.log('net line :', netLine);
console.log('subnet   :', await ev(`document.querySelector('#lan-subnet')?.value`));
console.log(
  'chips    :',
  await ev(
    `[...document.querySelectorAll('.subnet-chips .btn-chip')].map(c => c.textContent).join(', ')`,
  ),
);
console.log('status   :', await ev(`document.querySelector('#endpoint-state')?.textContent`));
console.log(
  'model ui :',
  await ev(`document.querySelector('.model-picker')?.innerText?.slice(0,200)`),
);

console.log('\n=== Step 1: one-button scan ===');
const t0 = Date.now();
await ev(`document.querySelector('.view-settings .btn-primary')?.click(); 'clicked'`);
await waitFor(`document.querySelector('.llm-results .scan-row') !== null`, 5000, 'first row');
console.log(
  'button while running:',
  await ev(
    `document.querySelector('#llm-setup .btn-primary, #llm-setup .btn-danger')?.textContent`,
  ),
);
await waitFor(
  `[...document.querySelectorAll('.llm-results .scan-row, .llm-absent .scan-row')].length >= 11`,
  60000,
  '11 catalog rows',
);
console.log(
  `catalog rows after ${Math.round((Date.now() - t0) / 100) / 10}s:`,
  await ev(`
  [...document.querySelectorAll('.llm-results .scan-row')]
    .map(r => '  ' + [...r.children].map(c => c.tagName === 'BUTTON' ? '['+c.textContent+']' : c.textContent).join(' | '))
    .join('\\n')
`),
);
const lanDone = await waitFor(
  `/server\\(s\\) on|nothing answered|stopped/.test(document.querySelector('#lan-progress')?.textContent ?? '')`,
  120000,
  'lan sweep done',
);
console.log('lan progress:', await ev(`document.querySelector('#lan-progress')?.textContent`));
console.log(
  'lan rows:',
  await ev(`
  [...document.querySelectorAll('.lan-results .scan-row')].map(r => '  ' + r.textContent).join('\\n') || '  (none)'
`),
);
console.log(`lan sweep settled after ${Math.round((Date.now() - t0) / 100) / 10}s:`, lanDone);

console.log('\n=== Step 2: adopt + model picker ===');
await ev(`
  [...document.querySelectorAll('.llm-results .scan-row')]
    .find(r => r.textContent.includes('LM Studio'))?.querySelector('button')?.click(); 'used'
`);
await sleep(600);
const bestModel = await ev(`document.querySelector('#endpoint-model')?.value ?? ''`);
console.log(
  'model select:',
  await ev(`
  (() => {
    const s = document.querySelector('#endpoint-model');
    if (!s) return 'NO SELECT: ' + document.querySelector('.model-picker')?.innerText?.slice(0,200);
    return 'value=' + s.value + ' options=[' + [...s.options].map(o => o.textContent).join(' | ') + ']';
  })()
`),
);
console.log(
  'picker hint:',
  await ev(`document.querySelector('.model-picker .field-hint')?.textContent`),
);
console.log(
  'selected row highlighted:',
  await ev(`document.querySelectorAll('.scan-row-selected').length`),
);
console.log('status strip:', await ev(`document.querySelector('#endpoint-state')?.textContent`));

console.log('\n=== Step 3: save & test ===');
const t1 = Date.now();
await ev(`document.querySelector('#endpoint-save-test').click(); 'clicked'`);
await waitFor(
  `/Connected|failed/.test(document.querySelector('#endpoint-status')?.textContent ?? '')`,
  30000,
  'test result',
);
const inlineStatus = await ev(`document.querySelector('#endpoint-status')?.textContent ?? ''`);
console.log(`in ${Math.round(Date.now() - t1)} ms:`, inlineStatus);
console.log('status strip:', await ev(`document.querySelector('#endpoint-state')?.textContent`));
console.log(
  'saved endpoint:',
  await ev(`JSON.stringify(window.__PAGE_TURN__.model?.() ?? 'no handle')`),
);

console.log('\n=== console errors ===');
console.log(errors.length ? errors.slice(0, 10).join('\n') : '(none)');

// ---- the properties this flow exists to guarantee --------------------------
const failures = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
};
const finalModel = await ev(`JSON.stringify(window.__PAGE_TURN__.model())`);
const saved = JSON.parse(finalModel);
check('detection named the local network', /network \d+\.\d+\.\d+\.0\/24/.test(netLine));
check(
  'the picker preselects the best writer, not the first alphabetically',
  bestModel === 'mock-storyteller-7b',
  bestModel,
);
check(
  'the endpoint was saved with the tested model',
  saved.model === 'mock-storyteller-7b',
  saved.model,
);
check(
  'the connection test reported success inline',
  /^Connected/.test(inlineStatus ?? ''),
  inlineStatus,
);
check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${failures.length} check(s) failed`);
process.exit(failures.length === 0 ? 0 : 1);
