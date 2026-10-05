import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  commonSubnets,
  detectLocalIp,
  detectLocalIps,
  identifyLanServer,
  isPrivateIpv4,
  normalizeSubnetBase,
  rankSubnets,
  scanLan,
  subnetBaseOf,
  subnetCandidates,
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves null without RTCPeerConnection (node)', async () => {
    expect(await detectLocalIp(100)).toBeNull();
    expect(await detectLocalIps(100)).toEqual([]);
  });

  /** A peer connection that reports exactly the candidates given, then ends. */
  const stubbedPeer = (candidates: string[]): unknown =>
    class {
      onicecandidate: ((event: { candidate: { candidate: string } | null }) => void) | null = null;
      createDataChannel(): object {
        return {};
      }
      createOffer(): Promise<object> {
        return Promise.resolve({});
      }
      setLocalDescription(): Promise<void> {
        for (const candidate of candidates) this.onicecandidate?.({ candidate: { candidate } });
        this.onicecandidate?.({ candidate: null });
        return Promise.resolve();
      }
      close(): void {}
    };

  it('reads all four octets of a 10.x candidate', async () => {
    // The address half of detection exists for the browsers that reveal it
    // (Firefox, Safari), and a three-octet match is not an address: it was
    // rejected by `isPrivateIpv4` and thrown away, so every machine on a 10.x
    // network detected nothing at all.
    vi.stubGlobal(
      'RTCPeerConnection',
      stubbedPeer(['candidate:1 1 udp 2122260223 10.99.99.7 54321 typ host generation 0']),
    );
    expect(await detectLocalIps(1000)).toEqual(['10.99.99.7']);
  });

  it('keeps every interface address, and ignores everything else', async () => {
    vi.stubGlobal(
      'RTCPeerConnection',
      stubbedPeer([
        'candidate:1 1 udp 2122260223 192.168.1.211 54321 typ host generation 0',
        'candidate:2 1 udp 2122260222 172.16.4.9 54322 typ host generation 0',
        // Public, loopback and mDNS candidates are not ours to sweep.
        'candidate:3 1 udp 2122260221 8.8.8.8 54323 typ host generation 0',
        'candidate:4 1 udp 2122260220 127.0.0.1 54324 typ host generation 0',
        'candidate:5 1 udp 2122260219 9f1b7e2a-33cc-4c1a-9a1e-1f0b6d0f2c11.local 54325 typ host',
      ]),
    );
    expect(await detectLocalIps(1000)).toEqual(['192.168.1.211', '172.16.4.9']);
  });
});

describe('isPrivateIpv4', () => {
  it('accepts the private and link-local ranges', () => {
    expect(isPrivateIpv4('192.168.1.42')).toBe(true);
    expect(isPrivateIpv4('10.0.0.7')).toBe(true);
    expect(isPrivateIpv4('172.16.0.1')).toBe(true);
    expect(isPrivateIpv4('172.31.255.254')).toBe(true);
    expect(isPrivateIpv4('169.254.1.1')).toBe(true);
  });

  it('rejects public, loopback and garbage addresses', () => {
    expect(isPrivateIpv4('8.8.8.8')).toBe(false);
    expect(isPrivateIpv4('172.32.0.1')).toBe(false);
    expect(isPrivateIpv4('127.0.0.1')).toBe(false);
    expect(isPrivateIpv4('192.168.1')).toBe(false);
    expect(isPrivateIpv4('192.168.1.999')).toBe(false);
    expect(isPrivateIpv4('not-an-ip')).toBe(false);
  });
});

describe('subnetCandidates', () => {
  it('puts a detected address first, then the common defaults', () => {
    const bases = subnetCandidates(['192.168.7.44']);
    expect(bases[0]).toBe('192.168.7');
    expect(bases).toContain('192.168.1');
  });

  it('ignores the link-local fallback range, which is never where a server lives', () => {
    expect(subnetCandidates(['169.254.10.20'])).not.toContain('169.254.10');
  });

  it('falls back to the common chips with nothing detected', () => {
    expect(subnetCandidates([])).toEqual(commonSubnets());
  });

  it('prefers a network it knows by name over a virtual adapter', () => {
    // Docker's bridge and a home LAN: the bridge is a real interface with a
    // real address, and sweeping it finds nothing.
    const bases = subnetCandidates(['172.17.0.1', '192.168.1.211']);
    expect(bases[0]).toBe('192.168.1');
    expect(bases).toContain('172.17.0');
  });
});

