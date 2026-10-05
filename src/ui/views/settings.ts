/**
 * ui/views/settings.ts — find your local LLM, tune it, and manage local files.
 *
 * The LLM setup is a three-step flow, because that is the actual shape of the
 * job: FIND a server, CHOOSE one of its models, SAVE. It used to be a flat wall
 * of fields where discovery and configuration were separate, where the model
 * was a free-text box whose suggestions came from a browser datalist, and where
 * adopting a server then required a second trip to a Save button at the bottom.
 *
 * Discovery is two sweeps in one click: the well-known local inference ports on
 * this machine (LM Studio, Ollama, llama.cpp, …) and, when the app knows which
 * subnet it is on, every address on that subnet. Reachable = we can list its
 * models. CORS-blocked = a server answered but refused this page's origin.
 *
 * Manual entry stays first-class: any base URL (host + port + optional path),
 * either protocol, any model name, and an optional API key sent as a bearer
 * token only to this endpoint.
 */
import type { AppApi } from '../ctx';
import { button, field, h, spinner } from '../dom';
import { audit } from '../audit';
import {
  baseUrlProblem,
  CANDIDATES,
  commonLlmPorts,
  llmPorts,
  modelTraits,
  normalizeBaseUrl,
  pickBestModel,
  presetBaseUrls,
  rankModels,
  vendorName,
} from '../../llm/endpoints';
import type { EndpointCandidate } from '../../llm/endpoints';
import { bestReachable, discover, probeCandidate } from '../../llm/probe';
import type { ProbeResult } from '../../llm/probe';
import {
  detectLocalIps,
  identifyLanServer,
  normalizeSubnetBase,
  rankSubnets,
  scanLan,
  subnetBaseOf,
  subnetCandidates,
} from '../../llm/lan';
import type { LanServer, SubnetGuess } from '../../llm/lan';
import { clearLibrary, estimateStorage, requestPersistence } from '../../store/db';
import {
  clearOpfsLibrary,
  exportLibraryFile,
  hasFilePicker,
  hasOpfs,
  opfsAvailable,
  readImportFile,
} from '../../store/files';
import { defaultLibrary } from '../../core/schema';
import type { EndpointSettings, EndpointVendor, ReadingFont, Settings } from '../../core/types';

/** Sentinel option value for "the list is wrong, let me type it". */
const CUSTOM_MODEL = '\u0000custom';

// Session view state.
const scan = { running: false, results: [] as ProbeResult[] };
const discoveredModels: string[] = [];
const lan = {
  running: false,
  results: [] as LanServer[],
  base: '',
  abort: null as AbortController | null,
  /** Last completed scan summary, rendered when the scan is idle. */
  summary: '',
  /** Live scan progress, so a mid-scan re-render shows it too. */
  progressText: '',
};
/**
 * What the app knows about the LAN it is plugged into. Chrome obfuscates WebRTC
 * host candidates with mDNS, so `addresses` is usually empty and the subnet is
 * found by asking the network which gateway answers (see `rankSubnets`).
 */
const net = {
  /** Local addresses this page could learn (WebRTC candidates, page origin). */
  addresses: [] as string[],
  guesses: [] as SubnetGuess[],
  detecting: false,
  detected: false,
};
/** Sweep every known LLM port, not just the common ones (more thorough, heavier). */
let thoroughSweep = false;
/**
 * The reader explicitly asked for a sweep of the subnet they typed, even
 * though nothing was seen answering on it. Cleared whenever the subnet box
 * changes, because the confirmation belongs to ONE address.
 */
let subnetConfirmed = false;
/** The subnet the confirmation was given for. */
let confirmedBase = '';
/** The models of the currently selected server, best writer first. */
const picker = {
  models: [] as string[],
  /** Which server they came from, so a stale list is never shown as current. */
  forUrl: '',
  loading: false,
  error: '',
  /** The reader chose "type a name" over the list. */
  custom: false,
};

/** True while a connection test is in flight (prevents double-firing a model call). */
let testing = false;
/** True while a "Save & test" is in flight, so both buttons latch. */
let saving = false;
/**
 * The live appearance controls of the current render. Saving an endpoint
 * re-reads them so a save can never store a stale theme or font next to a
 * fresh endpoint.
 */
let appearanceSnapshot: () => Partial<Settings> = () => ({});
/** The subnet from the last saved settings, used before detection finishes. */
let seededEndpointNet = '';
/** The single in-flight (or finished) network detection, so a scan can await it. */
let netRun: Promise<void> | null = null;

/**
 * Session draft for the form. The settings view re-renders whenever an
 * appearance preview is applied (theme, font, wardrobe, text size) — without
 * a draft, every preview would wipe the endpoint fields the reader was
 * typing. The draft is the source of truth; the inputs mirror it.
 */
const form = {
  name: '',
  url: '',
  vendor: 'openai-compat' as EndpointVendor,
  model: '',
  apiKey: '',
  /**
   * The origin the API key was entered FOR. A key is a secret scoped to one
   * host; the field's own help text promises it is sent "only to this
   * endpoint", so retyping the URL must not silently carry the key along.
   */
  keyOrigin: '',
  temperature: 0.9,
  defaultLength: 'standard' as 'shorter' | 'standard' | 'longer',
  autoBible: true,
  autoSummary: true,
  autoSuggest: false,
  fastModel: '',
};
let formReady = false;
/** The saved endpoint object the draft was seeded from (import/wipe re-seed). */
let seededEndpoint: EndpointSettings | null = null;

interface Controls {
  nameInput: HTMLInputElement;
  urlInput: HTMLInputElement;
  vendorInput: HTMLSelectElement;
  keyInput: HTMLInputElement;
  tempInput: HTMLInputElement;
  resultsBox: HTMLElement;
  scanButton: HTMLButtonElement;
}

/**
 * Live lookup by id. Every node in this view is rebuilt on each render (an
 * appearance preview re-renders the whole settings page), so anything that
 * needs to react to a change AFTER an await must find the node that is on
 * screen now rather than write to the one it captured at click time.
 */
