// E2E fixture: TWO mock local LLM servers.
//   127.0.0.1:1234  — OpenAI-compatible (LM Studio style), SSE streaming
//   127.0.0.1:11434 — Ollama native (/api/tags + /api/chat), NDJSON streaming
// Content logic: test phrase → "OK"; titles prompt → JSON titles; suggestions
// prompt → JSON strings; everything else → a fixed story sentence. Streams are
// chunked so the client must reassemble tokens exactly as in real life.
import { createServer } from 'node:http';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, accept',
};

function pickContent(messages) {
  const joined = JSON.stringify(messages ?? []);
  if (/Reply with exactly: OK/.test(joined)) return 'OK';
  if (/JSON array of 5 objects/.test(joined)) {
    return JSON.stringify([
      { title: 'The Dead Letter', tagline: 'A story of salt and secrets' },
      { title: 'The Keeper’s Grandson', tagline: 'What the fog brought back' },
      { title: 'Low Tide', tagline: 'The sea keeps what it takes' },
      { title: 'The Wax Seal', tagline: 'Some letters wait a century' },
      { title: 'Lantern Light', tagline: 'Every light casts a shadow' },
    ]);
  }
  if (/JSON array of strings/.test(joined)) {
    return JSON.stringify([
      'The keeper opens the letter that night',
      'A fog rolls in and the light fails',
      'A stranger arrives by boat',
    ]);
  }
  return 'The letter, still warm from the wax seal, waited on the keeper’s desk.';
}

function chunks(text, count) {
  const size = Math.max(1, Math.ceil(text.length / count));
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

// ---- OpenAI-compatible server (1234) ---------------------------------------
createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json', ...CORS });
    res.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'mock-storyteller-7b' }, { id: 'mock-poet-3b' }],
      }),
    );
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    const parsed = JSON.parse(await readBody(req));
    const content = pickContent(parsed.messages);
    if (parsed.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', ...CORS });
      for (const piece of chunks(content, 4)) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json', ...CORS });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    }
    return;
  }
  res.writeHead(404, CORS);
  res.end('not found');
}).listen(1234, '127.0.0.1', () => console.log('mock openai-compat on 1234'));

// ---- Ollama native server (11434) ------------------------------------------
createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url === '/api/tags') {
    res.writeHead(200, { 'content-type': 'application/json', ...CORS });
    res.end(JSON.stringify({ models: [{ name: 'mock-ollama-7b' }] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/chat') {
    const parsed = JSON.parse(await readBody(req));
    const content = pickContent(parsed.messages);
    if (parsed.stream) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson', ...CORS });
      for (const piece of chunks(content, 3)) {
        res.write(
          JSON.stringify({
            model: parsed.model,
            message: { role: 'assistant', content: piece },
            done: false,
          }) + '\n',
        );
      }
      res.write(
        JSON.stringify({
          model: parsed.model,
          message: { role: 'assistant', content: '' },
          done: true,
        }) + '\n',
      );
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json', ...CORS });
      res.end(JSON.stringify({ message: { role: 'assistant', content } }));
    }
    return;
  }
  res.writeHead(404, CORS);
  res.end('not found');
}).listen(11434, '127.0.0.1', () => console.log('mock ollama on 11434'));
