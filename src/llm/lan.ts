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
import type { ProbeResult } from './probe';
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
  /**
   * The raw probe verdict. `corsOk` alone cannot distinguish "CORS refused
   * this origin" from "the server is there and wants an API key", and badging
   * a key-protected server as CORS-blocked sent the reader off to change
   * server-side origin settings instead of pasting their key.
   */
  status: ProbeResult['status'];
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

/**
 * A private IPv4 address inside an ICE candidate, all four octets of it.
 *
 * The three prefixes are not the same length — `10.` has one octet, the others
 * two — so each alternative spells out its own remaining octets. Writing it as
 * a shared `\d{1,3}\.\d{1,3}` tail (which is what this used to be) made the
 * `10.` case match only three octets: a candidate reading `10.99.99.7` was
 * captured as `10.99.99`, which is not an address at all, so `isPrivateIpv4`
 * threw it away and every machine on a 10.x network silently lost the address
 * half of network detection — the half that exists for the browsers that do
 * reveal it.
 */
const LOCAL_IP_PATTERN =
  /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/;

/** Is this a private (RFC 1918) or link-local IPv4 address? */
export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  // Every octet has to be a real one: this value decides whether the page's
  // own origin is a usable local address, and "192.168.1.999" is not one.
  if (!parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  const [a, b] = parts.map(Number) as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

/**
 * Every local address a page can legitimately learn.
 *
 * Two sources, because neither is enough on its own:
 *
 * 1. **WebRTC ICE candidates.** Firefox and Safari reveal the real interface
 *    address. Chrome replaces host candidates with `<uuid>.local` mDNS names
 *    unless the page holds a media permission, so this source frequently
 *    yields nothing — which is exactly why a reader on Chrome used to open
 *    Settings and find the subnet box blank.
 * 2. **The page's own origin.** Served from a LAN machine (`http://192.168.1.9:4173`)
 *    the hostname IS the address. Under `file://` it is empty.
 *
 * Whatever is left unresolved is the caller's job: `rankSubnets` finds the
 * subnet the network *answers* on without ever learning our own address.
 */
export function detectLocalIps(timeoutMs = 1500): Promise<string[]> {
  const origin = pageOriginIpv4();
  if (typeof RTCPeerConnection === 'undefined') {
    return Promise.resolve(origin === null ? [] : [origin]);
  }
  return new Promise((resolve) => {
    const found = new Set<string>(origin === null ? [] : [origin]);
    let settled = false;
    let pc: RTCPeerConnection | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        pc?.close();
      } catch {
        // already closed
      }
      resolve([...found]);
    };
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
    } catch {
      return resolve([...found]);
    }
    const timer = setTimeout(finish, timeoutMs);
    pc.onicecandidate = (event) => {
      const text = event.candidate?.candidate ?? '';
      // Keep collecting: a machine with Wi-Fi + Ethernet + Docker bridges
      // emits one candidate per interface, and the first is not necessarily
      // the one the LLM server lives on.
      const match = text.match(LOCAL_IP_PATTERN);
      if (match) found.add(match[0]);
      // A null candidate means gathering is complete — it can still be a
      // degenerate `0.0.0.0`/mDNS-only set, so `found` may stay empty.
      if (event.candidate === null) finish();
    };
    try {
      pc.createDataChannel('lan-detect');
      pc.createOffer()
        .then((offer) => pc?.setLocalDescription(offer))
        .catch(finish);
    } catch {
      finish();
    }
  });
}

/** The page's own host, when the page is served from a private address. */
function pageOriginIpv4(): string | null {
  try {
    if (typeof location === 'undefined') return null;
    const host = location.hostname;
    return isPrivateIpv4(host) ? host : null;
  } catch {
    return null;
  }
}

/** The first detected local address, or null. Kept for callers that want one. */
export async function detectLocalIp(timeoutMs = 1500): Promise<string | null> {
  const ips = await detectLocalIps(timeoutMs);
  return ips[0] ?? null;
}

