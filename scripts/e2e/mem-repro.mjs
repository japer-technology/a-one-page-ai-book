// Memory repro harness: drive the REAL built app in headless Chromium and
// sample the JS heap (after forced GC) through the flows that reportedly
// ballooned memory: page generation loop, story-map replay, reader flipping,
// ambience toggle. Run via scripts/e2e/mem-repro.sh
const CDP_BASE = 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await fetch(`${CDP_BASE}/json`).then((r) => r.json());
const target = targets.find((t) => t.type === 'page');
if (!target)
  throw new Error('no page target — is Chromium running with --remote-debugging-port=9223?');
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
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
async function heap(label) {
  await send('HeapProfiler.collectGarbage', {});
  await sleep(150);
  const usage = await send('Runtime.getHeapUsage', {});
  const used = usage.result?.usedSize ?? 0;
  const total = usage.result?.totalSize ?? 0;
  console.log(`HEAP ${label}: used=${mb(used)} total=${mb(total)}`);
  return used;
}
const clickButton = (label) =>
  evaluate(
    `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`,
  );

await heap('boot');

// ---- 1. Settings: scan, use, save ------------------------------------------
await waitFor("!!document.querySelector('.view-settings')", 10000, 'settings render');
await evaluate("document.querySelector('.view-settings .btn-primary').click(); 'scan'");
await waitFor(
  "[...document.querySelectorAll('.scan-row')].some(r => r.textContent.includes('reachable') && r.textContent.includes('LM Studio'))",
  40000,
  'LM Studio reachable',
);
await evaluate(
  "[...document.querySelectorAll('.scan-row')].find(r => r.textContent.includes('LM Studio')).querySelector('button').click(); 'used'",
);
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('💾 Save')).click(); 'saved'",
);
await sleep(300);

// ---- 2. New book: seed → titles → page 1 ------------------------------------
await evaluate(
  "[...document.querySelectorAll('.nav-link')].find(b => b.textContent.includes('New book')).click(); 'seed'",
);
await waitFor("!!document.querySelector('.seed-input')", 10000, 'seed view');
await evaluate(
  "document.querySelector('.seed-input').value = 'A lighthouse keeper finds a letter.'; 'typed'",
);
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Begin')).click(); 'begun'",
);
await waitFor("document.querySelectorAll('.title-card').length >= 5", 30000, 'titles');
await evaluate("document.querySelector('.title-card').click(); 'picked'");
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Use this title')).click(); 'used-title'",
);
await waitFor(
  "[...document.querySelectorAll('.view-page .page-num')].some(n => n.textContent.includes('Page 1')) && !!document.querySelector('.view-page .page-text')",
  30000,
  'page 1',
);
await heap('page-1-generated');
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Keep this page')).click(); 'kept'",
);
await waitFor("!!document.querySelector('.turn-panel')", 10000, 'turn');

// ---- 3. Generate pages 2..12, sampling as we go ------------------------------
for (let i = 2; i <= 12; i++) {
  await clickButton('Continue naturally');
  await waitFor(
    `[...document.querySelectorAll('.view-page .page-num')].some(n => n.textContent.includes('Page ${i}')) && !!document.querySelector('.view-page .page-text')`,
    30000,
    `page ${i}`,
  );
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Keep this page')).click(); 'kept'",
  );
  await waitFor("!!document.querySelector('.turn-panel')", 10000, `turn ${i}`);
  if (i % 3 === 0) await heap(`after-page-${i}`);
}

// ---- 4. Regenerate loop on the last page (generation ritual churn) ----------
await evaluate(
  "[...document.querySelectorAll('.nav-link')].find(b => b.textContent.includes('Story map')).click(); 'archive'",
);
await waitFor("!!document.querySelector('.archive-timeline')", 10000, 'archive');
await heap('archive-rendered');

// ---- 5. Replay the journey ---------------------------------------------------
await clickButton('▶ Replay the journey');
for (let i = 1; i <= 10; i++) {
  await sleep(2200);
  await heap(`replay-tick-${i}`);
}
await clickButton('⏹ Stop replay');
await sleep(1000);
await heap('replay-stopped');

// ---- 6. Reader: flip pages rapidly (with speech synthesis present, like every
// real desktop browser — the reader must NOT re-render in a loop) --------------
await evaluate(
  "Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { getVoices: () => [{ name: 'Mock Voice' }], speak: () => {}, cancel: () => {} } }); 'mocked'",
);
const rendersBefore = await evaluate('window.__PAGE_TURN__.renders()');
await evaluate(
  "[...document.querySelectorAll('.nav-link')].find(b => b.textContent.includes('Library')).click(); 'library'",
);
await waitFor("!!document.querySelector('.book-card')", 10000, 'book card');
await evaluate(
  "[...document.querySelectorAll('.book-card button')].find(b => b.textContent.includes('Read')).click(); 'read'",
);
await waitFor("!!document.querySelector('.view-reader')", 10000, 'reader');
console.log(
  `READER-RENDER-DELTA=${(await evaluate('window.__PAGE_TURN__.renders()')) - rendersBefore}`,
);
await heap('reader-opened-with-speech');
for (let round = 1; round <= 4; round++) {
  for (let i = 0; i < 13; i++) {
    await evaluate(
      "[...document.querySelectorAll('button')].find(b => b.title === 'Next page')?.click(); 'next'",
    );
    await sleep(60);
  }
  await heap(`reader-flip-round-${round}`);
}

// ---- 7. Ambience on/off churn -------------------------------------------------
for (let i = 0; i < 4; i++) {
  await clickButton('🔊 ambience: on');
  await sleep(300);
  await clickButton('🔊 ambience: off');
  await sleep(300);
}
await heap('ambience-churn-done');

console.log('MEM-REPRO-DONE');
ws.close();
process.exit(0);
