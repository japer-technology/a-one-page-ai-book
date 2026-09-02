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
import { button, field, h } from '../dom';
import { CANDIDATES, normalizeBaseUrl, presetBaseUrls, vendorName } from '../../llm/endpoints';
import type { EndpointCandidate } from '../../llm/endpoints';
import { bestReachable, discover, probeCandidate } from '../../llm/probe';
import type { ProbeResult } from '../../llm/probe';
import { clearLibrary, estimateStorage, requestPersistence } from '../../store/db';
import { exportLibraryFile, hasFilePicker, hasOpfs, importLibraryFile } from '../../store/files';
import { defaultLibrary } from '../../core/schema';
import type { EndpointSettings, EndpointVendor } from '../../core/types';

// Session view state.
const scan = { running: false, results: [] as ProbeResult[] };
const discoveredModels: string[] = [];

interface Controls {
  nameInput: HTMLInputElement;
  urlInput: HTMLInputElement;
  vendorInput: HTMLSelectElement;
  modelInput: HTMLInputElement;
  keyInput: HTMLInputElement;
  resultsBox: HTMLElement;
  scanButton: HTMLButtonElement;
}

export function renderSettings(api: AppApi): HTMLElement {
  const endpoint = api.lib.settings.endpoint;

  const nameInput = h('input', { class: 'input', type: 'text', value: endpoint.name });
  const urlInput = h('input', {
    class: 'input',
    type: 'text',
    list: 'endpoint-presets',
    value: endpoint.baseUrl,
    placeholder: 'http://127.0.0.1:1234',
    spellcheck: false,
  });
  const urlPresets = h(
    'datalist',
    { id: 'endpoint-presets' },
    ...presetBaseUrls().map((p) => h('option', { value: p.url, label: p.label })),
  );
  const vendorInput = h(
    'select',
    { class: 'input' },
    h('option', {
      value: 'openai-compat',
      selected: endpoint.vendor === 'openai-compat' ? true : undefined,
      text: 'OpenAI-compatible (/v1/chat/completions)',
    }),
    h('option', {
      value: 'ollama',
      selected: endpoint.vendor === 'ollama' ? true : undefined,
      text: 'Ollama (native /api/chat)',
    }),
  );

  const modelDatalist = h(
    'datalist',
    { id: 'discovered-models' },
    ...[...new Set([...discoveredModels, endpoint.model])]
      .filter((m) => m.length > 0)
      .map((m) => h('option', { value: m })),
  );
  const modelInput = h('input', {
    class: 'input',
    type: 'text',
    list: 'discovered-models',
    value: endpoint.model,
    placeholder: 'e.g. qwen2.5-7b-instruct',
    spellcheck: false,
  });

  const keyInput = h('input', {
    class: 'input',
    type: 'password',
    value: endpoint.apiKey,
    placeholder: 'optional — only needed if your server requires a key',
    autocomplete: 'off',
    spellcheck: false,
  });
  const revealKey = button(
    '👁 Show',
    () => {
      keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    },
    'chip',
  );

  const tempInput = h('input', {
    class: 'input',
    type: 'range',
    min: '0',
    max: '2',
    step: '0.1',
    value: String(endpoint.temperature),
    oninput: () => {
      tempLabel.textContent = `temperature: ${Number(tempInput.value).toFixed(1)}`;
    },
  });
  const tempLabel = h('span', {
    class: 'field-hint',
    text: `temperature: ${Number(endpoint.temperature).toFixed(1)}`,
  });

  const resultsBox = h('div', { class: 'scan-results' });
  const controls: Controls = {
    nameInput,
    urlInput,
    vendorInput,
    modelInput,
    keyInput,
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
    { class: 'input' },
    ...(['shorter', 'standard', 'longer'] as const).map((v) =>
      h('option', {
        value: v,
        selected: v === api.lib.settings.defaultLength ? true : undefined,
        text: v,
      }),
    ),
  );

  const persistButton = button('Request persistent storage', () => void persist(api));
  const storageLine = h('span', { class: 'field-hint', text: 'checking…' });
  void fillStorageLine(storageLine);

  const save = () => {
    const baseUrl = normalizeBaseUrl(urlInput.value);
    const model = modelInput.value.trim();
    if (model) {
      discoveredModels.push(model);
      refreshModelDatalist(modelInput);
    }
    api.update((lib) => ({
      ...lib,
      settings: {
        ...lib.settings,
        endpoint: {
          name: nameInput.value.trim() || 'Local LLM',
          baseUrl,
          vendor: vendorInput.value as EndpointVendor,
          model,
          temperature: Number(tempInput.value),
          apiKey: keyInput.value.trim(),
        },
        defaultLength: defaultLength.value as 'shorter' | 'standard' | 'longer',
      },
    }));
    api.toast('Settings saved', 'success');
  };

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
        button('Test connection', () => void testConnection(api, controls)),
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
      h('p', {
        class: 'field-hint',
        text: `File System Access pickers: ${hasFilePicker() ? 'supported' : 'not supported — downloads used instead'} · OPFS workspace: ${hasOpfs() ? 'supported' : 'not supported'}`,
      }),
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
        : h('span', { class: 'badge badge-off', text: 'not found' });

  const use = () => {
    controls.nameInput.value = result.candidate.label;
    controls.urlInput.value = result.candidate.baseUrl;
    controls.vendorInput.value = result.candidate.vendor;
    for (const model of result.models) {
      if (!discoveredModels.includes(model)) discoveredModels.push(model);
    }
    // Adopting an endpoint adopts its default model — replace any stale name.
    if (result.models.length > 0) controls.modelInput.value = result.models[0] ?? '';
    refreshModelDatalist(controls.modelInput);
    api.toast(
      `Using ${result.candidate.label} (${vendorName(result.candidate.vendor)}). Press Save to keep it.`,
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
    result.status === 'reachable'
      ? h('span', {
          class: 'scan-detail',
          text: `${result.models.length} model(s) · ${result.latencyMs ?? '?'} ms`,
        })
      : h('span', { class: 'scan-detail', text: result.detail }),
    result.status === 'reachable' ? button('Use', use, 'chip') : null,
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
    const row = resultRow(api, result, controls);
    row.classList.add('scan-row-fresh');
    controls.resultsBox.appendChild(row);
  });
  scan.running = false;
  controls.scanButton.disabled = false;
  controls.scanButton.textContent = '🔍 Scan for local LLMs';
  refreshModelDatalist(controls.modelInput);

  const best = bestReachable(scan.results);
  if (best) {
    for (const model of best.models) {
      if (!discoveredModels.includes(model)) discoveredModels.push(model);
    }
    if (!controls.modelInput.value && best.models.length > 0) {
      controls.modelInput.value = best.models[0] ?? '';
      api.toast(`${best.candidate.label} found — model prefilled. Press Save.`, 'success');
    } else if (best.models.length === 0) {
      api.toast(
        `${best.candidate.label} is reachable but lists no models — type the model name and Save.`,
        'info',
      );
    }
    refreshModelDatalist(controls.modelInput);
  } else {
    const blocked = scan.results.find((r) => r.status === 'cors-blocked');
    api.toast(
      blocked
        ? `Nothing fully reachable — ${blocked.candidate.label} answered but CORS-blocked. See the Help note below.`
        : 'No local LLM found. Type a base URL manually and press “Probe this URL”.',
      'info',
    );
  }
}