function live(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function renderSettings(api: AppApi): HTMLElement {
  const endpoint = api.lib.settings.endpoint;
  // Seed the draft from saved settings once per session — NOT on every
  // render, or preview re-renders would wipe unsaved edits. A wholesale
  // settings replacement (library import, wipe) re-seeds as well.
  if (!formReady || seededEndpoint !== endpoint) {
    formReady = true;
    seededEndpoint = endpoint;
    form.name = endpoint.name;
    form.url = endpoint.baseUrl;
    form.vendor = endpoint.vendor;
    form.model = endpoint.model;
    form.apiKey = endpoint.apiKey;
    form.keyOrigin = endpoint.apiKey ? originOf(endpoint.baseUrl) : '';
    form.temperature = endpoint.temperature;
    form.defaultLength = api.lib.settings.defaultLength;
    form.autoBible = api.lib.settings.autoBible;
    form.autoSummary = api.lib.settings.autoSummary;
    form.autoSuggest = api.lib.settings.autoSuggest;
    form.fastModel = api.lib.settings.fastModel;
    seededEndpointNet = api.lib.settings.lanSubnet;
    // A remembered subnet is the reader's own answer from last time: trust it
    // over anything we detect now.
    if (seededEndpointNet && !lan.base) lan.base = seededEndpointNet;
  }

  const nameInput = h('input', {
    id: 'endpoint-name',
    class: 'input',
    type: 'text',
    value: form.name,
    oninput: (event: Event) => {
      form.name = (event.target as HTMLInputElement).value;
    },
  });
  const urlInput = h('input', {
    id: 'endpoint-url',
    class: 'input',
    type: 'text',
    list: 'endpoint-presets',
    value: form.url,
    placeholder: 'http://127.0.0.1:1234',
    spellcheck: false,
    oninput: (event: Event) => {
      form.url = (event.target as HTMLInputElement).value;
    },
    onchange: () => {
      // Retyping the URL used to keep the old key, so Save/Test would send
      // `Authorization: Bearer <secret>` to a machine it was never entered
      // for — breaking the field's "only to this endpoint" promise. Drop the
      // key as soon as the reader commits a different origin.
      const committed = originOf(form.url);
      if (
        form.apiKey.trim().length > 0 &&
        // An empty box is not an origin change — the reader may be mid-retype.
        committed !== '' &&
        (form.keyOrigin === '' || committed !== form.keyOrigin)
      ) {
        form.apiKey = '';
        // Write the LIVE field, not the node captured at render time: if the
        // view re-rendered between the edit and this commit (the detection
        // refresh, a scan, an appearance preview) the captured input is
        // detached — and the toast said "cleared" while the key stayed on
        // screen.
        const keyField = live('endpoint-key');
        if (keyField instanceof HTMLInputElement) keyField.value = '';
        form.keyOrigin = '';
        api.toast('API key cleared — it belonged to the previous endpoint.', 'info');
      }
      // The model list and the chosen model belong to the server they came
      // from — exactly like the key: committing a different address must not
      // keep them presented as this one's (`picker.forUrl` exists for exactly
      // that), and leaving the old model in place let plain Save store a
      // (url, model) pair that never existed, so every later generation fails.
      const fromAdoptedServer = picker.forUrl.length > 0;
      if (fromAdoptedServer && normalizeBaseUrl(picker.forUrl) !== normalizeBaseUrl(form.url)) {
        picker.models = [];
        picker.forUrl = '';
        picker.error = '';
        picker.custom = false;
        if (form.model.trim().length > 0) {
          form.model = '';
          api.toast('Model cleared — it belonged to the previous server.', 'info');
        }
        renderModelPicker(api);
      }
    },
  });
  const urlPresets = h(
    'datalist',
    { id: 'endpoint-presets' },
    ...presetBaseUrls().map((p) => h('option', { value: p.url, label: p.label })),
  );
  const vendorInput = h(
    'select',
    {
      id: 'endpoint-vendor',
      class: 'input',
      onchange: (event: Event) => {
        form.vendor = (event.target as HTMLSelectElement).value as EndpointVendor;
      },
    },
    h('option', {
      value: 'openai-compat',
      selected: form.vendor === 'openai-compat' ? true : undefined,
      text: 'OpenAI-compatible (/v1/chat/completions)',
    }),
    h('option', {
      value: 'ollama',
      selected: form.vendor === 'ollama' ? true : undefined,
      text: 'Ollama (native /api/chat)',
    }),
  );

  // ---- The model picker ----------------------------------------------------
  // A real list, built by `renderModelPicker` once a server is selected. The
  // old control was a free-text box whose suggestions came from a browser
  // datalist: datalists only reveal themselves on focus, differ wildly between
  // browsers, and — because the app simply wrote `models[0]` of an
  // alphabetically sorted list into it — quietly preselected an *embedding*
  // model on a stock LM Studio install.

  const keyInput = h('input', {
    id: 'endpoint-key',
    class: 'input key-input',
    type: 'password',
    value: form.apiKey,
    placeholder: 'optional — only needed if your server requires a key',
    autocomplete: 'off',
    spellcheck: false,
    oninput: (event: Event) => {
      form.apiKey = (event.target as HTMLInputElement).value;
      // The key is scoped to the host it was FIRST typed for. When the URL box
      // is empty (the reader cleared it to retype it) the origin is `''`, and
      // binding the key to `''` disabled the origin guard FOREVER: no later
      // URL edit cleared the key, and the secret was saved for whatever host
      // was typed next. Treat the binding as "not yet known" instead.
      const origin = originOf(form.url);
      if (origin !== '') form.keyOrigin = origin;
    },
  });
  api_toast_key_cleared = () =>
    api.toast('API key cleared — it belonged to the previous endpoint.', 'info');
  const revealKey = button(
    '👁 Show',
    () => {
      const shown = keyInput.type === 'password';
      keyInput.type = shown ? 'text' : 'password';
      // The label has to follow the state, or the reader cannot tell whether the
      // key is currently exposed (clicking again silently hides it).
      revealKey.textContent = shown ? '🙈 Hide' : '👁 Show';
      revealKey.setAttribute('aria-pressed', String(shown));
    },
    'chip',
  );
  revealKey.setAttribute('aria-label', 'Show or hide the API key');

  const tempInput = h('input', {
    class: 'input',
    type: 'range',
    min: '0',
    max: '2',
    step: '0.1',
    value: String(form.temperature),
    oninput: () => {
      form.temperature = Number(tempInput.value);
      tempLabel.textContent = `temperature: ${form.temperature.toFixed(1)}`;
    },
  });
  const tempLabel = h('span', {
    class: 'field-hint',
    text: `temperature: ${form.temperature.toFixed(1)}`,
  });

  const resultsBox = h('div', { class: 'scan-results llm-results' });
  /** Ports that answered nothing: real information, but not the headline. */
  const absentBox = h('div', { class: 'scan-results llm-absent' });
  const absentCount = h('span', { class: 'muted-count', id: 'absent-count', text: '' });
  const absentFold = h(
    'details',
    { class: 'folds quiet-folds' },
    h('summary', {}, h('span', { text: 'Known ports that answered nothing ' }), absentCount),
    absentBox,
  );
  const lanRowsBox = h('div', { class: 'scan-results lan-results' });
  const controls: Controls = {
    nameInput,
    urlInput,
    vendorInput,
    keyInput,
    tempInput,
    resultsBox,
    scanButton: undefined as unknown as HTMLButtonElement,
  };
  // While a sweep runs this button is ALSO the cancel button, and it must stay
  // clickable across a re-render. Rendering it disabled ("Scanning…") meant the
  // early refresh after the local sweep — which happens while the subnet sweep
  // is still going — silently removed the reader's only way to stop it.
  const scanning = scan.running || lan.running;
  const scanButton = button(
    scanning ? '✕ Cancel scan' : '🔍 Scan for local LLMs',
    () => void runScan(api, controls),
    scanning ? 'danger' : 'primary',
    {
      title: scanning ? 'Stop the sweep' : 'Look for LLM servers on this machine and your network',
    },
  );
  controls.scanButton = scanButton;
  // Reachable servers first, then the rest in catalog order. A dead port
  // answering "not found" in the middle of the list pushed the one working
  // server below the fold of a laptop screen.
  const liveResults = scan.results.filter((r) => r.status !== 'absent');
  const absentResults = scan.results.filter((r) => r.status === 'absent');
  for (const result of sortProbeResults(liveResults)) {
    resultsBox.appendChild(resultRow(api, result));
  }
  for (const result of sortProbeResults(absentResults)) {
    absentBox.appendChild(resultRow(api, result));
  }
  absentCount.textContent =
    absentResults.length > 0 ? `(${absentResults.length} of ${CANDIDATES.length})` : '';
  absentFold.hidden = absentResults.length === 0;

  const defaultLength = h(
    'select',
    {
      class: 'input',
      onchange: (event: Event) => {
        form.defaultLength = (event.target as HTMLSelectElement).value as
          'shorter' | 'standard' | 'longer';
      },
    },
    ...(['shorter', 'standard', 'longer'] as const).map((v) =>
      h('option', {
        value: v,
        selected: v === form.defaultLength ? true : undefined,
        text: v,
      }),
    ),
  );

  const autoBibleBox = h('input', {
    type: 'checkbox',
    checked: form.autoBible ? true : undefined,
    onchange: (event: Event) => {
      form.autoBible = (event.target as HTMLInputElement).checked;
    },
  });
  const autoSummaryBox = h('input', {
    type: 'checkbox',
    checked: form.autoSummary ? true : undefined,
    onchange: (event: Event) => {
      form.autoSummary = (event.target as HTMLInputElement).checked;
    },
  });
  const fastModelInput = h('input', {
    class: 'input',
    type: 'text',
    list: 'discovered-models',
    value: form.fastModel,
    placeholder: 'optional — e.g. a small quick model for titles, chat & the cast',
    spellcheck: false,
    oninput: (event: Event) => {
      form.fastModel = (event.target as HTMLInputElement).value;
    },
  });
  const autoSuggestBox = h('input', {
    type: 'checkbox',
    checked: form.autoSuggest ? true : undefined,
    onchange: (event: Event) => {
      form.autoSuggest = (event.target as HTMLInputElement).checked;
    },
  });

  let themeValue = api.lib.settings.theme;
  const persistAppearance = (patch: Partial<typeof api.lib.settings>): void => {
    // Appearance changes save IMMEDIATELY — they must stick across the whole
    // app, not just the settings page.
    api.update((lib) => ({ ...lib, settings: { ...lib.settings, ...patch } }));
  };
  const themeControl = segmentedTheme(api.lib.settings.theme, (theme) => {
    themeValue = theme;
    persistAppearance({ theme });
  });
  const fontScaleInput = h('input', {
    class: 'dial-range font-scale',
    type: 'range',
    min: '0.85',
    max: '1.35',
    step: '0.05',
    value: String(api.lib.settings.fontScale),
    title: 'Reading text size',
  });
  const fontScaleLabel = h('span', {
    class: 'field-hint',
    text: `×${Number(api.lib.settings.fontScale).toFixed(2)}`,
  });
  // Live label while dragging; persist on release. Persisting mid-drag used to
  // re-render the whole view and kill the drag under the pointer.
  fontScaleInput.addEventListener('input', () => {
    fontScaleLabel.textContent = `×${Number(fontScaleInput.value).toFixed(2)}`;
  });
  fontScaleInput.addEventListener('change', () => {
    persistAppearance({ fontScale: Number(fontScaleInput.value) });
  });
  const FONT_CHOICES: Array<[string, string]> = [
    ['auto', 'auto (reading font)'],
    ['georgia', 'Georgia'],
    ['palatino', 'Palatino'],
    ['charter', 'Charter'],
    ['serif', 'System serif'],
    ['sans', 'Clean sans'],
  ];
  const DOC_FORMATS: Array<[string, string]> = [
    ['story', '📄 story page'],
    ['letter', '✉️ letter'],
    ['diary', '📓 diary'],
    ['newspaper', '📰 newspaper'],
    ['mapnote', '🗺️ map notes'],
    ['recipe', '🍲 recipe'],
  ];
  const wardrobeControls = h(
    'div',
    { class: 'wardrobe' },
    ...DOC_FORMATS.map(([format, label]) =>
      h(
        'div',
        { class: 'wardrobe-row' },
        h('span', { class: 'wardrobe-label', text: label }),
        h(
          'select',
          {
            class: 'input wardrobe-select',
            dataset: { format },
          },
          ...FONT_CHOICES.map(([v, flabel]) =>
            h('option', {
              value: v,
              selected:
                v === (api.lib.settings.documentFonts?.[format as never] ?? 'auto')
                  ? true
                  : undefined,
              text: v === 'auto' && format === 'mapnote' ? 'auto (monospace)' : flabel,
            }),
          ),
        ),
      ),
    ),
  );
  // The wardrobe previews live, exactly like the theme and the text size —
  // every document format re-skins the moment its font changes.
  for (const select of Array.from(
    wardrobeControls.querySelectorAll<HTMLSelectElement>('.wardrobe-select'),
  )) {
    select.addEventListener('change', () => {
      persistAppearance({ documentFonts: collectWardrobe(wardrobeControls) });
    });
  }
  const readingFontSelect = h(
    'select',
    { class: 'input', id: 'reading-font' },
    ...[
      ['georgia', 'Georgia — the classic'],
      ['palatino', 'Palatino — literary'],
      ['charter', 'Charter — newsprint'],
      ['serif', 'System serif'],
      ['sans', 'Clean sans (modern)'],
    ].map(([v, label]) =>
      h('option', {
        value: v,
        selected: v === api.lib.settings.readingFont ? true : undefined,
        text: label,
      }),
    ),
  );
  // The reading font previews live too — no Save needed to see it change.
  readingFontSelect.addEventListener('change', () => {
    persistAppearance({
      readingFont: readingFontSelect.value as 'georgia' | 'palatino' | 'charter' | 'serif' | 'sans',
    });
  });

  // The endpoint's Save re-reads the appearance controls from this render, so
  // saving an endpoint can never store a stale theme or font alongside it.
  appearanceSnapshot = () => ({
    theme: themeValue,
    readingFont: readingFontSelect.value as ReadingFont,
    documentFonts: collectWardrobe(wardrobeControls),
    fontScale: Number(fontScaleInput.value),
  });

  const persistButton = button('Request persistent storage', () => void persist(api));
  const storageLine = h('span', { class: 'field-hint', text: 'checking…' });
  void fillStorageLine(storageLine);

  // ---- Network controls ----------------------------------------------------
  // The subnet box is a fallback, not the entry point: it is prefilled from
  // what the app detected (or from the last sweep) so a reader who has never
  // heard of a "subnet" can still find the machine in the next room by
  // pressing one button.
  const lanSubnetInput = h('input', {
    id: 'lan-subnet',
    class: 'input lan-subnet',
    type: 'text',
    value: lan.base,
    placeholder: 'e.g. 192.168.1',
    spellcheck: false,
    oninput: (event: Event) => {
      lan.base = (event.target as HTMLInputElement).value;
      // A confirmation belongs to one address; edge it out when it changes.
      if (lan.base !== confirmedBase) subnetConfirmed = false;
    },
  });
  const lanChips = h(
    'div',
    { class: 'row gap subnet-chips' },
    ...subnetChoiceOrder().map((guess) =>
      button(
        guess.evidence ? `${guess.base} ✓` : guess.base,
        () => {
          lan.base = guess.base;
          lanSubnetInput.value = guess.base;
          if (lan.base !== confirmedBase) subnetConfirmed = false;
          renderNetLineInto();
        },
        'chip',
        { title: guess.evidence || `sweep ${guess.base}.1–254` },
      ),
    ),
  );
  const thoroughBox = h('input', {
    type: 'checkbox',
    id: 'thorough-sweep',
    checked: thoroughSweep ? true : undefined,
    onchange: (event: Event) => {
      thoroughSweep = (event.target as HTMLInputElement).checked;
    },
  });
  const lanProgress = h('span', {
    class: 'field-hint',
    id: 'lan-progress',
    text: lan.running
      ? lan.progressText || `scanning ${lan.base}.1–254 on ${llmPorts().length} ports…`
      : lan.summary || 'checked together with the scan above',
  });
  // The `lan-results` class is what lets a still-running sweep find the box
  // that a mid-scan re-render put on screen (see sweepNetwork).
  for (const server of lan.results) lanRowsBox.appendChild(lanServerRow(api, server));

  const netLine = h('p', { class: 'field-hint net-line', id: 'net-line' });
  renderNetLine(netLine);

  if (!net.detected) {
    net.detected = true;
    void ensureDetection(api);
  }

  const statusLine = h('span', { class: 'field-hint endpoint-status', id: 'endpoint-status' });
  if (lastStatus.kind !== 'none') {
    statusLine.textContent = lastStatus.text;
    // Restore the kind's styling too: a fresh render rebuilt this node with
    // the neutral class, so an error or success message lost its colour until
    // the next setStatus call.
    applyStatusKind(statusLine, lastStatus.kind);
  }
  const saveButton = button(saving ? 'Saving…' : '💾 Save', () => {
    void saveEndpoint(api).then((ok) => {
      // The refactor dropped the confirmation entirely: a successful plain
      // Save changed nothing on screen in the common no-op case, so the
      // reader could not tell it did anything. ('Save & test' has its own
      // "Connected…" status, so this toast is for the plain path only.)
      if (ok) api.toast('Settings saved', 'success');
    });
  });
  saveButton.id = 'endpoint-save';
  const saveTestButton = button(
    saving || testing ? 'Working…' : '✅ Save & test',
    () => void testConnection(api, saveTestButton),
    'primary',
    { disabled: saving || testing },
  );
  saveTestButton.id = 'endpoint-save-test';

  const modelPickerBox = h('div', { class: 'model-picker' });
  renderModelPicker(api, modelPickerBox);
  // Built WITH its options: the datalist is created after `renderModelPicker`
  // (which fills it by id) and the tree is only mounted later by the shell, so
  // the refresh always filled the PREVIOUS render's datalist and armed this
  // empty one — every re-render left the Fast-model field and the "type a name"
  // box with nothing to suggest.
  const modelDatalist = h(
    'datalist',
    { id: 'discovered-models' },
    ...modelOptions().map((model) => h('option', { value: model })),
  );

  return h(
    'div',
    { class: 'view view-settings' },
    h('header', { class: 'view-head' }, h('h1', { text: 'Settings' })),
    h('p', {
      class: 'lede',
      text: 'Page Turn talks to the endpoint you configure — a local server, a LAN machine, or a key-protected API. Prompts go only there.',
    }),

    h(
      'section',
      { class: 'card card-llm', id: 'llm-setup' },
      h('h2', { text: 'Local LLM' }),
      renderEndpointStatus(api),

      // ---- Step 1 — find a server ------------------------------------------
      h(
        'div',
        { class: 'setup-step' },
        h(
          'h3',
          { class: 'step-title' },
          h('span', { class: 'step-num', text: '1' }),
          ' Find a server',
        ),
        h(
          'div',
          { class: 'row gap' },
          scanButton,
          h('p', {
            class: 'field-hint',
            text: `Probes ${CANDIDATES.length} known local endpoints on this machine${
              lan.base
                ? ` and every address on ${lan.base}.1–254 on ${
                    thoroughSweep ? llmPorts().length : commonLlmPorts().length
                  } LLM ports`
                : ''
            }.`,
          }),
        ),
        netLine,
        h('div', { class: 'row gap subnet-row' }, lanChips),
        h(
          'details',
          { class: 'folds quiet-folds' },
          h('summary', { text: 'Change the network being searched' }),
          h('div', { class: 'row gap' }, lanSubnetInput, lanProgress),
          h(
            'div',
            { class: 'row gap' },
            (() => {
              const sweep = button(
                lan.running ? 'Sweeping…' : '🌐 Sweep this network',
                () => {
                  // The button's disabled state is a render-time snapshot and
                  // no render happens between a scan starting and its first
                  // refresh — so during that window a click here must refuse,
                  // not fall into runScan's cancel branch, which is the exact
                  // opposite of this button's label.
                  if (scan.running || lan.running) {
                    api.toast('A scan is already running — stop it first.', 'info');
                    return;
                  }
                  const base = normalizeSubnetBase(lanSubnetInput.value || lan.base);
                  if (!base) {
                    api.toast('Enter a subnet first — e.g. 192.168.1', 'error');
                    return;
                  }
                  lan.base = base;
                  subnetConfirmed = true;
                  confirmedBase = base;
                  void runScan(api, controls);
                },
                'ghost',
                { disabled: scan.running || lan.running },
              );
              sweep.id = 'lan-sweep-anyway';
              return sweep;
            })(),
            h('p', {
              class: 'field-hint',
              text: 'Only needed when this network was not detected: sweeping a range that is not yours is slow and leaves the browser busy, so the scan above skips it unless something has answered there.',
            }),
          ),
          h(
            'label',
            { class: 'field check-field' },
            thoroughBox,
            h('span', {
              text: ` Also try the less common LLM ports (all ${llmPorts().length}, not just ${commonLlmPorts().length})`,
            }),
          ),
          h('p', {
            class: 'field-hint',
            text: 'One sweep is up to 254 addresses × the known LLM ports, and it is cancellable at any time — almost every address is expected to answer nothing. Every port of an address is tried at once, so the sweep stays a few seconds either way. The server must listen on the LAN interface (LM Studio: “Serve on Local Network”; Ollama: OLLAMA_HOST=0.0.0.0) and the same CORS rules apply as on this machine.',
          }),
        ),
        resultsBox,
        absentFold,
        h(
          'details',
          { class: 'folds', open: lan.results.length > 0 ? true : undefined },
          h('summary', {
            text: lan.running
              ? 'Searching your network…'
              : lan.results.length > 0
                ? `${lan.results.length} server(s) on your network`
                : 'Servers found on your network',
          }),
          lanRowsBox,
        ),
        h(
          'details',
          { class: 'folds' },
          h('summary', { text: 'Add a server by address instead' }),
          field('Name', nameInput, 'Any label you like.'),
          field(
            'Base URL',
            urlInput,
            'Any host:port — e.g. http://192.168.1.50:1234 — with or without /v1, optional path prefix.',
          ),
          h(
            'div',
            { class: 'row gap' },
            button('🔍 Probe this URL', () => void probeCustom(api, controls), 'ghost', {
              title: 'Test the typed URL and list its models',
            }),
            h('p', {
              class: 'field-hint',
              text: 'Probing a typed address fills in the model list above.',
            }),
          ),
          field(
            'Protocol',
            vendorInput,
            'Ollama = native /api/chat · OpenAI-compatible = /v1/chat/completions',
          ),
        ),
      ),

      // ---- Step 2 — choose a model -----------------------------------------
      h(
        'div',
        { class: 'setup-step', id: 'model-step' },
        h(
          'h3',
          { class: 'step-title' },
          h('span', { class: 'step-num', text: '2' }),
          ' Choose a model',
        ),
        modelPickerBox,
      ),

      // ---- Step 3 — save ----------------------------------------------------
      h(
        'div',
        { class: 'setup-step' },
        h('h3', { class: 'step-title' }, h('span', { class: 'step-num', text: '3' }), ' Save'),
        h('div', { class: 'row gap' }, saveButton, saveTestButton, statusLine),
        h('p', {
          class: 'field-hint',
          text: '“Save & test” stores the endpoint and asks the model to answer once, so you know generation will work before you write a word.',
        }),
        h(
          'details',
          { class: 'folds' },
          h('summary', { text: 'Advanced (API key, temperature, fast model)' }),
          field(
            'API key (optional)',
            h('div', { class: 'row gap' }, keyInput, revealKey),
            'Sent as “Authorization: Bearer …” only to this endpoint. Most local servers need no key.',
          ),
          field('Temperature', h('div', { class: 'row gap' }, tempInput, tempLabel)),
          field(
            'Fast model (optional)',
            fastModelInput,
            'Used for the cheap phases — titles, chat, suggested beats, endings, the cast and the story summary. Leave empty to use the main model for everything.',
          ),
        ),
      ),
    ),

    h(
      'section',
      { class: 'card' },
      h('h2', { text: 'Writing' }),
      field(
        'Default page length',
        defaultLength,
        'The starting length for every new page — changeable at each turn.',
      ),
      h(
        'label',
        { class: 'field check-field' },
        autoBibleBox,
        h('span', { text: ' Keep the living cast up to date' }),
      ),
      h('p', {
        class: 'field-hint',
        text: 'After each page, quietly ask the model to update the people · places · things list. Turn off to update it only by hand.',
      }),
      h(
        'label',
        { class: 'field check-field' },
        autoSummaryBox,
        h('span', { text: ' Keep the rolling story summary up to date' }),
      ),
      h('p', {
        class: 'field-hint',
        text: 'After each page, quietly fold the whole story into a compact memory that is injected into every generation — so long books never forget their beginning. Turn off to update it only by hand.',
      }),
      h(
        'label',
        { class: 'field check-field' },
        autoSuggestBox,
        h('span', { text: ' Propose next-beat directions automatically' }),
      ),
      h('p', {
        class: 'field-hint',
        text: 'At every turn, the model suggests three possible next beats without being asked (one extra request per turn).',
      }),
      h('p', {
        class: 'field-hint',
        text: 'The optional fast model for the cheap phases lives with the endpoint, above.',
      }),
    ),

    h(
      'section',
      { class: 'card' },
      h('h2', { text: 'Appearance' }),
      field(
        'Reading theme',
        themeControl,
        'Dark candlelight by default; sepia and light for daytime reading.',
      ),
      field(
        'Reading text size',
        h('div', { class: 'row gap' }, fontScaleInput, fontScaleLabel),
        'Scales the page typography.',
      ),
      field(
        'Reading font',
        readingFontSelect,
        'The typeface for page prose (system fonts, nothing to download).',
      ),
      field(
        'The document wardrobe',
        wardrobeControls,
        'Each diegetic format can wear its own font. "Auto" inherits the reading font.',
      ),
    ),

    h(
      'section',
      { class: 'card' },
      h('h2', { text: 'Local files' }),
      h('p', {
        class: 'field-hint',
        text: 'Your whole library lives in the browser’s local database (IndexedDB) and is mirrored to an OPFS workspace file. Use pickers or downloads for portable files.',
      }),
      h('div', { class: 'row gap' }, persistButton, storageLine),
      h(
        'div',
        { class: 'row gap' },
        button('⇓ Export library (.json)', () => void exportAll(api)),
        button('↥ Import library…', () => void importAll(api)),
      ),
      (() => {
        const line = h('p', { class: 'field-hint', text: 'checking local file support…' });
        void opfsAvailable().then((ok) => {
          line.textContent =
            `File System Access pickers: ${hasFilePicker() ? 'supported' : 'not supported — downloads used instead'} · ` +
            `OPFS workspace: ${
              ok
                ? 'supported'
                : hasOpfs()
                  ? 'not available on this origin (browsers block it on file:// URLs — serve the file over http://localhost for the extra copy)'
                  : 'not supported'
            }`;
        });
        return line;
      })(),
    ),

    h(
      'section',
      { class: 'card card-help' },
      h('h2', { text: 'Help' }),
      h(
        'details',
        { class: 'folds' },
        h('summary', { text: '“CORS-blocked” — what does that mean?' }),
        h('p', {
          text: 'A server answered, but refused requests from this page’s origin (web pages may only call other origins when the server explicitly allows it). Fixes: enable CORS for localhost origins in your server (LM Studio ships with it enabled; Ollama respects OLLAMA_ORIGINS; llama.cpp needs --cors), or open Page Turn from a localhost URL — pnpm dev serves http://localhost:4173, which most servers allow by default.',
        }),
      ),
      h(
        'details',
        { class: 'folds' },
        h('summary', { text: 'Where is my data?' }),
        h('p', {
          text: 'In this browser profile: IndexedDB (“page-turn” database) plus an OPFS file, both on your disk. Export the library as .json for a portable copy — you own the tree.',
        }),
      ),
      h(
        'details',
        { class: 'folds' },
        h('summary', { text: 'Danger zone' }),
        h(
          'div',
          { class: 'row gap' },
          button(
            'Wipe everything',
            () => {
              if (
                window.confirm('Delete every book, every page, every decision?') &&
                window.confirm('Really — this cannot be undone. Export first if you want a copy.')
              ) {
                void wipe(api);
              }
            },
            'danger',
          ),
        ),
      ),
    ),
    urlPresets,
    modelDatalist,
  );
}

// ---- Adopting a server -----------------------------------------------------

interface AdoptOptions {
  label: string;
  baseUrl: string;
  vendor: EndpointVendor;
  models: string[];
  /** Where it came from, for the toast. */
  origin: string;
}

/**
 * The bridge between step 1 and step 2: remember the chosen server, load its
 * model list into the picker, pre-select the best writer on it, and put the
 * reader's attention on the model list instead of leaving them to hunt for a
 * Save button at the bottom of the page.
 */
function selectServer(api: AppApi, options: AdoptOptions): void {
  // A key belongs to the host it was entered for. Carrying it across made
  // every later request send `Authorization: Bearer *** to a machine
  // the reader never gave it to — directly contradicting the field's own
  // promise ("sent only to this endpoint").
  clearKeyIfHostChanged(options.baseUrl);
  form.name = options.label;
  form.url = options.baseUrl;
  form.vendor = options.vendor;
  // Write the fields that are on screen NOW: rows are appended mid-scan (and
  // any row can outlive a re-render), so the inputs they captured are detached
  // by the time "Use" is clicked — writing to those left the visible Name /
  // Base URL / Protocol boxes showing the PREVIOUS server while Save stored
  // the new one.
  const setField = (id: string, value: string): void => {
    const node = live(id);
    if (node instanceof HTMLInputElement || node instanceof HTMLSelectElement) node.value = value;
  };
  setField('endpoint-name', options.label);
  setField('endpoint-url', options.baseUrl);
  setField('endpoint-vendor', options.vendor);

  for (const model of options.models) {
    if (!discoveredModels.includes(model)) discoveredModels.push(model);
  }
  picker.models = rankModels(options.models);
  picker.forUrl = options.baseUrl;
  picker.error = '';
  picker.custom = options.models.length === 0;
  // Adopting a server adopts the best model on it — never a stale name from
  // the previous server, and never `models[0]` of an alphabetical list.
  form.model = pickBestModel(options.models);
  renderModelPicker(api);
  markSelectedServer();
  renderEndpointStatusInto(api);
  api.toast(
    options.models.length > 0
      ? `${options.origin} selected — ${options.models.length} model(s) loaded. Pick one, then Save & test.`
      : `${options.origin} selected — it did not list its models, so type the model name.`,
    options.models.length > 0 ? 'success' : 'info',
  );
  const step = live('model-step');
  step?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** Highlight the row the draft currently points at. */
function markSelectedServer(): void {
  const current = normalizeBaseUrl(form.url);
  for (const row of document.querySelectorAll<HTMLElement>('.scan-row[data-base-url]')) {
    row.classList.toggle('scan-row-selected', row.dataset.baseUrl === current);
  }
}

// ---- Discovery rows --------------------------------------------------------

/** Most useful first: reachable, then needs-a-key, then CORS, then nothing. */
const STATUS_ORDER: Record<ProbeResult['status'], number> = {
  reachable: 0,
  unauthorized: 1,
  'cors-blocked': 2,
  absent: 3,
};

function sortProbeResults(results: ProbeResult[]): ProbeResult[] {
  const catalog = new Map(CANDIDATES.map((candidate, index) => [candidate.id, index]));
  return [...results].sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    return (catalog.get(a.candidate.id) ?? 99) - (catalog.get(b.candidate.id) ?? 99);
  });
}

