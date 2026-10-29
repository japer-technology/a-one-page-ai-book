// @vitest-environment happy-dom
/**
 * tests/views/settings.test.ts — who a model list (and an API key) belongs to.
 *
 * A model list is read FROM one server. Committing a different base URL must
 * drop it: the old code kept presenting the previous server's list as this
 * one's, so a plain Save could store a (url, model) pair that never existed and
 * every later generation failed. The API key follows the same rule — it is
 * scoped to the origin it was typed for, and the field promises it is sent
 * "only to this endpoint".
 *
 * Feasibility note: `picker.forUrl` is only ever set by a probe of a server,
 * so the first test stubs `fetch` to answer the model-list request locally.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderSettings } from '../../src/ui/views/settings';
import { defaultLibrary } from '../../src/core/schema';
import type { Library } from '../../src/core/types';
import { click, findButton, mountView, settle, StubApp, type } from '../helpers/view-harness';

const OLD_URL = 'http://127.0.0.1:1234';
const NEW_URL = 'http://127.0.0.1:4141';

function fixture(): { app: StubApp; root: HTMLElement } {
  const base = defaultLibrary();
  const lib: Library = {
    ...base,
    settings: {
      ...base.settings,
      endpoint: {
        ...base.settings.endpoint,
        name: 'LM Studio',
        baseUrl: OLD_URL,
        model: 'writer-8b',
        apiKey: 'sk-local-secret',
      },
    },
  };
  const app = new StubApp(lib, null, 'settings');
  const root = mountView(app, renderSettings);
  return { app, root };
}

/** Answer the model-list request for OLD_URL; refuse everything else. */
function stubModelListServer(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith(OLD_URL) && url.includes('/v1/models')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'writer-8b' }, { id: 'embed-small' }] }),
        };
      }
      throw new TypeError('connection refused');
    }),
  );
}

