// Regression test for two pieces of per-view state that the shell throws away
// on every render:
//
//   1. The floating span toolbar keyed its inline-edit draft to the PARAGRAPH,
//      so a draft the reader walked away from came back pre-filled on their
//      next drag in that paragraph, and "Replace" spliced it into a selection
//      it was never written for — overwriting the phrase they had just picked.
//      A draft belongs to the exact range it was typed for.
//   2. The Story-memory panel stored nothing, so expanding it and then having
//      anything re-render (its own "↻ Update" included) collapsed it again —
//      the reader could never watch a memory arrive.
//
// Run: bash scripts/e2e/dev-up.sh && node scripts/e2e/panel-state.mjs
const CDP_BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await fetch(`${CDP_BASE}/json`).then((r) => r.json());
const target =
  targets.find((t) => t.type === 'page' && String(t.url).includes('page-turn.html')) ??
  targets.find((t) => t.type === 'page' && !String(t.url).startsWith('chrome-extension'));
if (!target)
  throw new Error('no page target — is Chromium running with --remote-debugging-port=9222?');
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
async function waitFor(expr, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await ev(expr)) return true;
    await sleep(150);
  }
  console.log(`  !! timed out waiting for ${label}`);
  return false;
}
const failures = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
};

/** Type into an input the way a reader does (setter + event). */
const type = (selector, value, proto = 'HTMLInputElement', eventName = 'input') =>
  ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'no field';
    const setter = Object.getOwnPropertyDescriptor(window.${proto}.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(${JSON.stringify(eventName)}, { bubbles: true }));
    return el.value;
  })()`);
const clickText = (selector, text) =>
  ev(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) =>
      b.textContent.includes(${JSON.stringify(text)}));
    if (!el) return 'not found';
    el.click();
    return 'clicked';
  })()`);

/** Select a range inside the first paragraph and raise it through the UI. */
const selectInParagraph = (from, to) =>
  ev(`(() => {
    const para = document.querySelector('.view-page .page-text p');
    if (!para) return 'no paragraph';
    const node = [...para.childNodes].find((n) => n.nodeType === 3 && n.textContent.length > ${to});
    if (!node) return 'no text node';
    const range = document.createRange();
    range.setStart(node, ${from});
    range.setEnd(node, ${to});
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    para.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return sel.toString();
  })()`);

// ── a page to work on ─────────────────────────────────────────────────────
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(2500);
await waitFor(`!!document.querySelector('.view')`, 8000, 'boot');

// Point the draft endpoint at the mock server (the settings draft is what
// titles and pages are generated with — no Save needed).
await ev("location.hash = '#/settings'; 'ok'");
await waitFor(`!!document.querySelector('.view-settings')`, 8000, 'settings');
const urlTyped = await type('.card-llm input[list="endpoint-presets"]', 'http://127.0.0.1:1234');
check('the mock server can be typed in', urlTyped === 'http://127.0.0.1:1234', String(urlTyped));
// Leave and come back so the picker re-renders now that a server is typed.
await ev("location.hash = '#/library'; 'ok'");
await sleep(300);
await ev("location.hash = '#/settings'; 'ok'");
await sleep(500);
const modelTyped = (await waitFor(
  `!!document.querySelector('#endpoint-model-custom')`,
  4000,
  'model box',
))
  ? await type('#endpoint-model-custom', 'mock-storyteller-7b')
  : 'no box';
check('the model can be typed in', modelTyped === 'mock-storyteller-7b', String(modelTyped));
// SAVE it: titles and pages are generated with the endpoint in SETTINGS, not
// with the settings form's draft.
await ev("document.querySelector('#endpoint-save')?.click(); 'saved'");
const ready = await waitFor(
  `/Ready:/.test(document.querySelector('#endpoint-state')?.textContent ?? '')`,
  5000,
  'saved endpoint',
);
check('the endpoint is saved', ready);
await clickText('.nav-link', 'New book');
await waitFor(`!!document.querySelector('.seed-input')`, 8000, 'seed view');
await type('.seed-input', 'A lighthouse keeper finds a letter.', 'HTMLTextAreaElement');
await clickText('button', 'Begin');
await waitFor(`document.querySelectorAll('.title-card').length >= 5`, 30000, 'title cards');
await ev("document.querySelector('.title-card')?.click(); 'picked'");
await clickText('button', 'Use this title');
await waitFor(`!!document.querySelector('.turn-panel')`, 10000, 'turn console');
await clickText('button', 'Generate next page');
await waitFor(`!!document.querySelector('.view-page .page-text p')`, 30000, 'page 1');
const paragraphs = await ev(`document.querySelectorAll('.view-page .page-text p').length`);
check('a page to work on', paragraphs >= 1, `${paragraphs} paragraph(s)`);

