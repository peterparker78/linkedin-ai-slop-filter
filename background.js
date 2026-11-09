// Background service worker: talks to the local Ollama server (and, as a
// backup, the Claude API) so requests originate from the extension
// (chrome-extension://) rather than linkedin.com.

const OLLAMA_URL = 'http://localhost:11434';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-opus-5';
const MAX_QUEUE = 10; // beyond this, borderline posts are just left visible

// Allow content scripts to read/write session stats.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

const SYSTEM_PROMPT = `You classify LinkedIn posts as AI-generated or human-written.

Signs of AI generation: generic motivational tone, formulaic hook-then-listicle structure, clichéd phrases ("game-changer", "let that sink in", "in today's fast-paced world"), emoji bullet lists, engagement-bait closers ("Agree?", "Thoughts?"), polished but substanceless prose, "it's not X, it's Y" constructions. Also the "numbered-slash listicle" dialect: a money/metric hook line, "Here's what X actually...", numbered points as "1/ 2/ 3/", arrow lines ("→ ..."), and a punchy two-line contrast closer ("Everyone wants X. The winners do Y."). Treat that structure as strong evidence of AI generation even when no cliché phrases appear.

Signs of human writing: specific personal details, imperfect grammar, niche technical content, genuine specificity about events/people/numbers, distinctive voice.

Respond ONLY with JSON: {"ai_generated": true or false, "confidence": 0.0 to 1.0}`;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'classify') {
    enqueueClassify(message).then(sendResponse);
    return true; // keep the channel open for the async response
  }
  if (message.type === 'ollamaStatus') {
    checkStatus().then(sendResponse);
    return true;
  }
  if (message.type === 'pickState' && sender.tab) {
    // Toolbar badge while click-to-hide is active in that tab.
    const tabId = sender.tab.id;
    chrome.action.setBadgeText({ tabId, text: message.on ? 'HIDE' : '' });
    if (message.on) chrome.action.setBadgeBackgroundColor({ tabId, color: '#ff3b30' });
    sendResponse({ ok: true });
  }
});

// Ollama on localhost processes one request at a time anyway; running
// classifications sequentially stops a fast scroll from firing a dozen
// concurrent requests that all burn their timeout waiting on each other.
// In-flight requests are deduped by post URN (LinkedIn re-renders feed
// nodes, so the same post can be requested twice while pending).
const inFlight = new Map(); // urn -> Promise<verdict>
let queueTail = Promise.resolve();
let queueLength = 0;

function enqueueClassify(message) {
  const key = message.urn || message.text;
  if (inFlight.has(key)) return inFlight.get(key);
  if (queueLength >= MAX_QUEUE) {
    return Promise.resolve({ verdict: 'error', detail: 'queue full' });
  }
  queueLength += 1;
  const job = queueTail
    .then(() => classify(message))
    .finally(() => {
      queueLength -= 1;
      inFlight.delete(key);
    });
  queueTail = job.catch(() => {});
  inFlight.set(key, job);
  return job;
}

function userPrompt({ text, score, signals }) {
  const signalNote =
    score != null
      ? `Local heuristics scored this post ${score}/100 (borderline). Signals: ${
          signals && signals.length ? signals.join(', ') : 'none'
        }.\n\n`
      : '';
  return `Classify this LinkedIn post.\n\n${signalNote}Post:\n\n${text}`;
}

async function classify(message) {
  const ollamaResult = await classifyWithOllama(message);
  if (ollamaResult.verdict !== 'error') return ollamaResult;

  const { claudeApiKey } = await chrome.storage.local.get({ claudeApiKey: '' });
  if (!claudeApiKey) return ollamaResult;
  return classifyWithClaude(message, claudeApiKey);
}

async function classifyWithOllama(message) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: message.model || 'qwen2.5:3b',
        stream: false,
        format: 'json',
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt(message) },
        ],
      }),
    });
    if (!res.ok) return { verdict: 'error', detail: `HTTP ${res.status}` };
    const data = await res.json();
    return toVerdict(data.message.content, 'ollama');
  } catch (err) {
    return { verdict: 'error', detail: String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

async function classifyWithClaude(message, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 256,
        output_config: { effort: 'low' },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt(message) }],
      }),
    });
    if (!res.ok) return { verdict: 'error', detail: `Claude HTTP ${res.status}` };
    const data = await res.json();
    if (data.stop_reason === 'refusal') {
      return { verdict: 'error', detail: 'Claude refusal' };
    }
    const block = (data.content || []).find((b) => b.type === 'text');
    if (!block) return { verdict: 'error', detail: 'Claude: no text block' };
    // The model is instructed to reply with bare JSON, but strip any fencing.
    const json = block.text.match(/\{[\s\S]*\}/);
    if (!json) return { verdict: 'error', detail: 'Claude: unparseable reply' };
    return toVerdict(json[0], 'claude');
  } catch (err) {
    return { verdict: 'error', detail: String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

function toVerdict(jsonText, source) {
  try {
    const parsed = JSON.parse(jsonText);
    const isAI = parsed.ai_generated === true && (parsed.confidence ?? 1) >= 0.6;
    return { verdict: isAI ? 'ai' : 'human', confidence: parsed.confidence, source };
  } catch (err) {
    return { verdict: 'error', detail: String(err) };
  }
}

async function checkStatus() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) return { running: false };
    const data = await res.json();
    return { running: true, models: (data.models || []).map((m) => m.name) };
  } catch {
    return { running: false };
  }
}
