// Regression test for the "the browser already told us which network we are
// on" path — Firefox and Safari reveal a real local address, and so does a
// page served from a LAN machine. Two things used to go wrong there:
//
//   1. `rankSubnets` skipped the one subnet it knew and interrogated the other
//      seven, one address at a time. A connect attempt into a range this
//      machine is not on is dropped, not refused, so that is 28 dropped
//      sockets and ~20 s of waiting — to confirm an answer the address had
//      already given.
//   2. The detected subnet was recorded with no latency (`latencyMs: null`),
//      and the sweep gate in the settings view only accepted latency — so the
//      one-button scan refused to sweep the very network the page was on,
//      reporting "not swept — nothing was seen on <base>".
//
// Chromium normally mDNS-obfuscates host candidates, so this stubs
// RTCPeerConnection with what Firefox hands over and checks that (a) no probe
// is fired at any foreign range, (b) the revealed subnet is the one the scan
// sweeps.
//
// Run: bash scripts/e2e/dev-up.sh && node scripts/e2e/detect-subnet.mjs
const CDP_BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Private, and deliberately a range nothing answers in. */
const ADDRESS = '10.99.99.7';
const BASE = '10.99.99';

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
const failures = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
};

/** One host candidate, then the end-of-gathering marker. */
const STUB = `
(() => {
  const requests = [];
  const realFetch = window.fetch.bind(window);
  window.__requests = requests;
  window.fetch = (input, init) => {
    try { requests.push(String(input?.url ?? input)); } catch {}
    return realFetch(input, init);
  };
  class FakePeerConnection {
    constructor() { this.onicecandidate = null; }
    createDataChannel() { return {}; }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: '' }); }
    setLocalDescription() {
      setTimeout(() => {
        this.onicecandidate?.({
          candidate: {
            candidate: 'candidate:842163049 1 udp 1677729535 ${ADDRESS} 54321 typ host generation 0',
          },
        });
        this.onicecandidate?.({ candidate: null });
      }, 20);
      return Promise.resolve();
    }
    close() {}
  }
  Object.defineProperty(window, 'RTCPeerConnection', {
    configurable: true,
    writable: true,
    value: FakePeerConnection,
  });
})();
`;

await send('Page.enable');
// Remembered so it can be taken out again at the end: an injected document
// script applies to every LATER load in this browser too, and the whole suite
// shares one Chromium — the next script would believe it is on this fake
// network and skip the sweep it is there to check.
const injected = await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
const identifier = injected?.result?.identifier;

try {
  await send('Page.reload', { ignoreCache: true });
  await sleep(2500);
  await ev("location.hash = '#/settings'; 'ok'");
  const booted = await (async () => {
    for (let i = 0; i < 40; i++) {
      if (await ev(`!!document.querySelector('.view-settings')`)) return true;
      await sleep(250);
    }
    return false;
  })();
  if (!booted) throw new Error('settings view never rendered');

  // ── 1. detection settles at once, without interrogating anything ───────────
  const started = Date.now();
  let netLine = '';
  let named = false;
  for (let i = 0; i < 80; i++) {
    netLine = await ev(`document.querySelector('#net-line')?.textContent ?? ''`);
    if (netLine.includes(`${BASE}.0/24`)) {
      named = true;
      break;
    }
    await sleep(100);
  }
  const settledMs = Date.now() - started;
  // Anything that is not this machine's own mock server is a probe at a range
  // the app was not asked to sweep.
  const foreign = await ev(
    `(window.__requests ?? []).filter(u => !/^https?:\\/\\/(127\\.0\\.0\\.1|localhost)[:/]/.test(u))`,
  );
  check(
    'the network the browser revealed is named at once',
    named,
    `${settledMs} ms — ${netLine.slice(0, 140)}`,
  );
  check(
    'no probe is fired at any other range',
    Array.isArray(foreign) && foreign.length === 0,
    JSON.stringify(foreign),
  );

  // ── 2. the revealed subnet is the network the app names ───────────────────
  const subnetValue = await ev(`document.querySelector('.lan-subnet')?.value ?? ''`);
  check('the subnet box carries it too', subnetValue === BASE, subnetValue);
  check(
    'it says that network is being scanned, not that it went unanswered',
    /Scanning this machine and that network together/.test(netLine),
    netLine.slice(0, 160),
  );

  // ── 3. the one-button scan sweeps it ──────────────────────────────────────
  await ev("document.querySelectorAll('.toast').forEach(t => t.remove()); 'clear'");
  await ev("document.querySelector('#llm-setup .btn-primary')?.click(); 'start'");
  // Long enough to prove the sweep is running (progress names the range) and
  // short enough to stop it before a dead range piles up dropped sockets.
  await sleep(1500);
  const state = await ev(`(() => ({
    texts: [document.querySelector('#lan-progress'), document.querySelector('#net-line')]
      .map(n => n?.textContent ?? '')
      .filter(Boolean),
    cancel: [...document.querySelectorAll('#llm-setup button')].some(b => /Cancel scan/.test(b.textContent)),
    local: [...document.querySelectorAll('.llm-results .scan-row')].map(r => r.textContent),
  }))()`);
  const escaped = BASE.replace(/\./g, '\\.');
  check(
    'the scan sweeps the revealed network',
    state.texts.some(
      (t) => new RegExp(`${escaped}\\.1–254`).test(t) && /(\d+\/254 scanned|responder)/.test(t),
    ),
    JSON.stringify(state.texts.slice(0, 2)),
  );
  check(
    'it is not reported as an unanswered network instead',
    !state.texts.some((t) => /not swept/.test(t)),
  );
  check('the button offers to cancel', state.cancel === true);
  check(
    'the local half of the scan still ran',
    state.local.some((t) => /LM Studio/.test(t)),
    JSON.stringify(state.local.slice(0, 2)),
  );

  await ev("document.querySelector('#llm-setup .btn-danger')?.click(); 'cancel'");
  let verdict = '';
  for (let i = 0; i < 80; i++) {
    verdict = await ev(`document.querySelector('#lan-progress')?.textContent ?? ''`);
    if (new RegExp(`stopped[^]*${escaped}`).test(verdict)) break;
    await sleep(400);
  }
  check('the cancelled sweep says it stopped', /^stopped/.test(verdict), verdict);

  check('no console errors', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)));
} finally {
  // Take the stub out again even when a check threw, so the next probe
  // in this shared browser starts from the real network.
  if (identifier) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
}
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${failures.length} check(s) failed`);
ws.close();
process.exit(failures.length === 0 ? 0 : 1);
