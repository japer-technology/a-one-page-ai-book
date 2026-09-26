/**
 * ui/views/settings.ts — find your local LLM, tune it, and manage local files.
 *
 * Discovery probes the well-known local inference ports (LM Studio, Ollama,
 * llama.cpp, …). Reachable = we can list its models. CORS-blocked = a server
 * answered but refused this page's origin (actionable help included).
 *
 * Manual entry is first-class: any base URL (host + port + optional path),
 * either protocol, any model name, and an optional API key sent as a bearer
 * token only to this endpoint.
 */
import type { AppApi } from '../ctx';
import { button, field, h, spinner } from '../dom';
import { audit } from '../audit';
import {
  CANDIDATES,
  llmPorts,
  normalizeBaseUrl,
  presetBaseUrls,
  vendorName,
} from '../../llm/endpoints';
import type { EndpointCandidate } from '../../llm/endpoints';
import { bestReachable, discover, probeCandidate } from '../../llm/probe';
import type { ProbeResult } from '../../llm/probe';
import {
  commonSubnets,
  detectLocalIp,
  identifyLanServer,
  normalizeSubnetBase,
  scanLan,
  subnetBaseOf,
} from '../../llm/lan';
import type { LanServer } from '../../llm/lan';
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
import type { EndpointSettings, EndpointVendor } from '../../core/types';

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
let lanDetected = false;
/** True while a connection test is in flight (prevents double-firing a model call). */
let testing = false;

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
  modelInput: HTMLInputElement;
  keyInput: HTMLInputElement;
  tempInput: HTMLInputElement;
  resultsBox: HTMLElement;
  scanButton: HTMLButtonElement;
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
  }

  const nameInput = h('input', {
    class: 'input',
    type: 'text',
    value: form.name,
    oninput: (event: Event) => {
      form.name = (event.target as HTMLInputElement).value;
    },
  });
  const urlInput = h('input', {
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
        keyInput.value = '';
        form.keyOrigin = '';
        api.toast('API key cleared — it belonged to the previous endpoint.', 'info');
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

  const modelDatalist = h(
    'datalist',
    { id: 'discovered-models' },
    ...[...new Set([...discoveredModels, form.model])]
      .filter((m) => m.length > 0)
      .map((m) => h('option', { value: m })),
  );
  const modelInput = h('input', {
    class: 'input',
    type: 'text',
    list: 'discovered-models',
    value: form.model,
    placeholder: 'e.g. qwen2.5-7b-instruct',
    spellcheck: false,
    oninput: (event: Event) => {
      form.model = (event.target as HTMLInputElement).value;
    },
  });

  const keyInput = h('input', {
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

  const resultsBox = h('div', { class: 'scan-results' });
  const controls: Controls = {
    nameInput,
    urlInput,
    vendorInput,
    modelInput,
    keyInput,
    tempInput,
    resultsBox,
    scanButton: undefined as unknown as HTMLButtonElement,
  };
  const scanButton = button(
    scan.running ? 'Scanning…' : '🔍 Scan for local LLMs',
    () => void runScan(api, controls),
    'primary',
    { disabled: scan.running },
  );
  controls.scanButton = scanButton;
  for (const result of scan.results) resultsBox.appendChild(resultRow(api, result, controls));

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

  const persistButton = button('Request persistent storage', () => void persist(api));
  const storageLine = h('span', { class: 'field-hint', text: 'checking…' });
  void fillStorageLine(storageLine);

  const save = () => {
    const endpoint = collectEndpoint();
    // An empty base URL used to be saved happily: "Settings saved", and then
    // `chat()` fetched the app's OWN origin (`/v1/chat/completions`) until the
    // next load, when the schema quietly replaced the empty URL with the
    // default — the configured endpoint changing without the reader touching
    // anything. Probe this URL already refuses the same input.
    if (!/^https?:\/\/[^/]+/i.test(endpoint.baseUrl)) {
      api.toast(
        'Type the server’s full URL first, e.g. http://127.0.0.1:1234 — “Settings saved” would have stored an endpoint that cannot work.',
        'error',
      );
      controls.urlInput.focus();
      return;
    }
    if (endpoint.model) {
      discoveredModels.push(endpoint.model);
      refreshModelDatalist(modelInput);
    }
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
        theme: themeValue,
        readingFont: readingFontSelect.value as
          'georgia' | 'palatino' | 'charter' | 'serif' | 'sans',
        documentFonts: collectWardrobe(wardrobeControls),
        fontScale: Number(fontScaleInput.value),
      },
    }));
    api.toast('Settings saved', 'success');
  };

  // ---- LAN scan controls ---------------------------------------------------
  const lanSubnetInput = h('input', {
    id: 'lan-subnet',
    class: 'input lan-subnet',
    type: 'text',
    value: lan.base,
    placeholder: 'e.g. 192.168.1',
    spellcheck: false,
    oninput: (event: Event) => {
      lan.base = (event.target as HTMLInputElement).value;
    },
  });
  const lanChips = h(
    'div',
    { class: 'row gap' },
    ...commonSubnets().map((subnet) =>
      button(
        subnet,
        () => {
          lan.base = subnet;
          lanSubnetInput.value = subnet;
        },
        'chip',
      ),
    ),
  );
  const lanProgress = h('span', {
    class: 'field-hint',
    text: lan.running
      ? lan.progressText || `scanning ${lan.base}.1–254 on ${llmPorts().length} ports…`
      : lan.summary ||
        (lan.base
          ? `subnet: ${lan.base}.1–254`
          : 'auto-detects your subnet where the browser allows it'),
  });
  // The `lan-results` class is what lets a still-running sweep find the box
  // that a mid-scan re-render put on screen (see runLanScan).
  const lanResultsBox = h('div', { class: 'scan-results lan-results' });
  const lanButton = button(
    lan.running ? 'Cancel scan' : '🌐 Scan local network',
    () => void runLanScan(api, controls, lanSubnetInput, lanResultsBox, lanButton, lanProgress),
    lan.running ? 'danger' : 'primary',
  );
  for (const server of lan.results) lanResultsBox.appendChild(lanServerRow(api, server, controls));

  if (!lanDetected) {
    lanDetected = true;
    void detectLocalIp(1200).then((ip) => {
      if (ip && !lan.base) {
        lan.base = subnetBaseOf(ip);
        // The input is seeded from `lan.base` on every render, and the nodes
        // captured here belong to the render that STARTED the detection (it
        // resolves ~1.2 s later, after any theme/font preview has rebuilt the
        // view). Writing to them left the visible field blank while the subnet
        // was set behind the scenes — so re-render and let the seed do it.
        api.refresh();
      }
    });
  }

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
      { class: 'card' },
      h('h2', { text: 'Local LLM' }),
      h(
        'div',
        { class: 'row gap' },
        scanButton,
        h('p', {
          class: 'field-hint',
          text: `Probes ${CANDIDATES.length} well-known local endpoints (ports 1234, 11434, 8080, 5000, …)`,
        }),
      ),
      resultsBox,
      field('Name', nameInput, 'Any label you like.'),
      field(
        'Base URL',
        urlInput,
        'Manual entry is fine: any host:port — e.g. http://192.168.1.50:1234 — with or without /v1, optional path prefix.',
      ),
      h(
        'div',
        { class: 'row gap' },
        button('🔍 Probe this URL', () => void probeCustom(api, controls), 'ghost', {
          title: 'Test the typed URL and list its models',
        }),
        h('p', {
          class: 'field-hint',
          text: 'A server on another machine? Type its LAN address and probe it here.',
        }),
      ),
      field(
        'Protocol',
        vendorInput,
        'Ollama = native /api/chat · OpenAI-compatible = /v1/chat/completions',
      ),
      field('Model', modelInput, modelDatalist),
      field(
        'API key (optional)',
        h('div', { class: 'row gap' }, keyInput, revealKey),
        'Sent as “Authorization: Bearer …” only to this endpoint. Most local servers need no key.',
      ),
      field('Temperature', h('div', { class: 'row gap' }, tempInput, tempLabel)),
      h(
        'div',
        { class: 'row gap' },
        button('💾 Save', save, 'primary'),
        (() => {
          const test = button(
            testing ? 'Testing…' : 'Test connection',
            () => void testConnection(api, controls, test),
            'ghost',
            { disabled: testing },
          );
          test.id = 'test-endpoint';
          return test;
        })(),
      ),
    ),

    h(
      'section',
      { class: 'card' },
      h('h2', { text: 'Local network (LAN)' }),
      h('p', {
        class: 'field-hint',
        text: 'Scan nearby computers: probes every address in a subnet (…1–254) across the 11 known LLM ports — up to ~2 800 quick probes — then identifies whatever answers. It is one bounded sweep you can cancel at any time; almost every probe is expected to find nothing. The server must listen on the LAN interface (LM Studio: “Serve on Local Network”; Ollama: OLLAMA_HOST=0.0.0.0) and the same CORS rules apply.',
      }),
      h('div', { class: 'row gap' }, lanSubnetInput, lanChips),
      h('div', { class: 'row gap' }, lanButton, lanProgress),
      lanResultsBox,
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
      field(
        'Fast model (optional)',
        fastModelInput,
        'Used for the cheap phases — titles, chat, suggested beats, endings, the cast and the story summary. Leave empty to use the main model for everything.',
      ),
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

function resultRow(api: AppApi, result: ProbeResult, controls: Controls): HTMLElement {
  const status =
    result.status === 'reachable'
      ? h('span', { class: 'badge badge-ok', text: '✓ reachable' })
      : result.status === 'cors-blocked'
        ? h('span', { class: 'badge badge-warn', text: 'CORS-blocked' })
        : result.status === 'unauthorized'
          ? h('span', { class: 'badge badge-warn', text: '🔑 needs key' })
          : h('span', { class: 'badge badge-off', text: 'not found' });

  const use = () => {
    // A key belongs to the host it was entered for. Carrying it across made
    // every later request send `Authorization: Bearer <secret>` to a machine
    // the reader never gave it to — directly contradicting the field's own
    // promise ("sent only to this endpoint").
    clearKeyIfHostChanged(result.candidate.baseUrl);
    form.name = result.candidate.label;
    form.url = result.candidate.baseUrl;
    form.vendor = result.candidate.vendor;
    controls.nameInput.value = result.candidate.label;
    controls.urlInput.value = result.candidate.baseUrl;
    controls.vendorInput.value = result.candidate.vendor;
    for (const model of result.models) {
      if (!discoveredModels.includes(model)) discoveredModels.push(model);
    }
    // Adopting an endpoint adopts its default model — replace any stale name.
    if (result.models.length > 0) {
      form.model = result.models[0] ?? '';
      controls.modelInput.value = form.model;
    }
    refreshModelDatalist(controls.modelInput);
    api.toast(
      `Using ${result.candidate.label}${vendorNote(result.candidate)}. Press Save to keep it.`,
      'success',
    );
  };

  return h(
    'div',
    { class: 'scan-row' },
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
    result.status === 'reachable' && result.models.length > 0 ? button('Use', use, 'chip') : null,
  );
}

async function runScan(api: AppApi, controls: Controls): Promise<void> {
  scan.running = true;
  scan.results = [];
  controls.scanButton.disabled = true;
  controls.scanButton.textContent = 'Scanning…';
  // Live progress: rows are appended to the ALREADY-ATTACHED results box.
  // (A full api.refresh() here would detach it and hide every row.)
  controls.resultsBox.replaceChildren();
  await discover((result) => {
    scan.results.push(result);
    // An appearance preview (theme/font/scale) can re-render the view
    // mid-scan and detach this box — never resurrect a stale node; the
    // completion refresh below rebuilds everything from scan.results.
    if (!controls.resultsBox.isConnected) return;
    const row = resultRow(api, result, controls);
    row.classList.add('scan-row-fresh');
    controls.resultsBox.appendChild(row);
  });
  scan.running = false;
  // Decide the prefill BEFORE re-rendering. A refresh rebuilds the whole view,
  // so `controls.modelInput` becomes a detached node the moment it runs — and
  // the draft (`form.model`) is what the fresh input is seeded from. Writing
  // the prefill after the refresh used to update only the detached node, so
  // the toast said "model prefilled" while the visible field stayed blank and
  // the next Save stored an empty model name.
  const best = bestReachable(scan.results);
  if (best) {
    for (const model of best.models) {
      if (!discoveredModels.includes(model)) discoveredModels.push(model);
    }
    if (!form.model && best.models.length > 0) form.model = best.models[0] ?? '';
  }
  api.refresh();

  if (best) {
    if (best.models.length > 0) {
      api.toast(`${best.candidate.label} found — model prefilled. Press Save.`, 'success');
    } else {
      api.toast(
        `${best.candidate.label} is reachable but lists no models — type the model name and Save.`,
        'info',
      );
    }
  } else {
    const blocked = scan.results.find((r) => r.status === 'cors-blocked');
    const wantsKey = scan.results.find((r) => r.status === 'unauthorized');
    api.toast(
      wantsKey
        ? `${wantsKey.candidate.label} answered but wants an API key — type the key in Settings and Save.`
        : blocked
          ? `Nothing fully reachable — ${blocked.candidate.label} answered but CORS-blocked. See the Help note below.`
          : 'No local LLM found. Type a base URL manually and press “Probe this URL”.',
      'info',
    );
  }
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
    label: 'Custom endpoint',
    baseUrl,
    vendor: form.vendor,
    note: '',
  };
  const row = h(
    'div',
    { class: 'scan-row' },
    h('span', { class: 'badge', text: '… probing' }),
    h('span', { class: 'scan-label', text: baseUrl }),
  );
  controls.resultsBox.prepend(row);
  const result = await probeCandidate(candidate);
  // Record the verdict and re-render from STATE instead of only patching the
  // row captured at click time: an appearance change in the meantime rebuilds
  // the whole view, and `replaceWith` on a detached node is a silent no-op —
  // the probe's answer vanished with no trace.
  scan.results = [
    ...scan.results.filter((r) => r.candidate.baseUrl !== result.candidate.baseUrl),
    result,
  ];
  row.replaceWith(resultRow(api, result, controls));
  api.refresh();
  if (result.status === 'reachable') {
    for (const model of result.models) {
      if (!discoveredModels.includes(model)) discoveredModels.push(model);
    }
    if (!form.model && result.models.length > 0) {
      form.model = result.models[0] ?? '';
      controls.modelInput.value = form.model;
    }
    refreshModelDatalist(controls.modelInput);
  }
}

