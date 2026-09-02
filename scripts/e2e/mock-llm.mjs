// E2E fixture: a mock LM Studio-style OpenAI-compatible server on port 1234.
// Used by scripts/e2e to verify scan → model selection → generation in a real browser.
import { createServer } from 'node:http';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, accept',
};

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/api/tags')) {
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
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json', ...CORS });
      const reply = parsed.messages?.some((m) => /Reply with exactly: OK/.test(m.content))
        ? 'OK'
        : 'The letter, still warm from the wax seal, waited on the keeper’s desk.';
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }));
    });
    return;
  }
  res.writeHead(404, CORS);
  res.end('not found');
});

server.listen(1234, '127.0.0.1', () => console.log('mock-llm listening on 1234'));
