// E2E fixture: TWO mock local LLM servers.
//   127.0.0.1:1234  — OpenAI-compatible (LM Studio style), SSE streaming
//   127.0.0.1:11434 — Ollama native (/api/tags + /api/chat), NDJSON streaming
// Content logic: test phrase → "OK"; titles prompt → JSON titles; suggestions
// prompt → JSON strings; everything else → a fixed story sentence. Streams are
// chunked so the client must reassemble tokens exactly as in real life.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, accept',
};

function pickContent(messages) {
  const joined = JSON.stringify(messages ?? []);
  if (/Reply with exactly: OK/.test(joined)) return 'OK';
  if (/JSON array of 5 objects/.test(joined)) {
    // Each "Propose 5 more" walks to the NEXT batch — the way a real model
    // offers fresh titles instead of repeating itself. (The app dedupes
    // overlapping batches; identical batches would yield no new cards.)
    const batch = TITLE_BATCHES[titleBatches++ % TITLE_BATCHES.length];
    return JSON.stringify(batch);
  }
  // "I'm feeling lucky": the model proposes the story seeds.
  if (/different story SEEDS/.test(joined)) {
    return JSON.stringify([
      'A cartographer discovers her own house on a map she has never drawn.',
      'The last lighthouse on Mars keeps a log of ships that never sailed.',
      'A debt collector for the dead knocks on the wrong door.',
      'Every library book returns itself, one day early.',
      'A retired astronaut teaches swimming to children who have never seen the sea.',
    ]);
  }
  // The living-cast / rolling-summary upkeep call: one JSON object.
  if (/Maintain the living cast and rolling summary/.test(joined)) {
    if (BAD_JSON) return 'I am afraid I cannot produce JSON for this story.';
    return JSON.stringify({
      people: [{ name: 'Elin Marr', note: 'the lighthouse keeper' }],
      places: [{ name: 'the lighthouse', note: 'where the letter arrived' }],
      things: [{ name: 'the letter', note: 'addressed to the dead' }],
      threads: [{ name: 'the letter’s sender', note: 'who wrote it, and why' }],
      relations: [{ from: 'Elin Marr', to: 'the letter', kind: 'keeper of' }],
      summary:
        'Elin Marr keeps a lighthouse and has found a letter addressed to someone a hundred years dead. The letter waits on her desk.',
    });
  }
  // The rolling-summary-only memory call: plain prose.
  if (/memory engine of Page Turn/.test(joined)) {
    return 'Elin Marr keeps a lighthouse and has found a letter addressed to someone a hundred years dead. The letter waits on her desk, still warm from its wax seal.';
  }
  if (/Distill it into a story brief/.test(joined)) {
    return 'A quiet gothic mystery about a lighthouse keeper and a letter addressed to someone long dead.';
  }
  if (/propose 3 distinct possible endings/i.test(joined)) {
    return JSON.stringify([
      { title: 'Low Tide', premise: 'The letter is finally answered by the sea.' },
      { title: 'The Light Goes Out', premise: 'Elin chooses the living over the dead.' },
      { title: 'A Second Letter', premise: 'A reply arrives, in her own hand.' },
    ]);
  }
  // The conflict checker: no contradictions.
  if (/Check it against everything established/.test(joined)) return JSON.stringify([]);
  if (/JSON array of strings/.test(joined)) {
    return JSON.stringify([
      'The keeper opens the letter that night',
      'A fog rolls in and the light fails',
      'A stranger arrives by boat',
    ]);
  }
  if (/writing-partner engine of Page Turn/.test(joined)) {
    return 'Who is the letter for, and what would it cost Elin to answer it?';
  }
  return 'The letter, still warm from the wax seal, waited on the keeper’s desk.';
}