async function runLanScan(
  api: AppApi,
  controls: Controls,
  subnetInput: HTMLInputElement,
  box: HTMLElement,
  _btn: HTMLButtonElement,
  progress: HTMLElement,
): Promise<void> {
  if (lan.running) {
    lan.abort?.abort();
    return;
  }
  const base = normalizeSubnetBase(subnetInput.value || lan.base);
  if (!base) {
    api.toast('Enter a subnet first — e.g. 192.168.1', 'error');
    return;
  }
  lan.running = true;
  lan.base = base;
  lan.summary = '';
  // Say how big this is BEFORE it starts. A sweep is up to 254 hosts x 11 known
  // LLM ports, i.e. ~2 800 short no-cors probes; a reader watching the network
  // panel see the count race past a thousand and reasonably concludes the app
  // has lost control. It has not — it is one bounded, cancellable sweep.
  const ports = llmPorts();
  const maxProbes = 254 * ports.length;
  lan.progressText = `scanning ${base}.1–254 · ${ports.length} ports · up to ${maxProbes} probes…`;
  // Update the LIVE nodes here (a refresh at this moment would detach the
  // results box that the rows are appended to, killing the scan). Module state
  // carries the labels for any re-render that happens mid-scan.
  _btn.textContent = 'Cancel scan';
  _btn.classList.add('btn-danger');
  _btn.classList.remove('btn-primary');
  progress.textContent = lan.progressText;
  /**
   * Have we LEFT Settings? `box.isConnected` is the wrong question: the shell
   * rebuilds its whole subtree on EVERY render (`mount` → replaceChildren), so
   * moving a font slider or clicking a theme segment — both on this very page —
   * used to look like an unmount and abort the sweep after 500 ms, which then
   * reported itself as a completed "nothing answered" scan.
   */
  const leftSettings = (): boolean => api.view !== 'settings';
  const unmountWatch = setInterval(() => {
    if (leftSettings()) lan.abort?.abort();
  }, 500);
  const signal = new AbortController();
  lan.abort = signal;
  /** Identifications still in flight: the summary must wait for them. */
  const pending: Array<Promise<void>> = [];
  try {
    subnetInput.value = base;
    lan.results = [];
    box.replaceChildren();

    await scanLan({
      base,
      ports,
      signal: signal.signal,
      onHit: (hit) => {
        if (leftSettings()) {
          signal.abort();
          return;
        }
        // Write into whatever box is on screen NOW: a mid-scan re-render
        // replaced the captured one, and that is where the rows belong.
        const live = document.querySelector<HTMLElement>('.lan-results') ?? box;
        const row = h(
          'div',
          { class: 'scan-row lan-row' },
          spinner(),
          h('span', { class: 'scan-label', text: `http://${hit.host}:${hit.port}` }),
          h('span', { class: 'scan-detail', text: 'identifying…' }),
        );
        live.appendChild(row);
        pending.push(
          identifyLanServer(hit).then((server) => {
            lan.results.push(server);
            row.replaceWith(lanServerRow(api, server, controls));
            if (!lan.running) {
              progress.textContent = `${lan.results.length} responder(s) on ${base}.1–254`;
            }
          }),
        );
      },
      onProgress: (done, total, hits) => {
        // Module state feeds any mid-scan re-render; the captured node is
        // updated while it is still the visible one.
        lan.progressText = `scanned ${done}/${total} hosts · ${hits.length} responder(s)`;
        if (progress.isConnected) progress.textContent = lan.progressText;
        // Leaving Settings used to leave the browser firing up to 254 x 11
        // requests at the subnet for a minute, on battery, with no UI to stop it.
        if (leftSettings()) signal.abort();
      },
    });
    // The sweep finishing is NOT the answer arriving: a responder found on one
    // of the last hosts (or one whose model-list probe still needs its 1.8 s
    // timeout) is identified after `scanLan` resolves. Reading `lan.results`
    // immediately declared "nothing answered" over a server that HAD answered
    // — and the api.refresh() below then detached the row it would have
    // rendered into.
    await Promise.allSettled(pending);
  } finally {
    clearInterval(unmountWatch);
  }
  lan.running = false;
  lan.abort = null;
  const cancelled = signal.signal.aborted || leftSettings();
  if (cancelled) {
    lan.summary =
      lan.results.length > 0
        ? `stopped: ${lan.results.length} responder(s) on ${base}.1–254`
        : `stopped before anything answered on ${base}.1–254`;
  } else {
    lan.summary =
      lan.results.length > 0
        ? `done: ${lan.results.length} responder(s) on ${base}.1–254`
        : `done: nothing answered on ${base}.1–254`;
  }
  // Re-render instead of writing to captured nodes: any mid-scan re-render
  // (theme/font change) replaced them, and a stale "Cancel scan" button then
  // STARTED a new sweep when clicked.
  api.refresh();
  // A cancelled sweep must never be reported as a diagnosis: "no LLM servers
  // found, check the firewall" is a confident, wrong answer to "I stopped you".
  if (!cancelled && lan.results.length === 0) {
    api.toast(
      `No LLM servers found on ${base}.1–254. The server must listen on the LAN interface (0.0.0.0) and pass the firewall.`,
      'info',
    );
  }
}