/** Which panel a result belongs in, found live so a re-render cannot orphan it. */
function resultBoxFor(result: ProbeResult, fallback: HTMLElement): HTMLElement {
  const selector = result.status === 'absent' ? '.llm-absent' : '.llm-results';
  return document.querySelector<HTMLElement>(selector) ?? fallback;
}

function refreshAbsentCount(): void {
  const node = live('absent-count');
  if (!node) return;
  const count = scan.results.filter((r) => r.status === 'absent').length;
  node.textContent = count > 0 ? `(${count} of ${CANDIDATES.length})` : '';
}

function resultRow(api: AppApi, result: ProbeResult): HTMLElement {
  const status =
    result.status === 'reachable'
      ? h('span', { class: 'badge badge-ok', text: '✓ reachable' })
      : result.status === 'cors-blocked'
        ? h('span', { class: 'badge badge-warn', text: 'CORS-blocked' })
        : result.status === 'unauthorized'
          ? h('span', { class: 'badge badge-warn', text: '🔑 needs key' })
          : h('span', { class: 'badge badge-off', text: 'not found' });

  const adoptable = result.status === 'reachable' && result.models.length > 0;
  const use = (): void =>
    selectServer(api, {
      label: result.candidate.label,
      baseUrl: result.candidate.baseUrl,
      vendor: result.candidate.vendor,
      models: result.models,
      origin: `${result.candidate.label}${vendorNote(result.candidate)}`,
    });

  return h(
    'div',
    {
      class: `scan-row${result.status === 'reachable' ? ' scan-row-ok' : ''}`,
      dataset: { baseUrl: result.candidate.baseUrl },
    },
    status,
    h('span', {
      class: 'scan-label',
      text: `${result.candidate.label} — ${result.candidate.baseUrl}`,
    }),
    // Always show the detail: it is the only place the HTTP status — the most
    // useful signal about what actually answered — is ever surfaced. "Use" is
    // offered only when the endpoint returned a model list, so a stray dev
    // server can no longer be adopted by one click.
    h('span', {
      class: 'scan-detail',
      text:
        result.status === 'reachable'
          ? `${result.models.length} model(s) · ${result.latencyMs ?? '?'} ms`
          : result.detail,
    }),
    adoptable ? button('Use', use, 'chip') : null,
  );
}