const urlBox = (root: HTMLElement): HTMLInputElement =>
  root.querySelector('#endpoint-url') as HTMLInputElement;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the settings endpoint form', () => {
  it('uses the entered key for both reload models and Probe this URL', async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input) === `${OLD_URL}/v1/models`) {
        return new Response(
          JSON.stringify(
            new Headers(init?.headers).get('authorization') === 'Bearer sk-local-secret'
              ? { data: [{ id: 'authenticated-writer' }] }
              : { error: 'unauthorized' },
          ),
          { status: new Headers(init?.headers).has('authorization') ? 200 : 401 },
        );
      }
      throw new TypeError('connection refused');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { root } = fixture();
    click(root.querySelector<HTMLButtonElement>('#endpoint-reload-models') ?? undefined);
    await settle();
    expect((root.querySelector('#endpoint-model') as HTMLSelectElement).value).toBe(
      'authenticated-writer',
    );
    click(findButton(root, 'Probe this URL'));
    await settle();
    expect((root.querySelector('#endpoint-model') as HTMLSelectElement).value).toBe(
      'authenticated-writer',
    );
    expect(root.querySelector('.llm-results')?.textContent).toContain('reachable');
  });

  it('clears both saved model choices when changing servers without first probing', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('connection refused');
      }),
    );
    const lib = defaultLibrary();
    lib.settings.endpoint.model = 'old-writer';
    lib.settings.fastModel = 'old-fast';
    const app = new StubApp(lib, null, 'settings');
    const root = mountView(app, renderSettings);
    type(urlBox(root), NEW_URL);
    urlBox(root).dispatchEvent(new window.Event('change', { bubbles: true }));
    expect((root.querySelector('#endpoint-model-custom') as HTMLInputElement).value).toBe('');
    expect((root.querySelector('#fast-model') as HTMLInputElement).value).toBe('');
  });

  it('does not let a delayed custom probe overwrite a newly typed endpoint', async () => {
    let resolveProbe!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        if (String(input) === `${OLD_URL}/v1/models`) {
          return new Promise<Response>((resolve) => {
            resolveProbe = resolve;
          });
        }
        return Promise.reject(new TypeError('connection refused'));
      }),
    );
    const { root } = fixture();
    click(findButton(root, 'Probe this URL'));
    type(urlBox(root), NEW_URL);
    urlBox(root).dispatchEvent(new window.Event('change', { bubbles: true }));
    resolveProbe(new Response(JSON.stringify({ data: [{ id: 'stale-writer' }] })));
    await settle();
    expect(urlBox(root).value).toBe(NEW_URL);
    expect((root.querySelector('#endpoint-model-custom') as HTMLInputElement).value).toBe('');
  });

  it('tests the fast model too, rather than claiming titles will work after only testing the writer', async () => {
    stubModelListServer();
    const { app, root } = fixture();
    type(root.querySelector<HTMLInputElement>('#fast-model'), 'missing-fast-model');
    const models: string[] = [];
    app.generateText = async (_messages?: unknown, opts?: { model?: string }) => {
      models.push(opts?.model ?? '');
      if (opts?.model === 'missing-fast-model') throw new Error('model not found');
      return 'OK';
    };
    click(root.querySelector<HTMLButtonElement>('#endpoint-save-test') ?? undefined);
    await settle();
    await settle();
    expect(models).toEqual(['writer-8b', 'missing-fast-model']);
    expect(root.querySelector('#endpoint-status')?.textContent).toContain(
      'Main model works, but fast model',
    );
    expect(root.querySelector('#endpoint-status')?.textContent).toContain('model not found');
    expect((root.querySelector('#endpoint-save-test') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps Other selected after saving a custom model alongside a discovered list', async () => {
    stubModelListServer();
    const { app, root } = fixture();
    click(findButton(root, 'Reload models') ?? findButton(root, 'Load this server'));
    await settle();
    const select = root.querySelector<HTMLSelectElement>('#endpoint-model')!;
    select.value = '\u0000custom';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    type(root.querySelector<HTMLInputElement>('#endpoint-model-custom'), 'custom-writer');
    click(root.querySelector('#endpoint-save') ?? undefined);
    await settle();
    expect(app.lib.settings.endpoint.model).toBe('custom-writer');
    expect(root.querySelector<HTMLSelectElement>('#endpoint-model')?.value).toBe('\u0000custom');
    expect(root.querySelector<HTMLInputElement>('#endpoint-model-custom')?.value).toBe(
      'custom-writer',
    );
  });

  it('does not report a replaced endpoint as connected or test its fast model on the old server', async () => {
    stubModelListServer();
    const { app, root } = fixture();
    let finish!: (reply: string) => void;
    let requests = 0;
    app.generateText = () => {
      requests++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    click(root.querySelector('#endpoint-save-test') ?? undefined);
    await settle();
    app.update((lib) => ({
      ...lib,
      settings: {
        ...lib.settings,
        endpoint: { ...lib.settings.endpoint, baseUrl: NEW_URL },
        fastModel: 'new-server-fast-model',
      },
    }));
    finish('OK');
    await settle();
    const count = requests;
    if (count > 1) {
      finish('OK');
      await settle();
    }
    expect(count).toBe(1);
    expect(root.querySelector('#endpoint-status')?.textContent).not.toContain('Connected');
    expect(root.querySelector('#endpoint-status')?.textContent).toContain('changed');
  });

  it('clears the pending test notice when navigation wins a successful-response race', async () => {
    stubModelListServer();
    const { app, root } = fixture();
    let finish!: (reply: string) => void;
    app.generateText = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    click(root.querySelector('#endpoint-save-test') ?? undefined);
    await settle();
    app.abortGeneration();
    finish('OK');
    await settle();
    app.refresh();
    expect(root.querySelector('#endpoint-status')?.textContent).not.toContain('Testing');
    expect(root.querySelector<HTMLButtonElement>('#endpoint-save-test')?.disabled).toBe(false);
  });

  it('clears the previous server’s model list when a different URL is committed', async () => {
    stubModelListServer();
    const { app, root } = fixture();

    // Step 2 has no list yet — the reader asks the typed server for one.
    click(root.querySelector('#endpoint-reload-models') as HTMLButtonElement);
    await settle();
    await settle();
    await settle();

    const select = root.querySelector('#endpoint-model') as HTMLSelectElement | null;
    expect(select).toBeTruthy();
    expect([...(select?.options ?? [])].map((option) => option.value)).toContain('writer-8b');

    // Commit a DIFFERENT address.
    type(urlBox(root), NEW_URL);
    urlBox(root).dispatchEvent(new window.Event('change', { bubbles: true }));

    // The old server's list is gone from the screen — the picker is back to
    // "nothing to choose yet" instead of listing 1234's models under 4141.
    expect(root.querySelector('#endpoint-model')).toBeNull();
    expect((root.querySelector('#endpoint-model-custom') as HTMLInputElement).value).toBe('');
    // Nothing half-adopted can reach Save.
    expect(app.toasts.map((toast) => toast.message).join('\n')).toContain(
      'Model cleared — it belonged to the previous server.',
    );
  });

  it('drops the API key as soon as a different origin is committed', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('connection refused'))),
    );
    const { app, root } = fixture();
    expect((root.querySelector('#endpoint-key') as HTMLInputElement).value).toBe('sk-local-secret');

    type(urlBox(root), NEW_URL);
    urlBox(root).dispatchEvent(new window.Event('change', { bubbles: true }));

    expect((root.querySelector('#endpoint-key') as HTMLInputElement).value).toBe('');
    expect(app.toasts.some((toast) => toast.message.includes('API key cleared'))).toBe(true);
  });

  it('does not carry the model list across when only the path differs', async () => {
    // A normalised-equal URL (trailing slash, /v1 suffix) is the SAME server:
    // the list must survive, and no "cleared" toast may fire.
    stubModelListServer();
    const { app, root } = fixture();
    click(root.querySelector('#endpoint-reload-models') as HTMLButtonElement);
    await settle();
    await settle();

    type(urlBox(root), `${OLD_URL}/v1/`);
    urlBox(root).dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(root.querySelector('#endpoint-model')).toBeTruthy();
    expect((root.querySelector('#endpoint-model') as HTMLSelectElement).value).toBe('writer-8b');
    expect(app.toasts.map((toast) => toast.message).join('\n')).not.toContain('Model cleared');
  });
});
