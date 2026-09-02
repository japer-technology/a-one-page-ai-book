import { describe, expect, it } from 'vitest';
import {
  CANDIDATES,
  modelListUrls,
  normalizeBaseUrl,
  parseModelsResponse,
  parseOllamaTags,
  parseOpenAIModels,
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