describe('rankSubnets', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('finds the subnet whose gateway answers and stops looking', async () => {
    const probed: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        probed.push(url);
        // Only 192.168.0 answers — and 192.168.1 is tried first, so the sweep
        // has to give up on it before it finds the real one.
        if (url.startsWith('http://192.168.0.1:80')) return { ok: false, status: 0 };
        throw new TypeError('refused');
      }),
    );
    const guesses = await rankSubnets({ timeoutMs: 50 });
    expect(guesses[0]?.base).toBe('192.168.0');
    expect(guesses[0]?.latencyMs).not.toBeNull();
    expect(guesses[0]?.evidence).toContain('192.168.0.1:80');
    // It stopped at the first answering subnet instead of probing all of them.
    expect(probed.some((url) => url.startsWith('http://10.0.0.1'))).toBe(false);
  });

  it('keeps every candidate subnet when nothing answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('refused');
      }),
    );
    const guesses = await rankSubnets({ timeoutMs: 50 });
    expect(guesses.map((g) => g.base)).toEqual(commonSubnets());
    expect(guesses.every((g) => g.latencyMs === null)).toBe(true);
  });

  it('tests an extra subnet (the one used last time) as well', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('refused');
      }),
    );
    const guesses = await rankSubnets({ extra: ['192.168.9'], timeoutMs: 50 });
    expect(guesses.map((g) => g.base)).toContain('192.168.9');
  });

  it('asks nothing at all when the page already holds a local address', async () => {
    // What Firefox and Safari hand over, and what a page served from a LAN
    // machine knows about itself. Interrogating the other candidates anyway
    // cost 28 dropped connects and ~20 s of waiting to confirm an answer the
    // address had already given.
    const fetchMock = vi.fn(async () => {
      throw new TypeError('probed');
    });
    vi.stubGlobal('fetch', fetchMock);
    const started = Date.now();
    const guesses = await rankSubnets({ detectedIps: ['192.168.7.44'], timeoutMs: 700 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(200);
    // ...and the subnet we are on is reported as OUR subnet, with the address
    // that proves it, ahead of every guess.
    expect(guesses[0]).toEqual({
      base: '192.168.7',
      evidence: 'this page is served from 192.168.7.44',
      latencyMs: null,
      detected: true,
    });
    // The others are still on offer as chips, just not interrogated.
    expect(guesses.map((g) => g.base)).toEqual(subnetCandidates(['192.168.7.44']));
  });

  it('keeps every address we hold, and probes nobody when we hold several', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('probed');
    });
    vi.stubGlobal('fetch', fetchMock);
    const guesses = await rankSubnets({
      detectedIps: ['192.168.7.44', '10.4.4.9'],
      extra: ['192.168.9'],
      timeoutMs: 50,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(guesses.filter((g) => g.detected).map((g) => g.base)).toEqual(['192.168.7', '10.4.4']);
    expect(guesses.map((g) => g.base)).toContain('192.168.9');
  });

  it('still interrogates the network when the only address is a link-local one', async () => {
    // 169.254.x.x is a "no DHCP" fallback, not a network a server lives on, so
    // it must not be mistaken for knowing where we are.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('http://192.168.0.1:80')) return { ok: false, status: 0 };
        throw new TypeError('refused');
      }),
    );
    const guesses = await rankSubnets({ detectedIps: ['169.254.10.20'], timeoutMs: 50 });
    expect(guesses[0]?.base).toBe('192.168.0');
    expect(guesses[0]?.latencyMs).not.toBeNull();
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

  it('races the ports of a host and keeps the first responder', async () => {
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
    // Both ports are in flight together (one batch per host, not one timeout
    // per port) and the host is not probed again after its hit.
    const fiveProbes = urls.filter((u) => u.startsWith('http://192.168.1.5:'));
    expect(fiveProbes).toHaveLength(2);
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

  it('retries identification once when the answer was "no response"', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        // The presence probe already proved something is there; the first
        // identification attempt (its CORS fetch and its two presence
        // fallbacks) was lost.
        if (calls <= 3) throw new TypeError('lost');
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm' }] }) };
      }),
    );
    const server = await identifyLanServer({ host: '192.168.1.5', port: 1234 }, 100);
    expect(server.corsOk).toBe(true);
    expect(server.models).toEqual(['m']);
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

describe('port priority in a host sweep', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not let a faster later port hide a slower higher-priority one', async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === 'http://10.9.9.7:8555/') return { ok: true, status: 200 };
        if (url === 'http://10.9.9.7:7444/') {
          await sleep(40);
          return { ok: true, status: 200 };
        }
        throw new TypeError('refused');
      }),
    );
    const hits = await scanLan({
      base: '10.9.9',
      ports: [7444, 8555],
      timeoutMs: 400,
      concurrency: 8,
    });
    expect(hits).toEqual([{ host: '10.9.9.7', port: 7444 }]);
  });

  it('still reports a host whose only responder is the later port', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === 'http://10.9.9.8:8555/') return { ok: true, status: 200 };
        throw new TypeError('refused');
      }),
    );
    const hits = await scanLan({
      base: '10.9.9',
      ports: [7444, 8555],
      timeoutMs: 300,
      concurrency: 8,
    });
    expect(hits).toEqual([{ host: '10.9.9.8', port: 8555 }]);
  });
});
