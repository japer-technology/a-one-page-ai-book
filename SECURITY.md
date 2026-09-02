# Security

Page Turn is a **local-first** application: no accounts, no servers, no analytics, no telemetry.
This document explains the trust model and the security decisions behind it.

## Where your data lives and travels

- **Your story data never leaves your machine**, with one deliberate exception: the text you ask to
  generate (and nothing else) is sent to the **local LLM endpoint you configure**
  (`http://127.0.0.1:…` by default). If you point the endpoint at a remote host, that host receives
  your prompts — the same as any LLM client.
- **Storage** is local: IndexedDB plus an OPFS workspace file in your browser profile, and whatever
  files you explicitly export via save dialogs or downloads.
- **No third-party resources** are loaded at runtime: the built single file makes zero external
  requests (no CDN, no fonts, no analytics).

## Threat model notes

- **The generated story is untrusted input.** Page text, titles, and directions are rendered as
  plain text nodes only — LLM output can never inject HTML or scripts into the page. Treat every
  local model (and any fine-tuned model you install) accordingly.
- **Prompt injection:** a seed or story page could contain text that instructs the model to ignore
  the system prompt ("disregard previous instructions…"). Impact is bounded: the worst case is a
  page that reads oddly or returns malformed JSON — both of which the UI surfaces as retryable
  errors. Nothing the model says can write files, change settings, or exfiltrate data, because the
  model's only channel is the returned text.
- **CORS is the browser's boundary, not ours.** Discovery deliberately distinguishes "server
  reachable" from "server reachable but refusing this origin," and never attempts to bypass CORS (a
  web page cannot and should not). If your server blocks the app's origin, fix it on the server side
  (enable CORS for localhost origins, or open Page Turn from a localhost URL).
- **File System Access API** is only invoked from explicit user gestures (button clicks). Downloads
  and imports behave exactly as any browser download/upload would.

## Export formats

- `.ptlibrary.json` / `.ptbook.json` are plain JSON containing your story text and generation
  metadata. Treat them like any document: do not share them if the content is sensitive.
- `.txt` / `.md` exports contain the compiled book and its seed.

## Reporting a vulnerability

If you find a security issue — especially anything that would let story content escape the text-node
rendering boundary or persist without user intent — please report it privately to the maintainers
via GitHub's
["Report a vulnerability"](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
flow on this repository rather than opening a public issue. We aim to acknowledge within a week.

No vulnerability bounties are offered; this is a community project.