function lanServerRow(api: AppApi, server: LanServer): HTMLElement {
  const status =
    server.status === 'reachable'
      ? h('span', { class: 'badge badge-ok', text: '✓ reachable' })
      : server.status === 'unauthorized'
        ? h('span', { class: 'badge badge-warn', text: '🔑 needs key' })
        : server.status === 'cors-blocked'
          ? h('span', { class: 'badge badge-warn', text: 'CORS-blocked' })
          : // Something answered the presence probe but then said nothing at
            // all, retry included. Reporting THAT as CORS-blocked sent the
            // reader off to change server-side origin settings for a server
            // that never refused anything — the same misdiagnosis `status`
            // exists to prevent.
            h('span', { class: 'badge badge-off', text: 'no model list' });

  const use = (): void =>
    selectServer(api, {
      label: `LAN · ${server.host}`,
      baseUrl: server.baseUrl,
      vendor: server.vendor,
      models: server.models,
      origin: `the server at ${server.host}:${server.port}`,
    });

  return h(
    'div',
    {
      class: 'scan-row lan-row',
      dataset: { baseUrl: server.baseUrl },
    },
    status,
    h('span', {
      class: 'scan-label',
      text: `${server.host}:${server.port} — ${server.baseUrl}`,
    }),
    h('span', {
      class: 'scan-detail',
      text: server.corsOk
        ? `${server.models.length} model(s) · ${server.latencyMs ?? '?'} ms`
        : server.detail,
    }),
    // Only a responder that actually lists models is adoptable: this gate is
    // exactly the fix the catalog rows got, and LAN responders are the least
    // identifiable machines in the app (a router admin page, a NAS…).
    server.corsOk && server.models.length > 0 ? button('Use', use, 'chip') : null,
  );
}

