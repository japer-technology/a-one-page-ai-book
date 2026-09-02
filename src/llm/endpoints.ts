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
    note: 'llama-server --port 8080',
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
    id: 'localai',
    label: 'LocalAI',
    baseUrl: 'http://127.0.0.1:8080',
    vendor: 'openai-compat',
    note: 'LocalAI default port',
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

/** "http://127.0.0.1:1234/v1/" -> "http://127.0.0.1:1234" */
export function normalizeBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function vendorName(vendor: EndpointVendor): string {
  return vendor === 'ollama' ? 'Ollama (native)' : 'OpenAI-compatible';
}
