import { describe, expect, it } from 'vitest';
import {
  baseUrlProblem,
  CANDIDATES,
  commonLlmPorts,
  llmPorts,
  modelListUrls,
  modelScore,
  modelTraits,
  normalizeBaseUrl,
  parseModelsResponse,
  parseOllamaTags,
  parseOpenAIModels,
  pickBestModel,
  rankModels,
  vendorName,
} from '../src/llm/endpoints';

describe('endpoint catalog', () => {
  it('covers the well-known local servers', () => {
    const labels = CANDIDATES.map((c) => c.label);
    expect(labels).toContain('LM Studio');
    expect(labels).toContain('Ollama');
    expect(labels.some((l) => l.includes('llama.cpp'))).toBe(true);
    expect(labels.some((l) => l.includes('KoboldCpp'))).toBe(true);
  });

  it('gives Ollama two probe URLs and OpenAI-compat one', () => {
    const ollama = CANDIDATES.find((c) => c.vendor === 'ollama');
    const lmstudio = CANDIDATES.find((c) => c.id === 'lmstudio');
    expect(ollama && modelListUrls(ollama)).toContain('http://127.0.0.1:11434/api/tags');
    expect(lmstudio && modelListUrls(lmstudio)).toEqual(['http://127.0.0.1:1234/v1/models']);
  });

  it('normalizes base urls', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:1234/v1/')).toBe('http://127.0.0.1:1234');
    expect(normalizeBaseUrl('  http://x:1//  ')).toBe('http://x:1');
    // Repeated/upper-case version segments must all go — otherwise the client
    // would post to /v1/v1/chat/completions and 404 on every generation.
    expect(normalizeBaseUrl('http://x:1/v1/v1')).toBe('http://x:1');
    expect(normalizeBaseUrl('http://x:1/V1')).toBe('http://x:1');
    // A deeper path prefix is kept; only the trailing version segment drops.
    expect(normalizeBaseUrl('http://x:1/proxy/path/v1')).toBe('http://x:1/proxy/path');
  });
});

describe('model list parsers', () => {
  it('parses Ollama /api/tags', () => {
    expect(parseOllamaTags({ models: [{ name: 'llama3.2:3b' }, { name: 'qwen2.5:7b' }] })).toEqual([
      'llama3.2:3b',
      'qwen2.5:7b',
    ]);
  });

  it('parses OpenAI-compatible /v1/models', () => {
    expect(parseOpenAIModels({ data: [{ id: 'model-a' }, { id: 'model-b' }] })).toEqual([
      'model-a',
      'model-b',
    ]);
  });

  it('falls back between dialects for ollama', () => {
    expect(parseModelsResponse('ollama', { data: [{ id: 'x' }] })).toEqual(['x']);
    expect(parseModelsResponse('ollama', { models: [{ name: 'y' }] })).toEqual(['y']);
    expect(parseModelsResponse('openai-compat', { data: [{ id: 'z' }] })).toEqual(['z']);
  });

  it('ignores malformed payloads', () => {
    expect(parseOllamaTags({ nope: true })).toEqual([]);
    expect(parseOpenAIModels(null)).toEqual([]);
  });
});

describe('vendor names', () => {
  it('labels dialects for humans', () => {
    expect(vendorName('ollama')).toBe('Ollama (native)');
    expect(vendorName('openai-compat')).toBe('OpenAI-compatible');
  });
});