// ---- The model picker (step 2) ---------------------------------------------

/**
 * Rebuild the model list. `box` is passed while the view is being constructed
 * (the node is not in the document yet); afterwards it is found by class so a
 * render that happened in between can never make this write to a dead node.
 */
function renderModelPicker(api: AppApi, box?: HTMLElement): void {
  const target = box ?? document.querySelector<HTMLElement>('.model-picker');
  if (!target) return;

  refreshModelDatalist();

  const customInput = h('input', {
    class: 'input',
    type: 'text',
    id: 'endpoint-model-custom',
    list: 'discovered-models',
    value: form.model,
    placeholder: 'type the model name exactly, e.g. qwen2.5-7b-instruct',
    spellcheck: false,
    // No re-render on typing: rebuilding the input mid-word would drop focus.
    oninput: (event: Event) => {
      form.model = (event.target as HTMLInputElement).value;
    },
  });

  const known =
    picker.models.length > 0 && normalizeBaseUrl(picker.forUrl) === normalizeBaseUrl(form.url);
  const showCustom = !known || picker.custom || !picker.models.includes(form.model);
  const hasAddress = /^https?:\/\/[^/]+/i.test(normalizeBaseUrl(form.url));

  if (!known) {
    // Nothing to choose from yet. Offering an empty text box here was how the
    // old page let a reader type a model name for a server they had not
    // chosen, then wonder why nothing worked — the box only makes sense once
    // there is an address for it to belong to.
    if (!hasAddress) {
      target.replaceChildren(
        h('p', {
          class: 'field-hint',
          text: 'Nothing to choose yet — pick a server in step 1 and its models appear here.',
        }),
      );
      return;
    }
    const load = button(
      picker.loading ? '↻ Loading…' : '↻ Load this server’s models',
      () => void reloadModels(api),
      'chip',
      { disabled: picker.loading },
    );
    load.id = 'endpoint-reload-models';
    target.replaceChildren(
      picker.loading
        ? field('Model', h('div', { class: 'row gap' }, spinner(), load))
        : field(
            'Model',
            h('div', { class: 'row gap' }, customInput, load),
            picker.error
              ? picker.error
              : `Type the model name on ${normalizeBaseUrl(form.url)} — or press “Load this server’s models” to read its list.`,
          ),
    );
    return;
  }

  const selected = picker.models.includes(form.model)
    ? form.model
    : picker.custom
      ? CUSTOM_MODEL
      : '';
  const select = h(
    'select',
    {
      class: 'input',
      id: 'endpoint-model',
      onchange: () => {
        if (select.value === CUSTOM_MODEL) {
          picker.custom = true;
          renderModelPicker(api);
          document.getElementById('endpoint-model-custom')?.focus();
          return;
        }
        picker.custom = false;
        form.model = select.value;
        renderModelPicker(api);
        // `renderEndpointStatus` BUILDS a node and returns it (the initial
        // render inserts it); updating the strip on screen is the `…Into`
        // form. Without it the strip kept naming the previously saved model
        // and never showed "• unsaved changes" — at the exact moment the
        // reader changed it.
        renderEndpointStatusInto(api);
      },
    },
    h('option', {
      value: '',
      text: '— pick a model —',
      selected: selected === '' ? true : undefined,
    }),
    ...picker.models.map((model, index) =>
      h('option', {
        value: model,
        selected: selected === model ? true : undefined,
        text: modelLabel(model, index === 0 && picker.models.length > 1),
      }),
    ),
    h('option', {
      value: CUSTOM_MODEL,
      selected: selected === CUSTOM_MODEL ? true : undefined,
      text: 'Other — type a name…',
    }),
  );

  const reload = button(
    picker.loading ? '↻ Loading…' : '↻ Reload models',
    () => void reloadModels(api),
    'chip',
    { disabled: picker.loading },
  );
  reload.id = 'endpoint-reload-models';

  target.replaceChildren(
    field(
      'Model',
      h('div', { class: 'row gap' }, select, reload),
      `${picker.models.length} model(s) on this server — best first.` + (showCustom ? '' : ''),
    ),
    ...(showCustom ? [h('div', { class: 'row gap model-custom' }, customInput)] : []),
    h('p', {
      class: 'field-hint',
      text: showCustom
        ? 'Type a name the server did not list (or fix the spelling of one it did).'
        : 'The list comes from the server itself; “Reload models” re-reads it after you load another model.',
    }),
  );
}

/** Every model name worth suggesting: the ones discovered so far, plus both drafts. */
function modelOptions(): string[] {
  return [...new Set([...discoveredModels, form.model, form.fastModel])].filter(
    (model) => model.length > 0,
  );
}

/**
 * Repopulate the one `#discovered-models` datalist every model field points at
 * (the picker's "Other" box and the fast-model field). It lives in the view
 * tree rather than inside the picker, so it exists whether or not a server has
 * been chosen — a `list` attribute pointing at nothing silently offers no
 * suggestions at all.
 */
function refreshModelDatalist(): void {
  const list = document.getElementById('discovered-models');
  if (!list) return;
  list.replaceChildren(...modelOptions().map((model) => h('option', { value: model })));
}

/** "mock-storyteller-7b · 7B · instruct" plus the ★ on the app's own pick. */
function modelLabel(model: string, isBest: boolean): string {
  const traits = modelTraits(model);
  const star = isBest ? '★ ' : '';
  return `${star}${model}${traits ? ` · ${traits}` : ''}`;
}

/**
 * Re-read the selected endpoint's model list. Servers gain and lose models all
 * the time (a fresh LM Studio download, an `ollama pull`), and before this the
 * only way to see the new list was to run the whole discovery again.
 */
async function reloadModels(api: AppApi): Promise<void> {
  const baseUrl = normalizeBaseUrl(form.url);
  if (!/^https?:\/\/[^/]+/i.test(baseUrl)) {
    api.toast('Choose a server first.', 'info');
    return;
  }
  picker.loading = true;
  picker.error = '';
  renderModelPicker(api);
  const result = await probeCandidate({
    id: 'reload',
    label: form.name || 'Endpoint',
    baseUrl,
    vendor: form.vendor,
    note: '',
  });
  picker.loading = false;
  // The reader can retype the address while the list loads: the result belongs
  // to the URL it was ASKED for, not to whatever is in the box now.
  if (baseUrl !== normalizeBaseUrl(form.url)) {
    renderModelPicker(api);
    return;
  }
  picker.forUrl = baseUrl;
  if (result.status !== 'reachable') {
    picker.error = `Could not read the model list (${result.detail}).`;
    renderModelPicker(api);
    api.toast(`Model list unavailable — ${result.detail}`, 'info');
    return;
  }
  picker.models = rankModels(result.models);
  if (result.models.length === 0) {
    picker.error = 'The server answered, but listed no models.';
    picker.custom = true;
  }
  for (const model of result.models) {
    if (!discoveredModels.includes(model)) discoveredModels.push(model);
  }
  if (!picker.models.includes(form.model)) form.model = pickBestModel(result.models);
  renderModelPicker(api);
  renderEndpointStatusInto(api);
  api.toast(`${picker.models.length} model(s) on ${baseUrl}.`, 'success');
}

// ---- Status lines ----------------------------------------------------------

/**
 * The one line that answers "is this thing set up?" — the question the old
 * settings page never answered anywhere: the saved endpoint could be visible
 * in the fields while being completely broken, and nothing said so.
 */
function renderEndpointStatus(api: AppApi): HTMLElement {
  const node = h('div', { class: 'endpoint-state', id: 'endpoint-state' });
  fillEndpointStatus(node, api);
  return node;
}

function fillEndpointStatus(node: HTMLElement, api: AppApi): void {
  const saved = api.lib.settings.endpoint;
  const configured = /^https?:\/\/[^/]+/i.test(saved.baseUrl) && saved.model.length > 0;
  const draftMatches = normalizeBaseUrl(form.url) === saved.baseUrl && form.model === saved.model;
  node.replaceChildren(
    h('span', {
      class: `state-dot ${configured ? 'state-on' : 'state-off'}`,
      'aria-hidden': 'true',
      text: configured ? '●' : '○',
    }),
    h('span', {
      class: 'state-text',
      text: configured
        ? `Ready: ${saved.name} · ${saved.model} at ${saved.baseUrl}`
        : 'No model selected yet — start with step 1.',
    }),
    ...(configured && !draftMatches
      ? [h('span', { class: 'state-pending', text: '• unsaved changes' })]
      : []),
  );
}

/** Redraw the live status strip, whichever render put it on screen. */
function renderEndpointStatusInto(api: AppApi): void {
  const node = live('endpoint-state');
  if (node) fillEndpointStatus(node, api);
}

