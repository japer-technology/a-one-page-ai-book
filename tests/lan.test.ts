import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  commonSubnets,
  detectLocalIp,
  identifyLanServer,
  normalizeSubnetBase,
  scanLan,
  subnetBaseOf,
} from '../src/llm/lan';
import { llmPorts } from '../src/llm/endpoints';

describe('normalizeSubnetBase', () => {
  it('normalizes every accepted shape to three octets', () => {
    expect(normalizeSubnetBase('192.168.1')).toBe('192.168.1');
    expect(normalizeSubnetBase(' 192.168.1.0/24 ')).toBe('192.168.1');
    expect(normalizeSubnetBase('192.168.1.42')).toBe('192.168.1');
    expect(normalizeSubnetBase('10.0.0.7')).toBe('10.0.0');
  });

  it('rejects garbage', () => {
    expect(normalizeSubnetBase('foo')).toBeNull();
    expect(normalizeSubnetBase('999.1.1')).toBeNull();
    expect(normalizeSubnetBase('192.168.1.256')).toBeNull();
    expect(normalizeSubnetBase('')).toBeNull();
    expect(normalizeSubnetBase('192.168')).toBeNull();
  });

  it('derives a base from a full IP', () => {
    expect(subnetBaseOf('192.168.1.42')).toBe('192.168.1');
  });

  it('offers common subnet chips', () => {
    expect(commonSubnets()).toContain('192.168.1');
    expect(commonSubnets()).toContain('10.0.0');
  });
});

describe('llmPorts', () => {
  it('returns the catalog ports without duplicates', () => {
    const ports = llmPorts();
    expect(ports).toContain(1234);
    expect(ports).toContain(11434);
    expect(new Set(ports).size).toBe(ports.length);
  });
});

describe('detectLocalIp', () => {
  it('resolves null without RTCPeerConnection (node)', async () => {
    expect(await detectLocalIp(100)).toBeNull();
  });
});

describe('scanLan', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('probes the full grid and reports responders', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('http://192.168.1.5:1234')) {
          return { ok: false, status: 0, type: 'opaque' };
        }
        throw new TypeError('refused');
      }),
    );
    const hitHosts: string[] = [];
    let finalProgress = 0;
    const found = await scanLan({
      base: '192.168.1',
      ports: [1234],
      timeoutMs: 100,
      concurrency: 8,
      onHit: (hit) => hitHosts.push(hit.host),
      onProgress: (done) => {
        finalProgress = done;
      },
    });
    expect(found).toEqual([{ host: '192.168.1.5', port: 1234 }]);
    expect(hitHosts).toEqual(['192.168.1.5']);
    expect(finalProgress).toBe(254);
  });

  it('stops at the first responder per host', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.startsWith('http://192.168.1.5:11434')) {
          return { ok: false, status: 0, type: 'opaque' };
        }
        throw new TypeError('refused');
      }),
    );
    const found = await scanLan({
      base: '192.168.1',
      ports: [1234, 11434],
      timeoutMs: 100,
      concurrency: 4,
    });
    expect(found).toEqual([{ host: '192.168.1.5', port: 11434 }]);
    // Host .5 must not be probed again after the hit.
    const fiveProbes = urls.filter((u) => u.startsWith('http://192.168.1.5:'));
    expect(fiveProbes).toHaveLength(2); // 1234 then 11434, then stop
  });

  it('respects the abort signal', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 2));
        throw new TypeError('refused');
      }),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await scanLan({
      base: '192.168.1',
      ports: [1234, 11434],
      timeoutMs: 100,
      concurrency: 4,
      signal: controller.signal,
    });
    expect(calls).toBeLessThan(254 * 2);
  });
});

describe('identifyLanServer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('identifies an OpenAI-compatible server (non-Ollama port)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'm' }] }) })),
    );
    const server = await identifyLanServer({ host: '192.168.1.5', port: 1234 }, 300);
    expect(server.models).toEqual(['m']);
    expect(server.vendor).toBe('openai-compat');
    expect(server.corsOk).toBe(true);
    expect(server.baseUrl).toBe('http://192.168.1.5:1234');
  });

  it('guesses Ollama for port 11434', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: 'llama3' }] }),
      })),
    );
    const server = await identifyLanServer({ host: '192.168.1.5', port: 11434 }, 300);
    expect(server.vendor).toBe('ollama');
    expect(server.models).toEqual(['llama3']);
  });
});