/**
 * A local address a sweep could plausibly belong to: private, and not the
 * link-local fallback. `169.254.x.x` is what an interface shows when DHCP
 * never answered, so it is never where a server lives.
 */
function usableLocalIp(ip: string): boolean {
  return isPrivateIpv4(ip) && !ip.startsWith('169.254.');
}

/**
 * Subnets worth sweeping, best guess first: any subnet we detected an address
 * on, then the common home/office defaults.
 *
 * A machine that runs Docker or a VM holds addresses on several subnets at
 * once, and the virtual bridge (172.17.0, 192.168.56) is not where a reader's
 * LLM server lives. An address on a network this app already knows by name is
 * therefore the better guess for the subnet we are really plugged into, and it
 * goes ahead of the others we hold.
 */
export function subnetCandidates(detectedIps: readonly string[] = []): string[] {
  const common = commonSubnets();
  const ours = [...new Set(detectedIps.filter(usableLocalIp).map(subnetBaseOf))];
  // Ours, named networks first — each base exactly once: a subnet that is both
  // ours and a known default must not be listed (and chipped) twice.
  const named = ours.filter((base) => common.includes(base));
  const out: string[] = [...named, ...ours.filter((base) => !common.includes(base))];
  for (const base of common) if (!out.includes(base)) out.push(base);
  return out;
}

export interface SubnetGuess {
  base: string;
  /**
   * Why this subnet is ranked where it is. Empty when nothing answered and
   * the subnet is simply a plausible default.
   */
  evidence: string;
  /** Round-trip of the evidence probe, when one answered. */
  latencyMs: number | null;
  /**
   * The page holds an address on this subnet. That is proof of the two things
   * the sweep gate needs — the range exists, and we are attached to it — so it
   * is evidence of the strongest kind, and there is nothing left to probe for.
   */
  detected?: boolean;
}

/** Addresses on a subnet that routinely run a web UI (routers, NAS, printers). */
const EVIDENCE_HOSTS = [1, 254];
/** Plain-HTTP ports a router/NAS control panel usually listens on. */
const EVIDENCE_PORTS = [80, 8080];

/**
 * Rank candidate subnets by asking the network which one actually exists.
 *
 * This is the answer to Chrome's mDNS obfuscation. A page cannot enumerate its
 * interfaces, but it *can* talk to `192.168.1.1` — and a router's admin page
 * answers in single-digit milliseconds, while addresses on subnets we are not
 * connected to never answer at all. The subnet whose gateway answers first is
 * the subnet we are on.
 *
 * Probed strictly ONE SUBNET AT A TIME, first address first, and it stops at
 * the first subnet that answers. Firing all of them at once (28 probes across
 * seven subnets, twenty-four of them into ranges this machine is not on) is
 * what made detection unreliable: a connect attempt to a range that is not
 * ours is not refused, it is silently dropped, and the kernel holds the socket
 * for its full SYN-retry window. A handful of those is enough to leave
 * Chromium's network service too busy to answer the ONE probe that mattered —
 * so the answer arrived only sometimes.
 *
 * All of that is the answer to a question that often does not need asking:
 * when a local address IS known (Firefox and Safari reveal one, and a page
 * served from a LAN machine knows its own host), it already names the subnet
 * this page is on. That subnet is recorded as ours and **nothing else is
 * probed** — the remaining candidates stay on offer as chips. Interrogating
 * them would spend 28 dropped connects and ~20 s of waiting to confirm an
 * answer we already hold, and every one of those sockets is the kind that
 * leaves the network service unable to answer the reader's NEXT request (the
 * local sweep, and the "Save & test" they press right afterwards).
 */