/** "This machine: 192.168.1.211 · network 192.168.1.0/24 (router answered)". */
function renderNetLine(node: HTMLElement): void {
  if (net.detecting) {
    node.textContent = 'Looking for your network…';
    return;
  }
  const base = lan.base || savedSubnet();
  const parts: string[] = [];
  if (net.addresses.length > 0) {
    parts.push(`this page is on ${net.addresses.join(' / ')}`);
  }
  const evidence = net.guesses.find((guess) => guess.base === base && guess.evidence);
  if (evidence) {
    parts.push(
      `network ${base}.0/24${evidence.latencyMs === null ? '' : ` — ${evidence.evidence}`}`,
    );
  } else if (base) {
    parts.push(`network ${base}.0/24`);
  }
  const sweepable = canSweep(base);
  node.textContent =
    parts.length > 0
      ? `${parts.join(' · ')}. ${
          sweepable
            ? 'Scanning this machine and that network together.'
            : 'This network has not answered, so the scan covers this machine — “sweep this network” below includes it.'
        }`
      : 'Could not tell which network this page is on — pick one below, or leave it and only this machine is scanned.';
}

/** Redraw the live network line, whichever render put it on screen. */
function renderNetLineInto(): void {
  const node = live('net-line');
  if (node) renderNetLine(node);
}

function savedSubnet(): string {
  return seededEndpointNet;
}

/**
 * Is this subnet known to be ours — either because something answered on it,
 * or because the page holds an address on it?
 *
 * The gate for the automatic sweep, and it is not a nicety. Sweeping an
 * address range that is not really ours sends thousands of connect attempts
 * into a black hole: the kernel holds each one for its full SYN retry window
 * (~2 minutes), and Chromium's network service is left so backed up that
 * ordinary requests — including the app's own probe of the LLM server on this
 * machine — stall for tens of seconds. An address of our own (`detected`) and
 * a router that answered are the two ways to know the range is real, and both
 * mean sweeping it is cheap.
 */
function canSweep(base: string): boolean {
  if (base === '') return false;
  if (hasEvidence(base)) return true;
  return subnetConfirmed && confirmedBase === base;
}

function hasEvidence(base: string): boolean {
  const guess = net.guesses.find((candidate) => candidate.base === base);
  if (guess === undefined) return false;
  return guess.detected === true || guess.latencyMs !== null;
}

/** A chip for a subnet we know nothing about yet — beyond any address we hold. */
function guessFor(base: string): SubnetGuess {
  const ip = net.addresses.find((candidate) => subnetBaseOf(candidate) === base);
  return ip === undefined
    ? { base, evidence: '', latencyMs: null }
    : { base, evidence: `this page is served from ${ip}`, latencyMs: null, detected: true };
}

/** Subnets to offer as chips: detected evidence first. */
function subnetChoiceOrder(): SubnetGuess[] {
  if (net.guesses.length > 0) return net.guesses;
  return subnetCandidates(net.addresses).map(guessFor);
}

/**
 * Run (or join) the one network detection of this session. `runScan` awaits
 * this before deciding which subnet to sweep: a reader who presses Scan the
 * instant the page paints used to get a local-only sweep because detection had
 * not answered yet, with no sign that the network half had been skipped.
 */
function ensureDetection(api: AppApi): Promise<void> {
  netRun ??= detectNetwork(api);
  return netRun;
}

/**
 * Find the network this machine is on, by asking it. Runs once per session —
 * it is a handful of sub-second probes, and the answer decides whether the
 * one-button scan also sweeps a subnet.
 */
async function detectNetwork(api: AppApi): Promise<void> {
  net.detecting = true;
  const line = live('net-line');
  if (line) renderNetLine(line);
  try {
    const addresses = await detectLocalIps(1200);
    net.addresses = addresses;
    net.guesses = await rankSubnets({
      detectedIps: addresses,
      // The subnet from last time is tested too: it is the one the reader
      // cares about, and a router that answers there is the evidence that
      // lets the one-button scan sweep it again without asking.
      extra: seededEndpointNet ? [seededEndpointNet] : [],
    });
    // Nothing answered anywhere. Before settling on "no network", try once
    // more a moment later: a browser that is still working through the
    // backlog of an earlier sweep will time out even the router. Only worth
    // asking when the network is the only source of an answer — with an
    // address of our own in hand the sweep gate is already satisfied, so
    // re-asking would just add another second of waiting to the scan.
    if (net.addresses.length === 0 && net.guesses.every((guess) => guess.latencyMs === null)) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const retry = await rankSubnets({
        detectedIps: addresses,
        extra: seededEndpointNet ? [seededEndpointNet] : [],
      });
      if (retry.some((guess) => guess.latencyMs !== null)) net.guesses = retry;
    }
  } catch {
    net.guesses = subnetCandidates(net.addresses).map(guessFor);
  }
  net.detecting = false;
  const detected = net.guesses.find((guess) => guess.latencyMs !== null)?.base;
  // An address of ours names the subnet this page is on. The guesses already
  // carry that list in preference order (a network the app knows by name beats
  // a virtual adapter's range), so the choice of network follows them rather
  // than the raw candidate order.
  const fromAddress = net.guesses.find((guess) => guess.detected)?.base ?? '';
  if (!lan.base) {
    // `||`, not `??`: an empty address is "we learned nothing", not a decision
    // to search nowhere — the remembered subnet still applies.
    lan.base = detected || fromAddress || savedSubnet();
  } else if (
    // A remembered subnet is a prefill, not a decision. Real evidence — a
    // router that answered, or an address this page is actually served from —
    // outranks it, or a stale "127.0.0" left over from an experiment would
    // keep the app sweeping the wrong range on every later visit.
    lan.base === savedSubnet() &&
    !subnetConfirmed &&
    (detected !== undefined || fromAddress !== '')
  ) {
    lan.base = detected ?? fromAddress;
  }
  // Re-render rather than write to the nodes captured above: the detection
  // resolves well after the render that started it, and a theme or font
  // preview in between replaces every one of them.
  api.refresh();
}

// ---- Saving and testing ----------------------------------------------------

/**
 * Persist the endpoint exactly as typed, plus the rest of the draft. Returns
 * false (with a toast) when there is nothing usable to save.
 */
async function saveEndpoint(api: AppApi): Promise<boolean> {
  const endpoint = collectEndpoint();
  // An empty base URL used to be saved happily: "Settings saved", and then
  // `chat()` fetched the app's OWN origin (`/v1/chat/completions`) until the
  // next load, when the schema quietly replaced the empty URL with the
  // default — the configured endpoint changing without the reader touching
  // anything. The same check also rejects the shapes fetch() itself refuses
  // (credentials, a trailing colon), which surfaced as a raw TypeError later.
  const urlProblem = baseUrlProblem(endpoint.baseUrl);
  if (urlProblem) {
    api.toast(urlProblem, 'error');
    return false;
  }
  if (endpoint.model.length === 0) {
    api.toast('Pick a model in step 2 first, or type its name.', 'error');
    return false;
  }
  if (endpoint.model) {
    discoveredModels.push(endpoint.model);
  }
  lan.base = lan.base || savedSubnet();
  const subnet = normalizeSubnetBase(lan.base) ?? '';
  api.update((lib) => ({
    ...lib,
    settings: {
      ...lib.settings,
      endpoint,
      defaultLength: form.defaultLength,
      autoBible: form.autoBible,
      autoSummary: form.autoSummary,
      autoSuggest: form.autoSuggest,
      fastModel: form.fastModel.trim(),
      // Remembering the subnet is the difference between "type your network
      // address every time" and "it just works".
      lanSubnet: subnet,
      ...appearanceSnapshot(),
    },
  }));
  return true;
}

/**
 * Save, then prove it works. Persist FIRST and test the SAVED endpoint —
 * "Connected" must mean the endpoint every future generation (titles, pages)
 * will actually use, not some unsaved copy of it.
 */
async function testConnection(api: AppApi, buttonEl?: HTMLButtonElement): Promise<void> {
  // A local model needs seconds to minutes; clicking twice used to abort the
  // first request and report "Generation cancelled." at the reader.
  if (testing || saving) return;
  saving = true;
  const liveButton =
    buttonEl?.isConnected === true
      ? buttonEl
      : (live('endpoint-save-test') as HTMLButtonElement | null);
  if (liveButton) {
    liveButton.disabled = true;
    liveButton.textContent = 'Testing…';
  }
  setStatus('Testing the endpoint…', 'pending');
  const saved = await saveEndpoint(api);
  saving = false;
  if (!saved) {
    if (liveButton) {
      liveButton.disabled = false;
      liveButton.textContent = '✅ Save & test';
    }
    setStatus('', 'none');
    return;
  }
  const endpoint = collectEndpoint();
  const token = api.beginGen();
  const started = performance.now();
  testing = true;
  try {
    const answer = await api.generateText([{ role: 'user', content: 'Reply with exactly: OK' }], {
      model: endpoint.model,
      endpoint,
    });
    if (api.staleGen(token)) return;
    const ms = Math.round(performance.now() - started);
    setStatus(
      `Connected in ${ms} ms — ${endpoint.model} answered “${answer.trim().slice(0, 40)}”. Saved; your books will use it.`,
      'ok',
    );
    api.toast(`Connected to ${endpoint.model} in ${ms} ms.`, 'success');
  } catch (err) {
    // `generateText` already surfaced this error through the app's funnel as a
    // toast — which fades after a few seconds. The status line must not depend
    // on a transient notice: carry the reason itself, or the reader is left
    // with a permanent pointer at a message that is no longer there.
    setStatus(`The endpoint saved, but the test call failed: ${api.genError(err)}`, 'bad');
  } finally {
    testing = false;
    // `api.update` above re-rendered the view, so the captured node is DETACHED
    // by now — mutating it left the visible button stuck on "Testing…"
    // (disabled) until an unrelated re-render happened to rebuild it. Fix the
    // LIVE node instead.
    const fresh = live('endpoint-save-test');
    if (fresh instanceof HTMLButtonElement) {
      fresh.disabled = false;
      fresh.textContent = '✅ Save & test';
    }
    // The plain Save button was built by the re-render that `saveEndpoint`'s
    // update triggered — while `saving` was still true — and nothing
    // re-renders after the test finishes, so it read "Saving…" for the rest of
    // the visit. Reset the LIVE node here, where its sibling is reset.
    const plain = live('endpoint-save');
    if (plain instanceof HTMLButtonElement) plain.textContent = '💾 Save';
    renderEndpointStatusInto(api);
    // The step-3 line has to survive that re-render too.
    if (lastStatus.kind !== 'none') setStatus(lastStatus.text, lastStatus.kind);
  }
}

