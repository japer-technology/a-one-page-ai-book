/**
 * llm/lan.ts — scan the local network for LLM servers.
 *
 * What a browser page CANNOT do: enumerate hosts (no raw sockets, no ARP/ICMP).
 * What it CAN do: fetch() individual http://host:port addresses. So "scanning
 * the network" means probing the grid {subnet base} × {1..254} × {known LLM
 * ports} with a no-cors GET (any HTTP answer = a responder), then identifying
 * responders with the regular CORS model-list probe.
 *
 * The subnet is auto-detected where the browser allows it (WebRTC ICE leaks
 * the local IP; Chrome mDNS-obfuscates it) — manual entry is the reliable
 * path, with common-subnet chips as shortcuts.
 */
import { probeCandidate } from './probe';
import type { EndpointVendor } from '../core/types';

export interface LanHit {
  host: string;
  port: number;
}

export interface LanServer extends LanHit {
  baseUrl: string;
  models: string[];
  vendor: EndpointVendor;
  corsOk: boolean;
  latencyMs: number | null;
  detail: string;
}

/**
 * Normalize user input to a three-octet subnet base:
 * "192.168.1" | "192.168.1.0/24" | "192.168.1.42" → "192.168.1". Null if invalid.
 */
export function normalizeSubnetBase(input: string): string | null {
  const cleaned = input.trim().replace(/\/\d+$/, '');
  const parts = cleaned.split('.');
  if (parts.length < 3 || parts.length > 4) return null;
  const octets = parts.slice(0, 3);
  const fourth = parts[3];
  for (const octet of fourth !== undefined ? [...octets, fourth] : octets) {
    if (!/^\d{1,3}$/.test(octet)) return null;
    if (Number(octet) > 255) return null;
  }
  return octets.join('.');
}

export function subnetBaseOf(ip: string): string {
  return ip.split('.').slice(0, 3).join('.');
}

export function commonSubnets(): string[] {
  return ['192.168.1', '192.168.0', '192.168.178', '192.168.50', '10.0.0', '10.0.1', '172.16.0'];
}

const LOCAL_IP_PATTERN = /(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}/;

/**
 * Best-effort local-IP detection via WebRTC ICE candidates. Browsers that
 * obfuscate with mDNS (Chrome) yield no usable IP and this resolves null —
 * the UI falls back to manual subnet entry.
 */
export function detectLocalIp(timeoutMs = 1500): Promise<string | null> {
  if (typeof RTCPeerConnection === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ip: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        pc.close();
      } catch {
        // already closed
      }
      resolve(ip);
    };
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => finish(null), timeoutMs);
    pc.onicecandidate = (event) => {
      const text = event.candidate?.candidate ?? '';
      const match = text.match(LOCAL_IP_PATTERN);
      if (match) finish(match[0]);
    };
    try {
      pc.createDataChannel('lan-detect');
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => finish(null));
    } catch {
      finish(null);
    }
  });
}

/** One HTTP presence probe: any response (even an error page) counts as a responder. */
async function respondsToHttp(
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { method: 'GET', mode: 'no-cors', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export interface ScanLanOptions {
  /** Three-octet base, e.g. "192.168.1" — hosts .1 through .254 are probed. */
  base: string;
  ports: number[];
  timeoutMs?: number;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, hits: LanHit[]) => void;
  onHit?: (hit: LanHit) => void;
}

/**
 * Probe the grid with bounded parallelism. Per host, ports are tried in order
 * and the scan stops at the FIRST responder — one LLM server per machine is
 * the overwhelming case, and this keeps a full /24 scan to seconds.
 */
export async function scanLan(options: ScanLanOptions): Promise<LanHit[]> {
  const { base, ports } = options;
  const timeoutMs = options.timeoutMs ?? 600;
  const concurrency = Math.max(1, options.concurrency ?? 16);
  const hosts: string[] = [];
  for (let i = 1; i <= 254; i++) hosts.push(`${base}.${i}`);

  const hits: LanHit[] = [];
  const queue = [...hosts];
  let done = 0;

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      if (options.signal?.aborted) return;
      const host = queue.shift();
      if (!host) return;
      for (const port of ports) {
        if (options.signal?.aborted) break;
        if (await respondsToHttp(`http://${host}:${port}/`, timeoutMs, options.signal)) {
          const hit: LanHit = { host, port };
          hits.push(hit);
          options.onHit?.(hit);
          break; // first responder per host
        }
      }
      done++;
      options.onProgress?.(done, hosts.length, hits);
    }
  });
  await Promise.all(workers);
  return hits;
}

/**
 * Identify a responder: CORS model-list probe with vendor guessing by port
 * (Ollama on 11434; everything else is treated as OpenAI-compatible — which
 * Ollama also serves at /v1, so both guesses work with the chat client).
 */
export async function identifyLanServer(hit: LanHit, timeoutMs = 1800): Promise<LanServer> {
  const baseUrl = `http://${hit.host}:${hit.port}`;
  const vendor: EndpointVendor = hit.port === 11434 ? 'ollama' : 'openai-compat';
  const result = await probeCandidate(
    { id: 'lan', label: 'LAN server', baseUrl, vendor, note: '' },
    timeoutMs,
  );
  return {
    host: hit.host,
    port: hit.port,
    baseUrl,
    models: result.models,
    vendor,
    corsOk: result.status === 'reachable',
    latencyMs: result.latencyMs,
    detail: result.detail,
  };
}
