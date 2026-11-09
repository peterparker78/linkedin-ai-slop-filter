// Content script: watches the LinkedIn feed, scores each post with local
// heuristics, escalates borderline posts to Ollama (via the background
// service worker, with optional Claude API backup), and collapses posts
// judged AI-generated.

(function () {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    highThreshold: 55, // heuristic score at/above which a post is hidden immediately
    lowThreshold: 25, // heuristic score at/below which a post is passed as human
    model: 'qwen2.5:3b',
    hideAds: true, // silently hide promoted feed posts and right-rail ads
  };
  const VERDICT_CACHE_MAX = 500; // persisted URN->verdict entries, oldest trimmed
  const SHOWN_LOG_MAX = 200; // "Show" clicks kept as false-positive feedback
  // Deliberate rule: any post containing the word "promoted" anywhere (label,
  // body or comments) is hidden — this deliberately includes "I got promoted"
  // posts. "Sponsored" still counts only as a short label.
  const isAdLabel = (s) =>
    /\bpromoted\b/i.test(s) || (/^\s*Sponsored\b/i.test(s) && s.trim().length <= 80);
  // Creator "custom button" labels — posts carrying one are hidden like ads
  // (feed only; the same buttons on profile pages are left alone).
  const CTA_RE =
    /^\s*(Visit my (website|store)|Book an appointment|View my (newsletter|portfolio|services|blog|website))\s*$/i;

  const USER_RULES_MAX = 300; // remembered click-to-hide rules, oldest trimmed
  const URN_SEL = 'div[data-id^="urn:li:activity"], div[data-urn^="urn:li:activity"]';

  let settings = { ...DEFAULTS };
  let userRules = []; // click-to-hide rules (see "Click-to-hide" below)
  const verdictCache = new Map(); // post URN -> 'ai' | 'human'

  // Verdicts persist in session storage so a reload (or LinkedIn SPA
  // navigation) doesn't re-classify — and re-query Ollama for — the same posts.
  chrome.storage.local.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    applyAdSetting();
    chrome.storage.local.get({ hiddenItems: [] }, ({ hiddenItems }) => {
      userRules = hiddenItems;
      applyUserRules();
    });
    chrome.storage.session.get({ verdicts: {} }, ({ verdicts }) => {
      for (const [urn, verdict] of Object.entries(verdicts)) {
        verdictCache.set(urn, verdict);
      }
      startObserver();
      scanFeed();
    });
  });

  function cacheVerdict(urn, verdict) {
    verdictCache.set(urn, verdict);
    while (verdictCache.size > VERDICT_CACHE_MAX) {
      verdictCache.delete(verdictCache.keys().next().value);
    }
    chrome.storage.session.set({ verdicts: Object.fromEntries(verdictCache) });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in settings) settings[key] = newValue;
    }
    if (changes.enabled) {
      if (changes.enabled.newValue === false) revealAll();
      else scanFeed();
    }
    if (changes.hideAds) applyAdSetting();
    if (changes.hiddenItems) {
      // "Show hidden items" in the popup (or another tab's edit): reset and reapply.
      userRules = changes.hiddenItems.newValue || [];
      document
        .querySelectorAll('.aif-user-hidden')
        .forEach((el) => el.classList.remove('aif-user-hidden'));
      applyUserRules();
    }
  });

  function startObserver() {
    const observer = new MutationObserver(
      throttle(() => {
        scanAds();
        applyUserRules();
        scanFeed();
      }, 500)
    );
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function throttle(fn, ms) {
    let timer = null;
    return () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
    };
  }

  // Ad hiding is independent of the AI filter. Ads are tagged with .aif-ad
  // and hidden by CSS only while <html> has .aif-hide-ads, so toggling the
  // setting off reveals them instantly without rescanning.
  function applyAdSetting() {
    document.documentElement.classList.toggle('aif-hide-ads', !!settings.hideAds);
    if (settings.hideAds) scanAds();
  }

  function scanAds() {
    if (!settings.hideAds) return;
    // Match on visible text ("promoted" anywhere, or a "Sponsored" label) rather than
    // LinkedIn's class names, which change (and are obfuscated in newer
    // builds). Feed scanning is limited to /feed so promoted job cards on
    // job-search pages aren't hidden.
    // Walk text nodes, not leaf elements: the label can share an element
    // with other content (e.g. "280,113 followers<br>Promoted").
    const onFeed = location.pathname === '/' || location.pathname.startsWith('/feed');
    const roots = onFeed ? [document.body] : [...document.querySelectorAll('aside')];
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const isAd = isAdLabel(node.nodeValue);
        if (!isAd && !CTA_RE.test(node.nodeValue)) continue;
        const label = node.parentElement;
        if (!label || label.closest('.aif-ad, .aif-bar, script, style')) continue;
        const inRail = !!label.closest('aside');
        if (!isAd && inRail) continue; // CTA buttons only count on feed posts
        const container = inRail ? railAdCard(label) : feedAdPost(label);
        if (container && isSafeToHide(container)) markAd(container);
      }
    }
  }

  // Every feed post has exactly one "Comment" action button, so it is the
  // unit count: the ad post is the largest ancestor of the label that still
  // holds exactly one. That can never span two posts. No button found (or
  // the label isn't inside a post) → hide nothing.
  function countPosts(el) {
    let n = 0;
    for (const b of el.querySelectorAll('button')) {
      const label = (b.getAttribute('aria-label') || b.textContent).trim();
      if (/^Comment\b/i.test(label)) n++;
    }
    return n;
  }

  function feedAdPost(label) {
    let best = null;
    for (let cur = label; cur && cur !== document.body; cur = cur.parentElement) {
      const n = countPosts(cur);
      if (n > 1) break;
      if (n === 1) best = cur;
    }
    return best;
  }

  function railAdCard(label) {
    const card = label.closest('section, .artdeco-card');
    return card && !card.matches('aside') ? card : null;
  }

  // Hard backstop against hiding page structure, whatever the DOM looks like.
  function isSafeToHide(el) {
    if (el.matches('body, main, aside, header, nav, [role="main"]')) return false;
    if (el.querySelector('main, aside, header, nav, [role="main"]')) return false;
    return el.offsetHeight <= Math.max(2500, window.innerHeight * 3);
  }

  function markAd(el) {
    if (el.classList.contains('aif-ad')) return;
    el.classList.add('aif-ad');
    // Keep the AI scanner from spending a classify call on an ad.
    if (!el.dataset.aif) el.dataset.aif = 'ad';
  }

  // ---- Click-to-hide ("hide distracting items", like Safari) ----
  // Started from the popup or ⌥⇧H. Hidden items are remembered as rules in
  // chrome.storage.local.hiddenItems, independent of the other switches:
  //   post    — a whole feed post, by its activity URN
  //   inpost  — part of a post (e.g. a picture), by URN + path inside it
  //   section — a page box (e.g. "LinkedIn News"), by selector of stable
  //             class names + tree depth + its first text, all of which must
  //             match, so the rule fails safe (stops matching) if LinkedIn
  //             changes the page.
  // Things with no stable identity are hidden for the current visit only.
  function urnOf(el) {
    return el.getAttribute('data-id') || el.getAttribute('data-urn');
  }

  function applyUserRules() {
    for (const rule of userRules) {
      for (const el of findRuleTargets(rule)) {
        if (!el.classList.contains('aif-user-hidden')) el.classList.add('aif-user-hidden');
      }
    }
  }

  function findRuleTargets(rule) {
    if (rule.kind === 'post' || rule.kind === 'inpost') {
      const urn = CSS.escape(rule.urn);
      return [...document.querySelectorAll(`div[data-id="${urn}"], div[data-urn="${urn}"]`)]
        .map((p) => (rule.kind === 'post' ? feedAdPost(p) || p : p.querySelector(':scope > ' + rule.path)))
        .filter((el) => el && isSafeToHide(el));
    }
    let matches;
    try {
      matches = document.querySelectorAll(rule.selector);
    } catch {
      return [];
    }
    return [...matches].filter(
      (el) => depthOf(el) === rule.depth && fingerprint(el) === rule.text && isSafeToHide(el)
    );
  }

  function ruleFor(el) {
    if (el.matches(URN_SEL)) return { kind: 'post', urn: urnOf(el) };
    const outer = el.closest(URN_SEL);
    if (outer) return { kind: 'inpost', urn: urnOf(outer), path: relPath(outer, el) };
    const inner = el.querySelectorAll(URN_SEL);
    if (inner.length === 1) return { kind: 'post', urn: urnOf(inner[0]) };
    if (inner.length || countPosts(el)) return null; // a post with no URN: no stable identity
    const text = fingerprint(el);
    if (!text) return null;
    return { kind: 'section', selector: sectionSelector(el), depth: depthOf(el), text };
  }

  function fingerprint(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.nodeValue.replace(/\s+/g, ' ').trim();
      if (t) return t.slice(0, 40);
    }
    return '';
  }

  function depthOf(el) {
    let d = 0;
    for (let cur = el; cur.parentElement; cur = cur.parentElement) d++;
    return d;
  }

  function relPath(root, el) {
    const parts = [];
    for (let cur = el; cur !== root; cur = cur.parentElement) {
      let i = 1;
      for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.tagName === cur.tagName) i++;
      }
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${i})`);
    }
    return parts.join(' > ');
  }

  // Readable class names (e.g. "news-module__headline") survive reloads;
  // hashed ones and Ember ids don't, so they're left out of the selector.
  function selectorPart(el) {
    let part = el.tagName.toLowerCase();
    const stable = [...el.classList]
      .filter((c) => /^[a-z][a-z0-9]*(?:(?:-|__?)[a-z0-9]+)+$/.test(c) && !/^(aif-|ember)/.test(c) && !/\d{3,}/.test(c))
      .slice(0, 2);
    for (const c of stable) part += '.' + CSS.escape(c);
    const view = el.getAttribute('data-view-name');
    if (view) part += `[data-view-name="${CSS.escape(view)}"]`;
    return part;
  }

  function sectionSelector(el) {
    const parts = [selectorPart(el)];
    let cur = el.parentElement;
    for (let i = 0; cur && cur !== document.body && i < 4; i++, cur = cur.parentElement) {
      if (cur.matches('main, aside, header, nav')) {
        parts.unshift(cur.tagName.toLowerCase());
        break;
      }
      const part = selectorPart(cur);
      if (part !== cur.tagName.toLowerCase()) parts.unshift(part);
    }
    return parts.join(' ');
  }

  // Picker UI.
  let picker = null;

  function startPicking() {
    if (picker) return;
    const box = document.createElement('div');
    box.className = 'aif-pick-box';
    const { banner, text } = buildBanner();
    document.documentElement.append(box, banner);
    document.documentElement.classList.add('aif-picking');
    picker = { box, banner, text, stack: [], flashTimer: null };
    setBanner();
    for (const [type, fn] of PICK_LISTENERS) window.addEventListener(type, fn, true);
    setBadge(true);
  }

  // Safari-style pill: eye-slash icon, prompt, Done button. Built with DOM
  // calls (no innerHTML) so LinkedIn's Trusted Types CSP can't block it.
  function buildBanner() {
    const banner = document.createElement('div');
    banner.className = 'aif-pick-banner';
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'aif-pick-icon');
    for (const [tag, attrs] of [
      ['path', { d: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z' }],
      ['circle', { cx: 12, cy: 12, r: 3 }],
      ['line', { x1: 3, y1: 3, x2: 21, y2: 21 }],
    ]) {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
    }
    const text = document.createElement('span');
    text.className = 'aif-pick-text';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'aif-pick-done';
    done.textContent = 'Done';
    banner.append(svg, text, done);
    return { banner, text };
  }

  // "HIDE" badge on the toolbar icon while the picker is on (Chrome doesn't
  // allow an indicator in the address bar, as Safari has).
  function setBadge(on) {
    chrome.runtime.sendMessage({ type: 'pickState', on }, () => void chrome.runtime.lastError);
  }

  function stopPicking() {
    if (!picker) return;
    for (const [type, fn] of PICK_LISTENERS) window.removeEventListener(type, fn, true);
    clearTimeout(picker.flashTimer);
    picker.box.remove();
    picker.banner.remove();
    document.documentElement.classList.remove('aif-picking');
    picker = null;
    setBadge(false);
  }

  function setBanner(msg) {
    picker.text.textContent = msg || 'Click an item to hide  ·  ↑ ↓ resize';
  }

  function flash(msg) {
    setBanner(msg);
    clearTimeout(picker.flashTimer);
    picker.flashTimer = setTimeout(() => picker && setBanner(), 3000);
  }

  const current = () => picker.stack[picker.stack.length - 1];

  // Start from a meaningful block, not a tiny inline span or icon path.
  function snap(el) {
    while (el.parentElement && el.parentElement !== document.body) {
      const r = el.getBoundingClientRect();
      if (r.width * r.height >= 2500) break;
      el = el.parentElement;
    }
    return el;
  }

  function drawBox() {
    const el = current();
    const s = picker.box.style;
    if (!el || !el.isConnected) {
      s.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    s.display = 'block';
    s.top = r.top + 'px';
    s.left = r.left + 'px';
    s.width = r.width + 'px';
    s.height = r.height + 'px';
  }

  function onPickMove(e) {
    if (!(e.target instanceof Element) || e.target === document.documentElement) return;
    if (picker.banner.contains(e.target)) {
      picker.stack = []; // over our own pill: nothing to outline
      drawBox();
      return;
    }
    const base = snap(e.target);
    if (picker.stack[0] === base) return; // keep any ↑ expansion while within it
    picker.stack = [base];
    drawBox();
  }

  function onPickKey(e) {
    if (e.key === 'Escape') {
      stopPicking();
    } else if (e.key === 'ArrowUp') {
      const parent = current() && current().parentElement;
      if (parent && isSafeToHide(parent)) picker.stack.push(parent);
      else flash('That is as large as it goes');
      drawBox();
    } else if (e.key === 'ArrowDown') {
      if (picker.stack.length > 1) picker.stack.pop();
      drawBox();
    } else {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // Swallow the whole click sequence so LinkedIn doesn't open links/posts.
  function onPickBlock(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'click' || e.button !== 0) return;
    if (picker.banner.contains(e.target)) {
      if (e.target.closest('.aif-pick-done')) stopPicking();
      return;
    }
    const el = current();
    if (!el) return;
    if (!isSafeToHide(el)) {
      flash('Too large to hide — press ↓ for a smaller area');
      return;
    }
    el.classList.add('aif-user-hidden');
    picker.stack = [];
    drawBox();
    const rule = ruleFor(el);
    if (!rule) {
      flash("Hidden for this visit only (can't be recognised next time)");
      return;
    }
    userRules = [...userRules, rule].slice(-USER_RULES_MAX);
    chrome.storage.local.set({ hiddenItems: userRules });
    flash('Hidden — restore from the extension popup');
  }

  const PICK_LISTENERS = [
    ['mousemove', onPickMove],
    ['keydown', onPickKey],
    ['scroll', drawBox],
    ...['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'auxclick', 'dblclick'].map(
      (t) => [t, onPickBlock]
    ),
  ];

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'pickMode') {
      startPicking();
      sendResponse({ ok: true }); // popup treats no reply as "not a LinkedIn tab"
    }
  });

  // ⌥⇧H toggles the picker (ignored while typing in a field). Capture phase,
  // so LinkedIn's own key handlers can't swallow it first.
  window.addEventListener(
    'keydown',
    (e) => {
      if (!(e.altKey && e.shiftKey && e.code === 'KeyH')) return;
      if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (picker) stopPicking();
      else startPicking();
    },
    true
  );

  function scanFeed() {
    if (!settings.enabled) return;
    const posts = document.querySelectorAll(
      'div[data-id^="urn:li:activity"]:not([data-aif]), div[data-urn^="urn:li:activity"]:not([data-aif])'
    );
    posts.forEach(processPost);
  }

  function processPost(post) {
    post.dataset.aif = 'pending';
    const urn = post.getAttribute('data-id') || post.getAttribute('data-urn');
    const text = extractText(post);

    if (!text || text.trim().split(/\s+/).length < 10) {
      post.dataset.aif = 'clean';
      return;
    }

    if (verdictCache.has(urn)) {
      applyVerdict(post, urn, verdictCache.get(urn), null, 'cached');
      return;
    }

    const { score, signals, text: bestText } = bestScore(post, text);

    if (score >= settings.highThreshold) {
      cacheVerdict(urn, 'ai');
      applyVerdict(post, urn, 'ai', score, 'heuristics', signals);
    } else if (score <= settings.lowThreshold) {
      cacheVerdict(urn, 'human');
      post.dataset.aif = 'clean';
      rescanOnExpand(post, urn);
    } else {
      // Borderline: ask the model via the background worker, sending the
      // heuristic score and signals along so the model breaks the tie with
      // that context rather than classifying blind.
      chrome.runtime.sendMessage(
        {
          type: 'classify',
          urn,
          text: bestText.slice(0, 4000),
          score,
          signals,
          model: settings.model,
        },
        (response) => {
          if (chrome.runtime.lastError || !response || response.verdict === 'error') {
            // No model reachable — fall back to heuristics-only (don't hide).
            post.dataset.aif = 'clean';
            return;
          }
          cacheVerdict(urn, response.verdict);
          applyVerdict(post, urn, response.verdict, score, response.source, signals);
        }
      );
    }
  }

  // Score every text element in the post, not just the top-level commentary:
  // a human's two-line comment can wrap a reposted AI post, and LinkedIn
  // clamps long posts behind "…more" (innerText returns only the visible
  // portion; textContent has the full text but no line structure). Score all
  // candidates and keep the highest, along with the text that produced it.
  function bestScore(post, text) {
    let result = { ...self.scorePost(text), text };
    for (const el of post.querySelectorAll('.update-components-text')) {
      if (el.textContent.length < 40) continue;
      const alt = self.scorePost(el.textContent);
      if (alt.score > result.score) result = { ...alt, text: el.textContent };
    }
    return result;
  }

  // If a post passed while clamped, rescore it once the user expands it.
  function rescanOnExpand(post, urn) {
    const seeMore = post.querySelector(
      'button[class*="see-more"], .feed-shared-inline-show-more-text__see-more-less-toggle'
    );
    if (!seeMore) return;
    seeMore.addEventListener(
      'click',
      () => {
        setTimeout(() => {
          verdictCache.delete(urn);
          delete post.dataset.aif;
          processPost(post);
        }, 400);
      },
      { once: true }
    );
  }

  function extractText(post) {
    const el =
      post.querySelector('.update-components-text') ||
      post.querySelector('.feed-shared-inline-show-more-text') ||
      post.querySelector('[class*="update-components-update-v2__commentary"]');
    return el ? el.innerText : '';
  }

  function applyVerdict(post, urn, verdict, score, source, signals) {
    if (verdict !== 'ai') {
      post.dataset.aif = 'clean';
      return;
    }
    post.dataset.aif = 'hidden';
    collapse(post, urn, score, source, signals || []);
    // A cached verdict means this post was already counted (earlier this
    // page load, or in a previous one) — don't count re-renders again.
    if (source !== 'cached') bumpHiddenCount();
  }

  function collapse(post, urn, score, source, signals) {
    if (post.querySelector('.aif-bar')) return;
    post.classList.add('aif-collapsed');

    const bar = document.createElement('div');
    bar.className = 'aif-bar';

    const label = document.createElement('span');
    label.className = 'aif-label';
    const detail =
      source === 'ollama'
        ? 'flagged by local model'
        : source === 'claude'
          ? 'flagged by Claude'
          : score != null
            ? `heuristic score ${score}`
            : 'previously flagged';
    label.textContent = `🤖 Hidden — likely AI-generated (${detail})`;
    if (signals.length) label.title = 'Signals: ' + signals.join(', ');

    const btn = document.createElement('button');
    btn.className = 'aif-toggle';
    btn.type = 'button';
    btn.addEventListener('click', () => {
      const collapsed = post.classList.toggle('aif-collapsed');
      btn.textContent = collapsed ? 'Show' : 'Hide again';
      if (!collapsed) logShown(urn, score, source, signals);
    });
    btn.textContent = 'Show';

    bar.append(label, btn);
    post.prepend(bar);
  }

  // Every "Show" click is a probable false positive — keep a capped log so
  // over-firing phrases/weights and thresholds can be tuned from real data.
  const shownLogged = new Set();
  function logShown(urn, score, source, signals) {
    if (shownLogged.has(urn)) return;
    shownLogged.add(urn);
    chrome.storage.local.get({ shownLog: [] }, ({ shownLog }) => {
      shownLog.push({ urn, score, source, signals, ts: Date.now() });
      if (shownLog.length > SHOWN_LOG_MAX) {
        shownLog = shownLog.slice(-SHOWN_LOG_MAX);
      }
      chrome.storage.local.set({ shownLog });
    });
  }

  function revealAll() {
    document.querySelectorAll('.aif-collapsed').forEach((post) => {
      post.classList.remove('aif-collapsed');
      const btn = post.querySelector('.aif-toggle');
      if (btn) btn.textContent = 'Hide again';
    });
  }

  function bumpHiddenCount() {
    chrome.storage.session.get({ hiddenCount: 0 }, ({ hiddenCount }) => {
      chrome.storage.session.set({ hiddenCount: hiddenCount + 1 });
    });
  }
})();