describe('picking the model to preselect', () => {
  it('never preselects an embedding model, even when it sorts first', () => {
    // A stock LM Studio install reports these alphabetically; the old
    // "models[0]" default therefore chose the embedding model for the reader.
    const models = ['text-embedding-nomic-embed-text-v1.5', 'qwen2.5-7b-instruct'];
    expect(pickBestModel(models)).toBe('qwen2.5-7b-instruct');
  });

  it('prefers the bigger model when nothing else separates them', () => {
    expect(pickBestModel(['mock-poet-3b', 'mock-storyteller-7b'])).toBe('mock-storyteller-7b');
    expect(pickBestModel(['llama-3.2-3b', 'llama-3.1-8b-instruct'])).toBe('llama-3.1-8b-instruct');
  });

  it('prefers an instruct tune over a raw base model of the same size', () => {
    expect(pickBestModel(['mistral-7b-base', 'mistral-7b-instruct'])).toBe('mistral-7b-instruct');
  });

  it('rates a code model below a general one of the same size', () => {
    expect(pickBestModel(['qwen2.5-coder-7b', 'qwen2.5-7b'])).toBe('qwen2.5-7b');
  });

  it('falls back to the plain ranking when every model is unusable', () => {
    // Better a warning later than an empty picker now.
    expect(pickBestModel(['bge-m3', 'nomic-embed-text'])).toBe('bge-m3');
  });

  it('returns an empty string for no models at all', () => {
    expect(pickBestModel([])).toBe('');
    expect(rankModels([])).toEqual([]);
  });

  it('is stable for equal scores', () => {
    expect(rankModels(['b-model', 'a-model'])).toEqual(['a-model', 'b-model']);
  });

  it('scores a 70B instruct model above a 3B one', () => {
    expect(modelScore('llama-3.3-70b-instruct')).toBeGreaterThan(modelScore('llama-3.2-3b'));
  });

  it('describes a model for the picker label', () => {
    expect(modelTraits('qwen2.5-7b-instruct')).toContain('7B');
    expect(modelTraits('qwen2.5-7b-instruct')).toContain('instruct');
    expect(modelTraits('nomic-embed-text')).toBe('not for writing');
    expect(modelTraits('qwen2.5-coder-7b')).toBe('7B · code-tuned');
    expect(modelTraits('mystery-model')).toBe('');
  });
});

describe('LLM port sets', () => {
  it('offers a short common set that is a subset of the full one', () => {
    const common = commonLlmPorts();
    expect(common.length).toBeGreaterThan(0);
    expect(common.length).toBeLessThan(llmPorts().length);
    for (const port of common) expect(llmPorts()).toContain(port);
    // The two that matter most are in the short list.
    expect(common).toContain(1234);
    expect(common).toContain(11434);
  });
});

describe('normalizeBaseUrl endpoint paths', () => {
  it('strips a pasted full endpoint path', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:1234/v1/chat/completions')).toBe(
      'http://127.0.0.1:1234',
    );
    expect(normalizeBaseUrl('http://127.0.0.1:1234/v1/models/')).toBe('http://127.0.0.1:1234');
    expect(normalizeBaseUrl('http://127.0.0.1:1234/chat/completions')).toBe(
      'http://127.0.0.1:1234',
    );
    expect(normalizeBaseUrl('http://127.0.0.1:11434/api/chat')).toBe('http://127.0.0.1:11434');
    expect(normalizeBaseUrl('http://127.0.0.1:11434/api/tags')).toBe('http://127.0.0.1:11434');
  });

  it('collapses the endpoint path and a trailing /v1 together', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:1234/v1/chat/completions/')).toBe(
      'http://127.0.0.1:1234',
    );
    expect(normalizeBaseUrl('http://127.0.0.1:1234/v1/')).toBe('http://127.0.0.1:1234');
  });

  it('keeps a deeper path prefix that is not an endpoint', () => {
    expect(normalizeBaseUrl('http://proxy.local:8080/llm/v1')).toBe('http://proxy.local:8080/llm');
    expect(normalizeBaseUrl('http://proxy.local:8080/llm')).toBe('http://proxy.local:8080/llm');
  });
});

describe('baseUrlProblem', () => {
  it('accepts plain local URLs', () => {
    expect(baseUrlProblem('http://127.0.0.1:1234')).toBeNull();
    expect(baseUrlProblem('http://127.0.0.1:1234/v1')).toBeNull();
    expect(baseUrlProblem('http://127.0.0.1:11434/api/chat')).toBeNull();
  });

  it('rejects credentials and malformed URLs with a readable reason', () => {
    expect(baseUrlProblem('http://127.0.0.1:1234@evil.example:9000')).toMatch(
      /username or password/,
    );
    expect(baseUrlProblem('http://user:pass@127.0.0.1:1234')).toMatch(/username or password/);
    expect(baseUrlProblem('http://127.0.0.1:1234:')).toMatch(/valid URL/);
  });

  it('still asks for a server first', () => {
    expect(baseUrlProblem('')).toMatch(/full URL first/);
    expect(baseUrlProblem('127.0.0.1:1234')).toMatch(/full URL first/);
  });
});
