# LinkedIn AI Slop Filter

Chrome extension that collapses AI-generated posts in your LinkedIn feed.

**How it works (hybrid detection):**

1. Every feed post is scored instantly by local heuristics (AI-cliché phrases, em-dash density, emoji-bullet lists, "broetry" formatting, engagement-bait closers).
2. Score ≥ 55 → collapsed immediately. Score ≤ 25 → passed as human. Nothing leaves your machine.
3. Borderline scores (26–54) are classified by a local Ollama model, with the heuristic score and signals passed along as context. If Ollama isn't running, borderline posts fall back to the Claude API when an API key is set in the popup — otherwise they are simply left visible. The extension never breaks.

Collapsed posts shrink to a one-line bar with a **Show** button, so false positives are recoverable. Hover the bar's label to see which signals triggered.

## Install

### 1. Ollama (one-time, optional but recommended)

```bash
./setup-ollama.sh          # uses qwen2.5:3b (~2 GB)
# or: ./setup-ollama.sh gemma3:4b
```

This allows Chrome extensions to call the local Ollama API (`OLLAMA_ORIGINS`), persists that setting across reboots, restarts Ollama, and pulls the model. Skip this step entirely if you want heuristics-only filtering.

### 2. Extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Visit linkedin.com — the popup (toolbar icon) shows filtering status, hidden-post count, Ollama status, model, and thresholds

## Tuning

In the popup:

- **Hide at score ≥** (default 55): lower it to hide more aggressively.
- **Pass at score ≤** (default 25): raise it to send fewer posts to Ollama.
- **Model**: any model you've pulled in Ollama. Small instruct models (`qwen2.5:3b`, `gemma3:4b`, `llama3.2:3b`) are the right size — fast and good enough for classification.
- **Claude key (backup)**: optional Anthropic API key. When set, borderline posts are classified by Claude whenever Ollama is unreachable or errors.

To add new slop phrases as styles evolve, edit the `PHRASES` list in `heuristics.js` and reload the extension.

## Ad hiding

With **Hide ads** on (popup), promoted/sponsored posts and posts with creator buttons ("Visit my website", "Book an appointment"…) are silently hidden. **Heads-up:** any post containing the word "promoted" anywhere — including "I got promoted" announcements — is hidden too. This is deliberate; edit `isAdLabel` in `content.js` if you'd rather keep those.

## Notes

- Detection is probabilistic. Heuristics catch formulaic slop; the model catches subtler cases; lightly edited AI text can still slip through, and enthusiastic humans occasionally get flagged (click **Show**).
- LinkedIn changes its feed DOM occasionally. If posts stop being detected, the selectors in `content.js` (`data-id^="urn:li:activity"` and `.update-components-text`) are the first place to look.
- Local-first: no data leaves the machine except to `localhost:11434` — unless you set a Claude API key, in which case borderline post text is sent to `api.anthropic.com` only when Ollama is unavailable.
- Verdicts are cached per post for the browser session, so reloading the feed doesn't re-classify the same posts. Clicking **Show** on a hidden post logs it locally (last 200) as false-positive feedback for tuning the heuristics.

## Licence

MIT — see [LICENSE](LICENSE).