/** Probe whatever the user typed in the Base URL field, as a one-off candidate. */
async function probeCustom(api: AppApi, controls: Controls): Promise<void> {
  const baseUrl = normalizeBaseUrl(controls.urlInput.value);
  if (!/^https?:\/\/[^/]+/.test(baseUrl)) {
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
    vendor: controls.vendorInput.value as EndpointVendor,
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
  row.replaceWith(resultRow(api, result, controls));
  if (result.status === 'reachable') {
    for (const model of result.models) {
      if (!discoveredModels.includes(model)) discoveredModels.push(model);
    }
    if (!controls.modelInput.value && result.models.length > 0) {
      controls.modelInput.value = result.models[0] ?? '';
    }
    refreshModelDatalist(controls.modelInput);
  }
}

function refreshModelDatalist(modelInput: HTMLInputElement): void {
  const list = document.getElementById('discovered-models');
  if (!list) return;
  const options = [...new Set([...discoveredModels, modelInput.value])]
    .filter((m) => m.length > 0)
    .map((m) => h('option', { value: m }));
  list.replaceChildren(...options);
}

async function testConnection(api: AppApi, controls: Controls): Promise<void> {
  const token = api.beginGen();
  api.toast('Testing…', 'info');
  try {
    const endpoint: EndpointSettings = {
      ...api.lib.settings.endpoint,
      baseUrl: normalizeBaseUrl(controls.urlInput.value),
      vendor: controls.vendorInput.value as EndpointVendor,
      model: controls.modelInput.value.trim(),
      apiKey: controls.keyInput.value.trim(),
    };
    const answer = await api.generateText([{ role: 'user', content: 'Reply with exactly: OK' }], {
      model: endpoint.model,
      endpoint,
    });
    if (api.staleGen(token)) return;
    api.toast(`Connected — the model said “${answer.trim().slice(0, 40)}”`, 'success');
  } catch (err) {
    if (api.staleGen(token)) return;
    api.toast(api.genError(err), 'error');
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
    await exportLibraryFile(api.lib);
    api.toast('Library exported', 'success');
  } catch (err) {
    api.toast(err instanceof Error ? err.message : 'Export failed', 'error');
  }
}

async function importAll(api: AppApi): Promise<void> {
  try {
    const imported = await importLibraryFile();
    if (!imported) return;
    if (
      window.confirm(`Import ${imported.books.length} book(s)? This REPLACES the current library.`)
    ) {
      api.update(() => imported);
      api.toast('Imported', 'success');
    }
  } catch (err) {
    api.toast(err instanceof Error ? err.message : 'Import failed', 'error');
  }
}

async function wipe(api: AppApi): Promise<void> {
  await clearLibrary();
  api.update(() => defaultLibrary());
  api.navigate('library');
  api.toast('Library wiped', 'info');
}