export async function rankSubnets(options: {
  detectedIps?: readonly string[];
  /** Extra subnets to test — e.g. the one the reader used last time. */
  extra?: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<SubnetGuess[]> {
  const bases: string[] = [];
  for (const base of subnetCandidates(options.detectedIps ?? [])) bases.push(base);
  for (const base of options.extra ?? []) {
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(base) && !bases.includes(base)) bases.push(base);
  }
  const timeoutMs = options.timeoutMs ?? 700;
  const own = (options.detectedIps ?? []).filter(usableLocalIp);
  /** True once an address of ours has answered the question outright. */
  const known = own.length > 0;
  const guesses: SubnetGuess[] = [];

  for (const base of bases) {
    if (options.signal?.aborted) break;
    const ip = own.find((candidate) => subnetBaseOf(candidate) === base);
    if (ip !== undefined) {
      guesses.push({
        base,
        evidence: `this page is served from ${ip}`,
        latencyMs: null,
        detected: true,
      });
      continue;
    }
    // Our own address already settled this; a probe into anyone else's range
    // cannot change the answer, and it is the expensive kind of probe.
    if (known) continue;
    const hit = await subnetEvidence(base, timeoutMs, options.signal);
    guesses.push(
      hit === null
        ? { base, evidence: '', latencyMs: null }
        : { base, evidence: `something answered at ${hit.host}`, latencyMs: hit.latencyMs },
    );
    // The one we are on has answered; the rest are only chip suggestions.
    if (hit !== null) break;
  }
  for (const base of bases) {
    if (!guesses.some((guess) => guess.base === base))
      guesses.push({ base, evidence: '', latencyMs: null });
  }
  // Answering subnets first (fastest first), then the untested defaults in
  // their stable popularity order.
  return guesses.sort((a, b) => {
    const aAlive = a.latencyMs !== null;
    const bAlive = b.latencyMs !== null;
    if (aAlive !== bAlive) return aAlive ? -1 : 1;
    if (aAlive && bAlive) return (a.latencyMs ?? 0) - (b.latencyMs ?? 0);
    return bases.indexOf(a.base) - bases.indexOf(b.base);
  });
}

/** Ask one subnet whether it exists: gateway first, then the far end. */
async function subnetEvidence(
  base: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ host: string; latencyMs: number } | null> {
  for (const octet of EVIDENCE_HOSTS) {
    for (const port of EVIDENCE_PORTS) {
      const host = `${base}.${octet}`;
      const started = performance.now();
      const ok = await probeOnce(`http://${host}:${port}/`, timeoutMs, signal);
      if (ok)
        return { host: `${host}:${port}`, latencyMs: Math.round(performance.now() - started) };
      if (signal?.aborted) return null;
    }
  }
  return null;
}

/** One HTTP presence probe: any response (even an error page) counts as a responder. */
async function probeOnce(
  url: string,
  timeoutMs: number,
  ...signals: Array<AbortSignal | undefined>
): Promise<boolean> {
  const controller = new AbortController();
  const unlink: Array<() => void> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) controller.abort();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort);
    unlink.push(() => signal.removeEventListener('abort', onAbort));
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { method: 'GET', mode: 'no-cors', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    for (const off of unlink) off();
  }
}

export interface ScanLanOptions {
  /** Three-octet base, e.g. "192.168.1" — hosts .1 through .254 are probed. */
  base: string;
  ports: number[];
  timeoutMs?: number;
  /** How many HOSTS are swept at once (each host probes all its ports together). */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, hits: LanHit[]) => void;
  onHit?: (hit: LanHit) => void;
}

/**
 * Probe the grid with bounded parallelism. Every port of a host is attempted
 * at once and the first responder wins (the rest are cancelled); a host with
 * nothing on any port therefore costs ONE timeout instead of one per port.
 *
 * That single change is what makes the sweep usable. Trying ports in sequence
 * meant a dead host cost `ports.length × timeoutMs`, so a plain /24 against
 * the 11 known LLM ports spent ~6.6 s of worker time per empty address and ten
 * minutes of wall clock for a result the reader had already given up on. In
 * parallel it is ~0.6 s per empty address, i.e. a ~10 s sweep.
 */
