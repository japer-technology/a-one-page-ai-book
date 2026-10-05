/**
 * llm/endpoints.ts — the catalog of known local LLM servers.
 *
 * Discovery probes these well-known localhost ports. Everything here is pure
 * data + small parsers, so it is unit-testable without a browser.
 */
import type { EndpointVendor } from '../core/types';

export interface EndpointCandidate {
  id: string;
  label: string;
  baseUrl: string;
  vendor: EndpointVendor;
  note: string;
}

/** Well-known local inference servers, most common first. */
export const CANDIDATES: EndpointCandidate[] = [
  {
    id: 'lmstudio',
    label: 'LM Studio',
    baseUrl: 'http://127.0.0.1:1234',
    vendor: 'openai-compat',
    note: 'LM Studio Local Server',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434',
    vendor: 'ollama',
    note: 'ollama serve',
  },
  {
    id: 'llamacpp-8080',
    label: 'llama.cpp server',
    baseUrl: 'http://127.0.0.1:8080',
    vendor: 'openai-compat',
    note: 'llama-server --port 8080 (also LocalAI / llamafile default port)',
  },
  {
    id: 'llamacpp-8081',
    label: 'llama.cpp server',
    baseUrl: 'http://127.0.0.1:8081',
    vendor: 'openai-compat',
    note: 'llama-server --port 8081',
  },
  {
    id: 'koboldcpp',
    label: 'KoboldCpp',
    baseUrl: 'http://127.0.0.1:5001',
    vendor: 'openai-compat',
    note: 'KoboldCpp API port',
  },
  {
    id: 'textgen-webui',
    label: 'text-generation-webui',
    baseUrl: 'http://127.0.0.1:5000',
    vendor: 'openai-compat',
    note: '--api flag',
  },
  {
    id: 'gpt4all',
    label: 'GPT4All',
    baseUrl: 'http://127.0.0.1:4891',
    vendor: 'openai-compat',
    note: 'GPT4All local API server',
  },
  {
    id: 'vllm',
    label: 'vLLM',
    baseUrl: 'http://127.0.0.1:8000',
    vendor: 'openai-compat',
    note: 'vllm serve',
  },
  {
    id: 'jan',
    label: 'Jan (Local API Server)',
    baseUrl: 'http://127.0.0.1:1337',
    vendor: 'openai-compat',
    note: 'Jan Local API Server',
  },
  {
    id: 'anythingllm',
    label: 'AnythingLLM (Local AI)',
    baseUrl: 'http://127.0.0.1:3001',
    vendor: 'openai-compat',
    note: 'AnythingLLM local API',
  },
  {
    id: 'msty',
    label: 'Msty (Local API)',
    baseUrl: 'http://127.0.0.1:10000',
    vendor: 'openai-compat',
    note: 'Msty OpenAI-compatible API',
  },
];

/** URLs to probe for a candidate, in order. */
export function modelListUrls(candidate: EndpointCandidate): string[] {
  if (candidate.vendor === 'ollama') {
    return [`${candidate.baseUrl}/api/tags`, `${candidate.baseUrl}/v1/models`];
  }
  return [`${candidate.baseUrl}/v1/models`];
}

export function parseOllamaTags(json: unknown): string[] {
  if (json && typeof json === 'object' && Array.isArray((json as { models?: unknown }).models)) {
    return ((json as { models: Array<{ name?: unknown }> }).models ?? [])
      .map((m) => (typeof m.name === 'string' ? m.name : ''))
      .filter((n) => n.length > 0)
      .sort();
  }
  return [];
}

export function parseOpenAIModels(json: unknown): string[] {
  if (json && typeof json === 'object' && Array.isArray((json as { data?: unknown }).data)) {
    return ((json as { data: Array<{ id?: unknown }> }).data ?? [])
      .map((m) => (typeof m.id === 'string' ? m.id : ''))
      .filter((n) => n.length > 0)
      .sort();
  }
  return [];
}

/** Parse a models response according to the candidate's vendor. */
export function parseModelsResponse(vendor: EndpointVendor, json: unknown): string[] {
  if (vendor === 'ollama') {
    const tags = parseOllamaTags(json);
    return tags.length > 0 ? tags : parseOpenAIModels(json);
  }
  return parseOpenAIModels(json);
}

