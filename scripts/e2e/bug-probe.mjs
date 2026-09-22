// Bug probe: drive the real built app over CDP to reproduce reported bugs.
//   node scripts/e2e/bug-probe.mjs  (mock LLM + chromium must be running)
const CDP_BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await fetch(`${CDP_BASE}/json`).then((r) => r.json());
const target = targets.find((t) => t.type === 'page');
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
    throw new Error(JSON.stringify(result.result.exceptionDetails));
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

const out = {};

// ---- A. Seed / brief flow ---------------------------------------------------
await waitFor("!!document.querySelector('.view-settings')", 10000, 'settings');
// configure endpoint quickly: use the LM Studio scan row
await evaluate(
  "[...document.querySelectorAll('.view-settings .btn-primary')].find(b => b.textContent.includes('Scan'))?.click(); 'scan'",
);
await waitFor(
  "[...document.querySelectorAll('.scan-row')].some(r => r.textContent.includes('reachable'))",
  40000,
  'reachable row',
);
await evaluate(
  "[...document.querySelectorAll('.scan-row')].find(r => r.textContent.includes('reachable')).querySelector('button').click(); 'use'",
);
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Test connection')).click(); 'test'",
);
await waitFor(
  "[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Connected'))",
  30000,
  'connected',
);

await evaluate(
  "[...document.querySelectorAll('.nav-link')].find(b => b.textContent.includes('New book')).click(); 'seed-view'",
);
await waitFor("!!document.querySelector('.seed-input')", 10000, 'seed view');

// Open the chat, send one message, wait for the partner reply.
await evaluate("document.querySelector('details.chat summary').click(); 'open-chat'");
await evaluate(`(() => {
  const input = document.querySelector('.chat-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'I want a quiet gothic mystery about a lighthouse keeper and a letter');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return 'sent';
})()`);
await waitFor(
  "document.querySelectorAll('.chat-bubble.chat-assistant .chat-text').length >= 1",
  30000,
  'chat reply',
);
out.chatReplies = await evaluate("document.querySelectorAll('.chat-bubble').length");

// Distill into a brief.
out.distillButton = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Distill into a brief'));
  if (!btn) return 'missing';
  return { disabled: btn.disabled, text: btn.textContent };
})()`);
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Distill into a brief'))?.click(); 'distill'",
);
await waitFor("!!document.querySelector('.brief-input')", 30000, 'brief textarea');
out.briefText = await evaluate("document.querySelector('.brief-input')?.value ?? null");
out.toastsAfterDistill = await evaluate(
  "[...document.querySelectorAll('.toast')].map(t => t.textContent)",
);
out.chatBubblesAfter = await evaluate("document.querySelectorAll('.chat-bubble').length");
out.seedValueAfterDistill = await evaluate("document.querySelector('.seed-input').value");

// Now click Begin WITHOUT typing a seed — the reported bug: it should proceed
// using the brief (before the fix it just toasts an error and stays).
await evaluate(
  "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Begin')).click(); 'begin'",
);
await waitFor(
  "window.__PAGE_TURN__.view() === 'titles'",
  10000,
  'navigate to titles from brief-only seed',
);
out.stillOnSeed = await evaluate("!!document.querySelector('.seed-input')");
out.viewAfterBegin = await evaluate('window.__PAGE_TURN__.view()');
out.titleCards = await waitFor(
  "document.querySelectorAll('.title-card').length >= 1",
  30000,
  'title cards from brief-only seed',
);

// ---- B. Font selection -------------------------------------------------------
await evaluate(
  "[...document.querySelectorAll('.nav-link')].find(b => b.textContent.includes('Settings')).click(); 'settings2'",
);
await waitFor("!!document.querySelector('.view-settings')", 10000, 'settings again');
await evaluate(`(() => {
  const selects = document.querySelectorAll('.view-settings select');
  const readingFont = [...selects].find(s => [...s.options].some(o => o.value === 'sans' && o.textContent.includes('Clean sans')));
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(readingFont, 'sans');
  readingFont.dispatchEvent(new Event('change', { bubbles: true }));
  return 'set-sans';
})()`);
// No Save pressed — the font must preview LIVE now.
await sleep(300);
out.dataFontAttrLive = await evaluate('document.documentElement.dataset.font');
out.brandFontFamily = await evaluate(
  "getComputedStyle(document.querySelector('.brand')).fontFamily",
);
out.headingFontFamily = await evaluate(
  "getComputedStyle(document.querySelector('.view-head h1')).fontFamily",
);

// Try the theme + font scale too
out.fontScaleProp = await evaluate(
  "document.documentElement.style.getPropertyValue('--font-scale')",
);

// ---- C. PDF font fit (pure — exercise via an injected page) ------------------
// Make a book with a long page, then check the exported PDF shrinks font.
// (Covered by unit tests; here just confirm the export path works.)
out.pdfExportButtonInMenu = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Export'));
  return btn ? btn.textContent : 'none';
})()`);

console.log(JSON.stringify(out, null, 2));
ws.close();
process.exit(0);