function chunks(text, count) {
  const size = Math.max(1, Math.ceil(text.length / count));
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Successive title batches — "Propose 5 more" must show fresh titles. */
let titleBatches = 0;
const TITLE_BATCHES = [
  [
    { title: 'The Dead Letter', tagline: 'A story of salt and secrets' },
    { title: 'The Keeper’s Grandson', tagline: 'What the fog brought back' },
    { title: 'Low Tide', tagline: 'The sea keeps what it takes' },
    { title: 'The Wax Seal', tagline: 'Some letters wait a century' },
    { title: 'Lantern Light', tagline: 'Every light casts a shadow' },
  ],
  [
    { title: 'The Salt Road', tagline: 'Every step erases the last' },
    { title: 'A Map of Small Losses', tagline: 'Some borders are drawn in grief' },
    { title: 'The Harbour Bell', tagline: 'It rings only for the missing' },
    { title: 'Nightwater', tagline: 'What the dark keeps, it keeps for good' },
    { title: 'The Second Keeper', tagline: 'One light, two shadows' },
  ],
];

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

/**
 * PT_MOCK_SERIAL=1 emulates the default configuration of LM Studio, llama.cpp
 * (-np 1) and older Ollama builds: ONE generation slot. A second concurrent
 * request is rejected with 429 instead of being queued, which is exactly how
 * these servers behave — and exactly what a client that fires two requests at
 * once will run into.
 */
const SERIAL = process.env.PT_MOCK_SERIAL === '1';
/**
 * PT_MOCK_BAD_JSON=1 makes the cast/summary upkeep prompts answer with prose
 * instead of JSON — what a small local model that ignores the JSON instruction
 * actually does. Used to check how a failed background upkeep is reported.
 */
const BAD_JSON = process.env.PT_MOCK_BAD_JSON === '1';
/**
 * PT_MOCK_LOG=<path> appends one JSON line per chat request: how long the
 * message CHAIN was, how big the prompt was, and whether it streamed. Used to
 * measure what the app actually sends over a long session.
 */
const LOG_PATH = process.env.PT_MOCK_LOG ?? '';
const inFlightByPort = new Map();

function logRequest(port, parsed) {
  if (!LOG_PATH) return;
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const chars = messages.reduce((sum, m) => sum + String(m?.content ?? '').length, 0);
  try {
    appendFileSync(
      LOG_PATH,
      `${JSON.stringify({
        t: Date.now(),
        port,
        model: parsed?.model ?? '',
        stream: parsed?.stream === true,
        messages: messages.length,
        chars,
        system: String(messages[0]?.content ?? '').slice(0, 40),
      })}\n`,
    );
  } catch {
    // logging is best-effort
  }
}

function acquireSlot(port) {
  const current = inFlightByPort.get(port) ?? 0;
  if (SERIAL && current > 0) return false;
  inFlightByPort.set(port, current + 1);
  return true;
}
function releaseSlot(port) {
  inFlightByPort.set(port, Math.max(0, (inFlightByPort.get(port) ?? 1) - 1));
}
async function serialBusy(res) {
  res.writeHead(429, { 'content-type': 'application/json', ...CORS });
  res.end(
    JSON.stringify({
      error: { message: 'Only one request at a time is allowed on this server.' },
    }),
  );
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
    if (!acquireSlot(1234)) return serialBusy(res);
    try {
      const parsed = JSON.parse(await readBody(req));
      logRequest(1234, parsed);
      const content = pickContent(parsed.messages);
      // A little dwell time, so two requests fired in the same tick really do
      // overlap the way they do against a real single-slot server.
      await new Promise((r) => setTimeout(r, SERIAL ? 60 : 0));
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
    } finally {
      releaseSlot(1234);
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
    if (!acquireSlot(11434)) return serialBusy(res);
    try {
      const parsed = JSON.parse(await readBody(req));
      logRequest(11434, parsed);
      const content = pickContent(parsed.messages);
      await new Promise((r) => setTimeout(r, SERIAL ? 60 : 0));
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
    } finally {
      releaseSlot(11434);
    }
    return;
  }
  res.writeHead(404, CORS);
  res.end('not found');
}).listen(11434, '127.0.0.1', () => console.log('mock ollama on 11434'));