/** "http://127.0.0.1:1234/v1/" -> "http://127.0.0.1:1234" (keeps deeper path prefixes). */
export function normalizeBaseUrl(input: string): string {
  let url = input.trim();
  // Also strip a full endpoint path pasted from server docs or another app
  // ('…/v1/chat/completions', '…/v1/models', Ollama's '…/api/chat'): the chat
  // client appends its own '/v1/chat/completions', so the pasted path used to
  // double and every request 404'd while the address visibly pointed at the
  // right server. Loop until stable so '/v1/chat/completions/' or
  // '/api/chat/v1' collapse all the way down.
  for (let guard = 0; guard < 6; guard++) {
    const before = url;
    url = url.replace(/\/+$/, '');
    url = url.replace(
      /\/(?:v1\/)?(?:chat\/completions|completions|models|embeddings|chat|generate)$/i,
      '',
    );
    url = url.replace(/\/api\/?(?:chat|tags|generate|embed)?$/i, '');
    url = url.replace(/(?:\/v1)+$/i, '');
    url = url.replace(/\/+$/, '');
    if (url === before) break;
  }
  return url;
}

/**
 * A human-readable problem with a base URL, or null when it is usable. Covers
 * the shapes `fetch()` itself refuses (credentials, a trailing colon): the
 * request never leaves the browser, but the raw TypeError the reader then saw
 * ("Failed to fetch") named nothing they could fix.
 */
export function baseUrlProblem(input: string): string | null {
  const url = normalizeBaseUrl(input);
  if (!/^https?:\/\/[^/]+/i.test(url)) {
    return 'Enter the server’s full URL first, e.g. http://127.0.0.1:1234';
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'That does not look like a valid URL — check for a stray colon or space.';
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return 'The URL must not contain a username or password.';
  }
  return null;
}

/**
 * A base URL safe for logs, toasts and audit entries: drops any userinfo
 * (`user:password@`) and query string, which are otherwise interpolated
 * verbatim into the app's shareable diagnostics. Generation still uses the
 * full, unredacted URL.
 */
export function redactUrl(input: string): string {
  const cleaned = normalizeBaseUrl(input);
  try {
    const url = new URL(cleaned);
    url.username = '';
    url.password = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return cleaned.replace(/\/\/[^/@]*@/, '//');
  }
}

export function vendorName(vendor: EndpointVendor): string {
  return vendor === 'ollama' ? 'Ollama (native)' : 'OpenAI-compatible';
}

/** Presets for manual entry — one per candidate, for the Base URL datalist. */
export function presetBaseUrls(): Array<{ label: string; url: string }> {
  return CANDIDATES.map((c) => ({
    label: `${c.label} · ${c.baseUrl.replace('http://127.0.0.1:', ':')}`,
    url: c.baseUrl,
  }));
}

/** The ports the catalog knows about, in popularity order — the LAN-scan grid uses these. */
export function llmPorts(): number[] {
  const ports: number[] = [];
  for (const candidate of CANDIDATES) {
    try {
      const port = Number(new URL(candidate.baseUrl).port);
      // Number('') === 0 — a portless entry would silently add port 0 to the
      // scan grid and the "on N ports" copy.
      if (Number.isInteger(port) && port > 0 && port < 65536 && !ports.includes(port)) {
        ports.push(port);
      }
    } catch {
      // skip malformed URLs
    }
  }
  return ports;
}

/**
 * The ports worth trying on every address of a subnet, in order.
 *
 * A network sweep is `hosts × ports` connect attempts, and a browser handles a
 * few thousand of those badly: Chromium's network service queues them, and an
 * unrelated request made right afterwards — including the app's own "test the
 * endpoint" call — can sit behind a backlog of abandoned connects for many
 * seconds. Wall time does not change (ports are raced per host rather than
 * tried in sequence), but halving the attempt count halves that backlog.
 *
 * These six cover LM Studio, Ollama, llama.cpp, vLLM, text-generation-webui and
 * KoboldCpp — the overwhelming majority of LAN servers. The rest are one
 * checkbox away in Settings.
 */