export async function scanLan(options: ScanLanOptions): Promise<LanHit[]> {
  const { base, ports } = options;
  const timeoutMs = options.timeoutMs ?? 600;
  const concurrency = Math.max(1, options.concurrency ?? 12);
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
      const hit = await probeHost(host, ports, timeoutMs, options.signal);
      if (hit) {
        hits.push(hit);
        options.onHit?.(hit);
      }
      done++;
      options.onProgress?.(done, hosts.length, hits);
    }
  });
  await Promise.all(workers);
  return hits;
}

/** Race every port of one host; resolve with the BEST responder, else null. */
function probeHost(
  host: string,
  ports: number[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<LanHit | null> {
  return new Promise((resolve) => {
    const winner = new AbortController();
    const settledAt: boolean[] = ports.map(() => false);
    let settled = false;
    let done = 0;
    let bestIndex = Number.POSITIVE_INFINITY;
    let best: LanHit | null = null;
    const finish = (hit: LanHit | null) => {
      if (settled) return;
      settled = true;
      // Cancel the siblings we no longer care about.
      winner.abort();
      resolve(hit);
    };
    /** Finish with `best` once no higher-priority port can still answer. */
    const settleBest = () => {
      if (best === null) {
        if (done === ports.length) finish(null);
        return;
      }
      // A port EARLIER in the priority list may still answer (it is probed in
      // parallel): wait for it — bounded by its own probe timeout — instead of
      // resolving with the lower-priority responder that merely replied
      // faster. The ports are ordered by how likely they are to be an LLM
      // server, and first-responder-wins let a dev server on 8080 hide the
      // LLM on 1234, so the AI server vanished from the sweep.
      const stillPending = settledAt.slice(0, bestIndex).some((isSettled) => !isSettled);
      if (!stillPending) finish(best);
    };
    // NOTE: the outer `signal` is deliberately NOT wired into the individual
    // probes. Aborting a sweep used to cancel all ~130 in-flight sockets in the
    // same tick, and Chromium's network service then took seconds to recover —
    // long enough that an immediate rescan found nothing at all, including the
    // LLM server running on this very machine. Instead the workers stop
    // claiming new hosts at the abort boundary and the probes already in flight
    // expire on their own short timeout, so a cancelled sweep stops inside one
    // batch (≤ timeoutMs) without ever flooding the socket layer.
    void signal;
    if (ports.length === 0) return finish(null);
    ports.forEach((port, index) => {
      void probeOnce(`http://${host}:${port}/`, timeoutMs, winner.signal).then((ok) => {
        settledAt[index] = true;
        done++;
        if (settled) return;
        if (ok && index < bestIndex) {
          bestIndex = index;
          best = { host, port };
        }
        settleBest();
      });
    });
  });
}

/**
 * Identify a responder: CORS model-list probe with vendor guessing by port
 * (Ollama on 11434; everything else is treated as OpenAI-compatible — which
 * Ollama also serves at /v1, so both guesses work with the chat client).
 *
 * Retried once when the answer is "no response". We already KNOW something is
 * listening there — the presence probe that found this hit proved it — so
 * "no response" can only mean the identification request was lost, and the
 * usual cause is a browser still working through the backlog of a sweep in
 * progress. Reporting a live server as dead because of that is the worst
 * possible answer.
 */
export async function identifyLanServer(
  hit: LanHit,
  timeoutMs = 1800,
  retries = 1,
): Promise<LanServer> {
  const baseUrl = `http://${hit.host}:${hit.port}`;
  const vendor: EndpointVendor = hit.port === 11434 ? 'ollama' : 'openai-compat';
  let result = await probeCandidate(
    { id: 'lan', label: 'LAN server', baseUrl, vendor, note: '' },
    timeoutMs,
  );
  for (let attempt = 0; attempt < retries && result.status === 'absent'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    result = await probeCandidate(
      { id: 'lan', label: 'LAN server', baseUrl, vendor, note: '' },
      timeoutMs,
    );
  }
  return {
    host: hit.host,
    port: hit.port,
    baseUrl,
    models: result.models,
    vendor,
    corsOk: result.status === 'reachable',
    status: result.status,
    latencyMs: result.latencyMs,
    detail: result.detail,
  };
}