function lanServerRow(api: AppApi, server: LanServer, controls: Controls): HTMLElement {
  const status =
    server.status === 'reachable'
      ? h('span', { class: 'badge badge-ok', text: '✓ reachable' })
      : server.status === 'unauthorized'
        ? h('span', { class: 'badge badge-warn', text: '🔑 needs key' })
        : h('span', { class: 'badge badge-warn', text: 'CORS-blocked' });

  const use = () => {
    clearKeyIfHostChanged(server.baseUrl);
    form.name = `LAN · ${server.host}`;
    form.url = server.baseUrl;
    form.vendor = server.vendor;
    controls.nameInput.value = `LAN · ${server.host}`;
    controls.urlInput.value = server.baseUrl;
    controls.vendorInput.value = server.vendor;
    for (const model of server.models) {
      if (!discoveredModels.includes(model)) discoveredModels.push(model);
    }
    if (server.models.length > 0) {
      form.model = server.models[0] ?? '';
      controls.modelInput.value = form.model;
    }
    refreshModelDatalist(controls.modelInput);
    api.toast(`Using LAN server ${server.baseUrl}. Press Save to keep it.`, 'success');
  };

  return h(
    'div',
    { class: 'scan-row lan-row' },
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

function refreshModelDatalist(modelInput: HTMLInputElement): void {
  const list = document.getElementById('discovered-models');
  if (!list) return;
  // `modelInput` may have been detached by an intervening refresh — fall back
  // to the draft, which is the value the live input is seeded from anyway.
  const current = modelInput.isConnected ? modelInput.value : form.model;
  const options = [...new Set([...discoveredModels, current])]
    .filter((m) => m.length > 0)
    .map((m) => h('option', { value: m }));
  list.replaceChildren(...options);
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

async function testConnection(
  api: AppApi,
  controls: Controls,
  buttonEl?: HTMLButtonElement,
): Promise<void> {
  // A local model needs seconds to minutes; clicking twice used to abort the
  // first request and report "Generation cancelled." at the reader.
  if (testing) return;
  testing = true;
  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = 'Testing…';
  }
  const token = api.beginGen();
  // Persist the form FIRST, then test the SAVED endpoint — "Connected" must
  // mean the endpoint every future generation (titles, pages) will actually
  // use, not some unsaved copy of it. The WHOLE draft is persisted (not just
  // the endpoint): replacing only the endpoint object would trip the draft
  // re-seed guard on the next render and silently wipe the reader's unsaved
  // edits to the other fields.
  const endpoint = collectEndpoint();
  if (endpoint.model) {
    discoveredModels.push(endpoint.model);
    refreshModelDatalist(controls.modelInput);
  }
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
    },
  }));
  api.toast('Testing…', 'info');
  const started = performance.now();
  try {
    const answer = await api.generateText([{ role: 'user', content: 'Reply with exactly: OK' }], {
      model: endpoint.model,
      endpoint,
    });
    if (api.staleGen(token)) return;
    const ms = Math.round(performance.now() - started);
    api.toast(
      `Connected in ${ms} ms — the model said “${answer.trim().slice(0, 40)}”. Endpoint saved; your books will use it.`,
      'success',
    );
  } catch {
    // `generateText` already surfaced this error through the app's funnel;
    // toasting again stacked an identical red notice.
  } finally {
    testing = false;
    // `api.update` above re-rendered the view, so the captured node is DETACHED
    // by now — mutating it left the visible button stuck on "Testing…"
    // (disabled) until an unrelated re-render happened to rebuild it. Fix the
    // LIVE node instead.
    const live =
      buttonEl?.isConnected === true ? buttonEl : document.getElementById('test-endpoint');
    if (live instanceof HTMLButtonElement) {
      live.disabled = false;
      live.textContent = 'Test connection';
    }
  }
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