const COMMON_PORTS = [1234, 11434, 8080, 8000, 5000, 5001];

export function commonLlmPorts(): number[] {
  const all = llmPorts();
  return COMMON_PORTS.filter((port) => all.includes(port));
}

/**
 * Never a story-writing model, whatever else the name says. A server that
 * reports `text-embedding-nomic-embed-text-v1.5` FIRST (LM Studio lists
 * alphabetically, so it usually does) must not have it chosen for the reader.
 */
const NOT_A_WRITER =
  /embed|rerank|cross-encoder|\bbge\b|nomic-embed|whisper|tts|speech|clip|moderation|guard|\bsafety\b/i;

/**
 * Score a model name for "how good is this as the writer of a book?".
 *
 * Pure and deterministic, because it makes a user-visible decision: the model
 * the app pre-selects. The old default was `models[0]` of an alphabetically
 * sorted list, which on a typical LM Studio install picks the *embedding*
 * model, and on any install picks whatever sorts first rather than the
 * biggest, newest instruct model.
 */
export function modelScore(name: string): number {
  const lower = name.toLowerCase();
  let score = 0;

  // Parameter count in billions: the single strongest signal of writing
  // quality. "7b" beats "3b"; "70B" beats "13b".
  const size = lower.match(/(?:^|[^0-9.])(\d+(?:\.\d+)?)\s*b(?:[^a-z0-9]|$)/);
  if (size?.[1]) score += Math.min(200, Number(size[1]) * 4);

  // Tuned for instruction following — what this app needs.
  if (/instruct|-it\b|_it\b|chat|assistant/.test(lower)) score += 40;
  if (/qwen|llama|mistral|gemma|phi|deepseek|hermes|command-r|yi-|falcon|mixtral/.test(lower)) {
    score += 6;
  }
  // Completing raw text is not the same skill as following a page-turn brief.
  if (/[-_.]base\b|pretrain/.test(lower)) score -= 30;
  // Code models write stiff prose.
  if (/coder|code-|[-_]code\b|starcoder/.test(lower)) score -= 12;
  // Multimodal models spend their budget on tokens they will never see here.
  if (/vision|llava|[-_]vl\b|pixtral|multimodal/.test(lower)) score -= 8;
  // Quantization format hints: prefer the cleaner artifact when all else ties.
  if (/q4_k_m|q5_k_m|q6_k|q8_0|fp16|f16/.test(lower)) score += 2;
  // "-latest" is an alias; a pinned tag is a deliberate choice.
  if (/latest/.test(lower)) score += 1;

  return score;
}

/** Model names, best writer first. Stable for equal scores (alphabetical). */
export function rankModels(models: readonly string[]): string[] {
  return [...models].sort((a, b) => {
    const difference = modelScore(b) - modelScore(a);
    return difference !== 0 ? difference : a.localeCompare(b);
  });
}

/**
 * The model to pre-select for a freshly discovered server. Filters out the
 * names that are definitively not chat models; falls back to the plain
 * ranking when a server only reports such names (better a warning later than
 * an empty picker now).
 */
export function pickBestModel(models: readonly string[]): string {
  const usable = models.filter((m) => !NOT_A_WRITER.test(m));
  const ranked = rankModels(usable);
  return ranked[0] ?? rankModels(models)[0] ?? '';
}

/** A short, human hint about a model name, for picker labels ("7B", "coder"). */
export function modelTraits(name: string): string {
  const lower = name.toLowerCase();
  const traits: string[] = [];
  const size = lower.match(/(?:^|[^0-9.])(\d+(?:\.\d+)?)\s*b(?:[^a-z0-9]|$)/);
  if (size?.[1]) traits.push(`${size[1]}B`);
  if (NOT_A_WRITER.test(name)) traits.push('not for writing');
  else if (/coder|code-|[-_]code\b|starcoder/.test(lower)) traits.push('code-tuned');
  else if (/vision|llava|[-_]vl\b|pixtral/.test(lower)) traits.push('multimodal');
  else if (/instruct|-it\b|chat|assistant/.test(lower)) traits.push('instruct');
  return traits.join(' · ');
}