// ── 1. an abandoned inline draft must not come back on a new selection ────
const firstSelection = await selectInParagraph(0, 8);
check(
  'a phrase can be selected',
  typeof firstSelection === 'string' && firstSelection.length > 0,
  firstSelection,
);
await waitFor(`!!document.querySelector('.span-toolbar')`, 4000, 'span toolbar');
await clickText('.span-toolbar button', 'Edit');
const editOpened = await waitFor(
  `!!document.querySelector('.span-toolbar textarea.para-edit')`,
  4000,
  'edit box',
);
check('the inline edit box opens', editOpened);
await type('.span-toolbar textarea.para-edit', 'ABANDONED DRAFT', 'HTMLTextAreaElement');
// Walk away WITHOUT cancelling: a re-render removes the toolbar but used to
// keep the draft (that is what `renderPage` does on every render).
await ev(`(() => {
  const edit = [...document.querySelectorAll('.view-page .page-text p')];
  const target = edit[edit.length - 1];
  const btn = [...target.querySelectorAll('button')].find((b) => b.textContent === '✎');
  if (!btn) return 'no edit button';
  btn.click();
  return 're-rendered';
})()`);
await sleep(400);
// A re-render may legitimately bring the toolbar back for the SAME selection —
// that is the reader's own draft, and it must not be lost mid-edit. What it
// must never do is carry the draft over to another selection (below).
const afterReRender = await ev(`(() => {
  const area = document.querySelector('.span-toolbar textarea.para-edit');
  return {
    present: area !== null,
    draft: area ? area.value : null,
    selection: window.getSelection().toString(),
  };
})()`);
check(
  'a re-render drops the toolbar, or keeps it with its OWN selection',
  afterReRender.present === false ||
    (afterReRender.draft === 'ABANDONED DRAFT' && afterReRender.selection === firstSelection),
  JSON.stringify(afterReRender),
);

// A DIFFERENT phrase in the same paragraph.
const secondSelection = await selectInParagraph(12, 20);
check(
  'another phrase can be selected',
  typeof secondSelection === 'string' && secondSelection.length > 0,
  secondSelection,
);
await waitFor(`!!document.querySelector('.span-toolbar')`, 4000, 'span toolbar again');
const fresh = await ev(`(() => {
  const bar = document.querySelector('.span-toolbar');
  if (!bar) return { missing: true };
  const area = bar.querySelector('textarea.para-edit');
  return {
    editing: area !== null,
    draft: area ? area.value : null,
    actions: [...bar.querySelectorAll('button')].map((b) => b.textContent),
  };
})()`);
check(
  'a new selection does NOT reopen the abandoned draft',
  fresh.editing === false,
  JSON.stringify(fresh),
);
check(
  'the abandoned draft is nowhere in the toolbar',
  !JSON.stringify(fresh).includes('ABANDONED DRAFT'),
  JSON.stringify(fresh.draft),
);
check(
  'the action row is offered instead',
  Array.isArray(fresh.actions) && fresh.actions.some((a) => a.includes('Rewrite')),
  JSON.stringify(fresh.actions),
);
await ev("document.querySelector('.span-toolbar button')?.click(); 'dismissed'");

// ── 2. the story-memory panel keeps the reader's expand ───────────────────
const memoryOpen = async () => ev(`document.querySelector('.view-page details.memory')?.open`);
await ev(`(() => {
  document.querySelector('.view-page details.memory .memory-summary').click();
  return 'toggled';
})()`);
await sleep(300);
check('the memory panel can be expanded', (await memoryOpen()) === true);

// Any re-render must not collapse it — a paragraph edit panel does exactly one.
const reRender = async () => {
  await ev(`(() => {
    const paras = [...document.querySelectorAll('.view-page .page-text p')];
    const target = paras[paras.length - 1];
    const btn = [...target.querySelectorAll('button')].find((b) => b.textContent === '✎');
    if (!btn) return 'no edit button';
    btn.click();
    return 're-rendered';
  })()`);
  await sleep(400);
};
await reRender();
check('a re-render keeps it expanded', (await memoryOpen()) === true);

// ...and the reader's collapse is remembered too, so it does not spring back.
await ev(`(() => {
  document.querySelector('.view-page details.memory .memory-summary').click();
  return 'toggled';
})()`);
await sleep(300);
check('the memory panel can be collapsed again', (await memoryOpen()) === false);
await reRender();
check('a re-render keeps it collapsed', (await memoryOpen()) === false);

check('no console errors', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)));
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${failures.length} check(s) failed`);
ws.close();
process.exit(failures.length === 0 ? 0 : 1);
