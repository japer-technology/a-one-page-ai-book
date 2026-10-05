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
import { click, mountView, settle, StubApp, type } from '../helpers/view-harness';

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
