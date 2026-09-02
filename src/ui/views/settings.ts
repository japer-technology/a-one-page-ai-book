/**
 * ui/views/settings.ts — find your local LLM, tune it, and manage local files.
 *
 * Discovery probes the well-known local inference ports (LM Studio, Ollama,
 * llama.cpp, …). Reachable = we can list its models. CORS-blocked = a server
 * answered but refused this page's origin (actionable help included).
 */
import type { AppApi } from '../ctx';
import { button, field, h } from '../dom';
import { CANDIDATES, normalizeBaseUrl, vendorName } from '../../llm/endpoints';
import { discover } from '../../llm/probe';
import type { ProbeResult } from '../../llm/probe';
import { clearLibrary, estimateStorage, requestPersistence } from '../../store/db';
import { exportLibraryFile, hasFilePicker, hasOpfs, importLibraryFile } from '../../store/files';
import { defaultLibrary } from '../../core/schema';
import type { EndpointSettings, EndpointVendor } from '../../core/types';

// Session view state.
const scan = { running: false, results: [] as ProbeResult[] };
const discoveredModels: string[] = [];

export function renderSettings(api: AppApi): HTMLElement {
  const endpoint = api.lib.settings.endpoint;

  const nameInput = h('input', { class: 'input', type: 'text', value: endpoint.name });
  const urlInput = h('input', {
    class: 'input',
    type: 'text',
    value: endpoint.baseUrl,
    placeholder: 'http://127.0.0.1:1234',
  });
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
  });

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
  for (const result of scan.results)
    resultsBox.appendChild(resultRow(api, result, nameInput, urlInput, vendorInput, modelInput));

  const scanButton = button(
    scan.running ? 'Scanning…' : '🔍 Scan for local LLMs',
    () => void runScan(api, resultsBox, nameInput, urlInput, vendorInput, modelInput),
    'primary',
    { disabled: scan.running },
  );

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
    api.update((lib) => ({
      ...lib,
      settings: {
        ...lib.settings,
        endpoint: {
          name: nameInput.value.trim() || 'Local LLM',
          baseUrl,
          vendor: vendorInput.value as EndpointVendor,
          model: modelInput.value.trim(),
          temperature: Number(tempInput.value),
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
      text: 'Page Turn talks only to local LLM servers on your machine. Nothing is ever sent to a cloud service.',
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
          text: `Probes ${CANDIDATES.length} well-known local endpoints`,
        }),
      ),
      resultsBox,
      field('Name', nameInput),
      field(
        'Base URL',
        urlInput,
        'e.g. http://127.0.0.1:1234 (LM Studio) or http://127.0.0.1:11434 (Ollama)',
      ),
      field('Protocol', vendorInput),
      field('Model', modelInput, modelDatalist),
      field('Temperature', h('div', { class: 'row gap' }, tempInput, tempLabel)),
      h(
        'div',
        { class: 'row gap' },
        button('💾 Save', save, 'primary'),
        button(
          'Test connection',
          () => void testConnection(api, urlInput, vendorInput, modelInput),
        ),
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
          text: 'Your server answered, but refused requests from this page’s origin (web pages may only call other origins when the server explicitly allows it). Fixes: enable CORS for localhost origins in your server, or serve Page Turn from http://localhost (pnpm dev) — most servers allow localhost by default. LM Studio ships with CORS enabled.',
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
  );
}

function resultRow(
  api: AppApi,
  result: ProbeResult,
  nameInput: HTMLInputElement,
  urlInput: HTMLInputElement,
  vendorInput: HTMLSelectElement,
  modelInput: HTMLInputElement,
): HTMLElement {
  const status =
    result.status === 'reachable'
      ? h('span', { class: 'badge badge-ok', text: '✓ reachable' })
      : result.status === 'cors-blocked'
        ? h('span', { class: 'badge badge-warn', text: 'CORS-blocked' })
        : h('span', { class: 'badge badge-off', text: 'not found' });

  const use = () => {
    nameInput.value = result.candidate.label;
    urlInput.value = result.candidate.baseUrl;
    vendorInput.value = result.candidate.vendor;
    for (const model of result.models)
      if (!discoveredModels.includes(model)) discoveredModels.push(model);
    if (!modelInput.value && result.models.length > 0) modelInput.value = result.models[0] ?? '';
    api.toast(
      `Using ${result.candidate.label} (${vendorName(result.candidate.vendor)})`,
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

async function runScan(
  api: AppApi,
  resultsBox: HTMLElement,
  nameInput: HTMLInputElement,
  urlInput: HTMLInputElement,
  vendorInput: HTMLSelectElement,
  modelInput: HTMLInputElement,
): Promise<void> {
  scan.running = true;
  scan.results = [];
  api.refresh();
  await discover((result) => {
    scan.results.push(result);
    const row = resultRow(api, result, nameInput, urlInput, vendorInput, modelInput);
    row.classList.add('scan-row-fresh');
    resultsBox.appendChild(row);
  });
  scan.running = false;
  api.refresh();
}

async function testConnection(
  api: AppApi,
  urlInput: HTMLInputElement,
  vendorInput: HTMLSelectElement,
  modelInput: HTMLInputElement,
): Promise<void> {
  const token = api.beginGen();
  api.toast('Testing…', 'info');
  try {
    const endpoint: EndpointSettings = {
      ...api.lib.settings.endpoint,
      baseUrl: normalizeBaseUrl(urlInput.value),
      vendor: vendorInput.value as EndpointVendor,
      model: modelInput.value.trim(),
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