type StatusKind = 'none' | 'pending' | 'ok' | 'bad';
/** The last thing step 3 said, so a re-render can restore it. */
let lastStatus: { text: string; kind: StatusKind } = { text: '', kind: 'none' };

function applyStatusKind(node: HTMLElement, kind: StatusKind): void {
  node.classList.toggle('status-ok', kind === 'ok');
  node.classList.remove('status-bad', 'status-pending');
  if (kind === 'bad') node.classList.add('status-bad');
  if (kind === 'pending') node.classList.add('status-pending');
}

function setStatus(text: string, kind: StatusKind): void {
  lastStatus = { text, kind };
  const node = live('endpoint-status');
  if (!node) return;
  node.textContent = text;
  applyStatusKind(node, kind);
}

// ---- The sweep -------------------------------------------------------------

/**
 * One button, two sweeps: this machine and, when the app knows which subnet it
 * is on, that whole subnet. They run together and report into the same panel.
 */
async function runScan(api: AppApi, controls: Controls): Promise<void> {
  if (scan.running || lan.running) {
    // Cancel — and it must work from the FIRST moment. The controller used to
    // be created after detection had answered, so the button that says
    // "Scanning…" while promising to be a cancel button was a dead click for
    // the whole first phase of its own scan: a network that answers nothing
    // costs tens of seconds of gateway probing before the subnet sweep (the
    // only part that used to be cancellable) even begins.
    lan.abort?.abort();
    controls.scanButton.textContent = 'Cancelling…';
    return;
  }
  scan.running = true;
  scan.results = [];
  lan.results = [];
  lan.summary = '';
  controls.scanButton.disabled = false;
  controls.scanButton.textContent = 'Scanning…';
  controls.scanButton.classList.remove('btn-primary');
  controls.scanButton.classList.add('btn-danger');
  // Live progress: rows are appended to the ALREADY-ATTACHED results box.
  // (A full api.refresh() here would detach it and hide every row.)
  controls.resultsBox.replaceChildren();
  const lanBox = document.querySelector<HTMLElement>('.lan-results');
  lanBox?.replaceChildren();

  // The cancel controller exists BEFORE detection: it is what "Cancel scan"
  // reaches for, and both phases below have to honour it.
  const signal = new AbortController();
  lan.abort = signal;
  /**
   * Have we LEFT Settings? `box.isConnected` is the wrong question: the shell
   * rebuilds its whole subtree on EVERY render (`mount` → replaceChildren), so
   * moving a font slider or clicking a theme segment — both on this very page —
   * used to look like an unmount and abort the sweep after 500 ms, which then
   * reported itself as a completed "nothing answered" scan.
   */
  const leftSettings = (): boolean => api.view !== 'settings';
  // Watched from the start, not just from the subnet sweep: navigating away
  // during detection or the local probe used to leave both running invisibly.
  const unmountWatch = setInterval(() => {
    if (leftSettings()) signal.abort();
  }, 500);

  // Which network to sweep is not known until detection has answered, and it
  // is swept only when the subnet has answered for itself (or the reader
  // explicitly asked for it — see the sweep button in the network fold).
  await ensureDetection(api).catch(() => undefined);
  const sweepBase = !signal.signal.aborted && canSweep(lan.base) ? lan.base : '';
  lan.running = sweepBase !== '';
  if (lan.running) controls.scanButton.textContent = '✕ Cancel scan';

  /**
   * The subnet sweep runs only AFTER the local sweep has finished.
   *
   * Two reasons, and the second is the important one. First, the servers on
   * this machine are the answer for most readers, and they should not wait ten
   * seconds behind a /24 to be told. Second, a few thousand connect attempts
   * leave Chromium's network service with a backlog that takes seconds to
   * clear, and a request made during that backlog waits behind it. Starting
   * the heavy sweep last keeps the requests the reader actually cares about —
   * the local probe, and the "Save & test" they press right afterwards — out
   * of that queue.
   */
  const appendResult = (result: ProbeResult): void => {
    scan.results.push(result);
    if (leftSettings()) return;
    // A mid-scan re-render (theme/font preview) replaces these boxes — never
    // resurrect a stale node; the completion refresh rebuilds from state.
    const box = resultBoxFor(result, controls.resultsBox);
    const row = resultRow(api, result);
    row.classList.add('scan-row-fresh');
    box.appendChild(row);
    refreshAbsentCount();
  };

  try {
    if (!signal.signal.aborted) {
      await discover(appendResult, undefined, undefined, signal.signal);
    }
    // "Nothing at all answered" is worth one more look before it is reported.
    // A browser that has just done a subnet sweep can still be working through
    // the backlog of abandoned connects, and during that window even
    // 127.0.0.1 refuses to answer — which produced the worst possible message:
    // a confident "no local LLM found" over a server running on this machine.
    // The backlog clears in about a second, so re-probe once.
    if (
      !signal.signal.aborted &&
      !leftSettings() &&
      scan.results.every((result) => result.status === 'absent')
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (!leftSettings() && !signal.signal.aborted) {
        scan.results = [];
        controls.resultsBox.replaceChildren();
        document.querySelector<HTMLElement>('.llm-absent')?.replaceChildren();
        refreshAbsentCount();
        await discover(appendResult, undefined, undefined, signal.signal);
      }
    }
    // Sort and show as soon as the (fast) local sweep is in, rather than
    // waiting for a subnet sweep that may still have ten seconds to run.
    scan.results = sortProbeResults(scan.results);
    api.refresh();
    if (sweepBase && !signal.signal.aborted) {
      await sweepNetwork(api, controls, sweepBase, signal.signal, live('lan-progress'));
    }
  } finally {
    clearInterval(unmountWatch);
  }

  const cancelled = signal.signal.aborted || leftSettings();
  scan.running = false;
  lan.running = false;
  lan.abort = null;
  // Always say how the sweep ended. Leaving the label on its pre-scan
  // placeholder after a sweep that DID find something made the network half of
  // the flow look like it had never run.
  if (sweepBase) {
    if (cancelled) {
      lan.summary =
        lan.results.length > 0
          ? `stopped: ${lan.results.length} server(s) on ${sweepBase}.1–254`
          : `stopped before anything answered on ${sweepBase}.1–254`;
    } else {
      lan.summary =
        lan.results.length > 0
          ? `${lan.results.length} server(s) on ${sweepBase}.1–254`
          : `nothing answered on ${sweepBase}.1–254`;
    }
  } else if (cancelled) {
    // A cancelled local-only scan has no network half to describe; saying
    // "not swept — nothing was seen on X" would read as a verdict on a sweep
    // the reader stopped themselves.
    lan.summary = 'scan stopped';
  } else if (lan.base && !subnetConfirmed) {
    lan.summary = `not swept — nothing was seen on ${lan.base}; use “sweep this network” to try anyway`;
  }

  // Decide the prefill BEFORE re-rendering. A refresh rebuilds the whole view,
  // so nodes captured above are DETACHED the moment it runs — and the draft
  // (`form.*`) is what the fresh controls are seeded from. Writing the prefill
  // after the refresh used to update only the detached node, so the toast said
  // "model prefilled" while the visible field stayed blank.
  const best = bestReachable(scan.results);
  const lanBest = lan.results.find((server) => server.corsOk && server.models.length > 0);
  if (best && !lanBest && !picker.models.length) {
    for (const model of best.models) {
      if (!discoveredModels.includes(model)) discoveredModels.push(model);
    }
    if (!form.model && best.models.length > 0) form.model = pickBestModel(best.models);
    picker.models = rankModels(best.models);
    // Adopt the ADDRESS along with the models: the list is presented as that
    // server's, and a half-adoption (its models, another address in the URL
    // box) is how a bogus (url, model) pair reached Save and broke every later
    // generation.
    picker.forUrl = best.candidate.baseUrl;
    form.url = best.candidate.baseUrl;
    form.vendor = best.candidate.vendor;
  }
  api.refresh();

  if (cancelled) return;
  const found = scan.results.filter((r) => r.status === 'reachable');
  if (found.length > 0 || lan.results.length > 0) {
    const needsKey = [...scan.results, ...lan.results].find(
      (r) =>
        ('candidate' in r ? r.candidate.baseUrl : r.baseUrl) !== undefined &&
        r.status === 'unauthorized',
    );
    api.toast(
      `${found.length} server(s) here${lan.results.length > 0 ? ` · ${lan.results.length} on your network` : ''}` +
        `${needsKey ? ' — one of them wants an API key (Advanced)' : ''}. Press “Use”, then Save & test.`,
      'success',
    );
  } else {
    const blocked = scan.results.find((r) => r.status === 'cors-blocked');
    const wantsKey = scan.results.find((r) => r.status === 'unauthorized');
    api.toast(
      wantsKey
        ? `${wantsKey.candidate.label} answered but wants an API key — add it under Advanced, then Save & test.`
        : blocked
          ? `Nothing fully reachable — ${blocked.candidate.label} answered but CORS-blocked. See the Help note below.`
          : 'No local LLM found. Add a server by address, or start one on this machine.',
      'info',
    );
  }
}

/**
 * Sweep one subnet. Rows land in `.lan-results` (found live, so a mid-scan
 * re-render cannot orphan them) and identifications are awaited before the
 * summary is written.
 */
async function sweepNetwork(
  api: AppApi,
  controls: Controls,
  base: string,
  signal: AbortSignal,
  progress: HTMLElement | null,
): Promise<void> {
  const ports = thoroughSweep ? llmPorts() : commonLlmPorts();
  const maxProbes = 254 * ports.length;
  lan.progressText = `scanning ${base}.1–254 · ${ports.length} ports · up to ${maxProbes} probes…`;
  if (progress)
    progress.textContent = `${lan.results.length} responders while scanning ${base}.1–254…`;
  const leftSettings = (): boolean => api.view !== 'settings';
  /** Identifications still in flight: the summary must wait for them. */
  const pending: Array<Promise<void>> = [];
  const subnetInput = document.querySelector<HTMLInputElement>('#lan-subnet');
  if (subnetInput) subnetInput.value = base;

  await scanLan({
    base,
    ports,
    signal,
    onHit: (hit) => {
      if (leftSettings()) return;
      // Write into whatever box is on screen NOW: a mid-scan re-render
      // replaced the captured one, and that is where the rows belong.
      const box = document.querySelector<HTMLElement>('.lan-results') ?? controls.resultsBox;
      const row = h(
        'div',
        { class: 'scan-row lan-row' },
        spinner(),
        h('span', { class: 'scan-label', text: `http://${hit.host}:${hit.port}` }),
        h('span', { class: 'scan-detail', text: 'identifying…' }),
      );
      box.appendChild(row);
      pending.push(
        identifyLanServer(hit).then((server) => {
          lan.results.push(server);
          // The intermediate refresh in runScan (the early sort of the local
          // results) can detach this row while the model list is still being
          // read. `replaceWith` on a detached node is a silent no-op, which
          // would drop a server we HAD found — so put it back where it lives.
          const fresh = lanServerRow(api, server);
          if (row.isConnected) row.replaceWith(fresh);
          else document.querySelector<HTMLElement>('.lan-results')?.appendChild(fresh);
        }),
      );
    },
    onProgress: (done, total, hits) => {
      // Keep the range, the port count and the probe budget in the live text:
      // the pre-scan "scanning … up to N probes" line is overwritten by the
      // first tick in milliseconds, and a reader watching a thousand requests
      // go by needs the size of the sweep to still be on screen.
      lan.progressText =
        `${base}.1–254 · ${done}/${total} scanned · ${ports.length} ports · ` +
        `${hits.length} responder(s)`;
      // Module state feeds any mid-scan re-render; the captured node is
      // updated while it is still the visible one.
      const line = live('lan-progress');
      if (line) line.textContent = lan.progressText;
      // Leaving Settings used to leave the browser firing up to 254 x 11
      // requests at the subnet for a minute, on battery, with no UI to stop it.
      if (leftSettings()) return;
    },
  });
  // The sweep finishing is NOT the answer arriving: a responder found on one
  // of the last hosts (or one whose model-list probe still needs its 1.8 s
  // timeout) is identified after `scanLan` resolves. Reading `lan.results`
  // immediately declared "nothing answered" over a server that HAD answered —
  // and the api.refresh() in runScan then detached the row it would render into.
  await Promise.allSettled(pending);
  lan.progressText = `${lan.results.length} responder(s) on ${base}.1–254`;
  const line = live('lan-progress');
  if (line) line.textContent = lan.progressText;
}

/**
 * Drop the API key when the base URL's origin changes. The key is a secret
 * scoped to one host; keeping it while switching hosts leaks it on the next
 * request. Called by every "adopt this endpoint" path.
 */
function clearKeyIfHostChanged(nextBaseUrl: string): void {
  if (form.apiKey.trim().length === 0) return;
  if (originOf(form.url) === originOf(nextBaseUrl)) return;
  form.apiKey = '';
  form.keyOrigin = '';
  const input = document.querySelector<HTMLInputElement>(
    'input[type="password"].input, .key-input',
  );
  if (input) input.value = '';
  api_toast_key_cleared?.();
}

/** Set once per render so the helper can report what it did. */
let api_toast_key_cleared: (() => void) | null = null;

function originOf(url: string): string {
  const cleaned = normalizeBaseUrl(url);
  if (cleaned.length === 0) return '';
  // Assume http:// when no scheme is present, BEFORE handing the string to
  // `new URL`. Without it, `new URL('localhost:1234')` parses "localhost" as a
  // non-special SCHEME and reports `.origin === 'null'` — so every scheme-less
  // hostname shared one origin and the API key travelled to another machine.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) ? cleaned : `http://${cleaned}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    // Still unparsable (mid-typing): compare hosts by hand.
    const host = cleaned.split('/')[0] ?? cleaned;
    return host.toLowerCase();
  }
}

/** "Ollama (native /api/chat)" instead of "Ollama (Ollama (native))". */
function vendorNote(candidate: EndpointCandidate): string {
  if (candidate.vendor === 'ollama' && /ollama/i.test(candidate.label)) {
    return ' (native /api/chat)';
  }
  return ` (${vendorName(candidate.vendor)})`;
}

/** Probe whatever the user typed in the Base URL field, as a one-off candidate. */
async function probeCustom(api: AppApi, controls: Controls): Promise<void> {
  const baseUrl = normalizeBaseUrl(form.url);
  if (!/^https?:\/\/[^/]+/i.test(baseUrl)) {
    api.toast(
      'Type a full URL first, e.g. http://127.0.0.1:1234 or http://192.168.1.50:8080/v1',
      'error',
    );
    return;
  }
  const candidate: EndpointCandidate = {
    id: 'custom',
    label: form.name.trim() || 'Custom endpoint',
    baseUrl,
    vendor: form.vendor,
    note: '',
  };
  const box = document.querySelector<HTMLElement>('.llm-results') ?? controls.resultsBox;
  const row = h(
    'div',
    { class: 'scan-row' },
    h('span', { class: 'badge', text: '… probing' }),
    h('span', { class: 'scan-label', text: baseUrl }),
  );
  box.prepend(row);
  const result = await probeCandidate(candidate);
  // Record the verdict and re-render from STATE instead of only patching the
  // row captured at click time: an appearance change in the meantime rebuilds
  // the whole view, and `replaceWith` on a detached node is a silent no-op —
  // the probe's answer vanished with no trace.
  scan.results = [
    ...scan.results.filter((r) => r.candidate.baseUrl !== result.candidate.baseUrl),
    result,
  ];
  if (result.status === 'reachable') {
    for (const model of result.models) {
      if (!discoveredModels.includes(model)) discoveredModels.push(model);
    }
    // A hand-typed address is a deliberate choice: adopt it, load its models
    // and pre-select the best one — the same outcome a discovery click gives.
    selectServer(api, {
      label: candidate.label,
      baseUrl,
      vendor: form.vendor,
      models: result.models,
      origin: baseUrl,
    });
    // And show the verdict: `selectServer` only patches the picker and the
    // status strip, so without this the panel kept the "… probing" row it was
    // given while the request was in flight — a hung request where the record
    // of what answered should be, with no "Use" button for the server the
    // reader had just proved works.
    api.refresh();
    return;
  }
  api.refresh();
  api.toast(`${baseUrl} — ${result.detail}`, 'info');
}

/**
 * The endpoint exactly as typed in the form — the ONE source of truth for
 * both Save and Test connection. Generation always reads the saved settings,
 * so a test must never be able to pass against values the app won't use.
 */
function collectEndpoint(): EndpointSettings {
  return {
    name: form.name.trim() || 'Local LLM',
    baseUrl: normalizeBaseUrl(form.url),
    vendor: form.vendor,
    model: form.model.trim(),
    temperature: Number.isFinite(form.temperature)
      ? Math.min(2, Math.max(0, form.temperature))
      : 0.9,
    apiKey: form.apiKey.trim(),
  };
}

async function persist(api: AppApi): Promise<void> {
  const granted = await requestPersistence();
  api.toast(
    granted
      ? 'Persistent storage granted — the browser will not evict your books.'
      : 'Not granted; data still persists during normal use. Export for safety.',
    granted ? 'success' : 'info',
  );
}

async function fillStorageLine(line: HTMLElement): Promise<void> {
  const estimate = await estimateStorage();
  if (!estimate) {
    line.textContent = 'storage estimate unavailable';
    return;
  }
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  line.textContent = `${mb(estimate.usage)} used of ${mb(estimate.quota)} available`;
}

async function exportAll(api: AppApi): Promise<void> {
  try {
    const outcome = await exportLibraryFile(api.lib);
    if (outcome === 'saved') {
      api.markExported();
      api.toast(
        'Library exported — book content only; your API key stays on this machine.',
        'success',
      );
    } else if (outcome === 'download-attempted') {
      api.markExported();
      api.toast('Library exported — download started; check your Downloads folder.', 'info');
    }
  } catch (err) {
    api.toast(err instanceof Error ? err.message : 'Export failed', 'error');
  }
}

async function importAll(api: AppApi): Promise<void> {
  try {
    const payload = await readImportFile();
    if (payload === null) return;
    await api.importDropped(payload);
  } catch (err) {
    api.toast(err instanceof Error ? err.message : 'Import failed', 'error');
  }
}

async function wipe(api: AppApi): Promise<void> {
  try {
    audit('wipe library');
    await clearLibrary();
    // The OPFS workspace is a second copy of the same data; leaving it behind
    // made "delete every book, every page, every decision" untrue.
    await clearOpfsLibrary();
    api.update(() => defaultLibrary());
    api.navigate('library');
    api.toast('Library wiped', 'info');
  } catch (err) {
    api.toast(err instanceof Error ? err.message : 'Wipe failed', 'error');
  }
}

function segmentedTheme(
  value: 'dark' | 'sepia' | 'light' | 'system',
  onChange: (value: 'dark' | 'sepia' | 'light' | 'system') => void,
): HTMLElement {
  const group = h(
    'div',
    { class: 'segmented' },
    ...[
      ['dark', 'dark'],
      ['sepia', 'sepia'],
      ['light', 'light'],
      ['system', 'system'],
    ].map(([v, label]) =>
      h('button', {
        class: `seg${v === value ? ' seg-on' : ''}`,
        type: 'button',
        text: label,
        onclick: () => {
          onChange(v as 'dark' | 'sepia' | 'light' | 'system');
          for (const seg of Array.from(group.querySelectorAll('.seg'))) {
            seg.classList.toggle('seg-on', seg.textContent === label);
          }
        },
      }),
    ),
  );
  return group;
}

function collectWardrobe(
  controls: HTMLElement,
): Record<
  'story' | 'letter' | 'diary' | 'newspaper' | 'mapnote' | 'recipe',
  'auto' | 'georgia' | 'palatino' | 'charter' | 'serif' | 'sans'
> {
  const out = {
    story: 'auto',
    letter: 'auto',
    diary: 'auto',
    newspaper: 'auto',
    mapnote: 'auto',
    recipe: 'auto',
  } as Record<
    'story' | 'letter' | 'diary' | 'newspaper' | 'mapnote' | 'recipe',
    'auto' | 'georgia' | 'palatino' | 'charter' | 'serif' | 'sans'
  >;
  for (const select of Array.from(
    controls.querySelectorAll<HTMLSelectElement>('.wardrobe-select'),
  )) {
    const format = select.dataset.format;
    if (format && format in out) {
      (out as Record<string, string>)[format] = select.value;
    }
  }
  return out;
}
