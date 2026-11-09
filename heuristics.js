// Local heuristic scorer for AI-generated LinkedIn posts.
// scorePost(text) returns { score: 0-100, signals: [string] }.
// Higher score = more likely AI-generated. Runs entirely locally, no network.

(function (root) {
  'use strict';

  // Phrase patterns with weights. Case-insensitive; matched against full post text.
  const PHRASES = [
    [/\bi'?m (?:truly |deeply |incredibly |beyond )?(?:thrilled|excited|humbled|honou?red|delighted|proud) to (?:announce|share|say)\b/i, 18, 'announcement opener'],
    [/\blet that sink in\b/i, 16, '"let that sink in"'],
    [/\bread that again\b/i, 16, '"read that again"'],
    [/\bgame.?chang(?:er|ing)\b/i, 10, '"game-changer"'],
    [/\bdelve\b/i, 8, '"delve"'],
    [/\bin today'?s (?:fast-paced|ever-evolving|digital|competitive|rapidly changing) (?:world|landscape|environment|market|era)\b/i, 14, '"in today\'s fast-paced world"'],
    [/\b(?:digital|evolving|competitive|business|professional) landscape\b/i, 8, '"landscape" jargon'],
    [/\bunlock (?:your|the|their) (?:full )?(?:potential|power|value|growth)\b/i, 10, '"unlock potential"'],
    [/\b(?:a )?testament to\b/i, 8, '"testament to"'],
    [/\btapestry\b/i, 8, '"tapestry"'],
    [/\bhere'?s the (?:kicker|thing|truth|catch)\b/i, 10, '"here\'s the kicker"'],
    [/^the (?:best part|result|outcome|lesson)\?/im, 12, 'rhetorical "The result?"'],
    [/\bspoiler(?: alert)?\s*:/i, 8, '"spoiler:"'],
    [/\bkey takeaways?\b/i, 8, '"key takeaways"'],
    [/\bactionable (?:insights?|tips?|steps?)\b/i, 10, '"actionable insights"'],
    [/\belevate your\b/i, 8, '"elevate your"'],
    [/\bagree\?\s*$/im, 10, 'closing "Agree?"'],
    [/\b(?:your )?thoughts\?\s*$/im, 8, 'closing "Thoughts?"'],
    [/\bwho'?s with me\b/i, 10, '"who\'s with me"'],
    [/\bfollow (?:me )?for more\b/i, 12, '"follow for more"'],
    [/(?:♻️|🔁)\s*repost/i, 10, 'repost bait'],
    [/\bit'?s not (?:just )?(?:about )?.{2,60}?[.,;:—–-]\s*it'?s (?:about )?/i, 14, '"it\'s not X, it\'s Y"'],
    [/\bmost people (?:don'?t|won'?t|never|get this wrong|miss this)\b/i, 10, '"most people don\'t"'],
    [/\bstop (?:doing this|scrolling)\b/i, 10, '"stop scrolling"'],
    [/\bhot take\b/i, 6, '"hot take"'],
    [/\bleverag(?:e|ing)\b/i, 5, '"leverage"'],
    [/\bsynerg(?:y|ies|istic)\b/i, 6, '"synergy"'],
    [/\bdouble[- ]down\b/i, 5, '"double down"'],
    [/\bthe (?:harsh|hard|uncomfortable|brutal) truth\b/i, 10, '"the hard truth"'],
    [/\bnobody (?:talks about|tells you)\b/i, 10, '"nobody talks about"'],
    [/\b(?:i|we) (?:learned|discovered) (?:more|this) the hard way\b/i, 8, '"learned the hard way"'],
    [/\bp\.?s\.?[\s:]/im, 5, '"P.S." sign-off'],
    [/\bhumbled and grateful\b/i, 12, '"humbled and grateful"'],
    [/\bwithout further ado\b/i, 8, '"without further ado"'],
    [/\bdive (?:in|deep|deeper) into\b/i, 6, '"dive deeper into"'],
    [/\bembark on\b/i, 6, '"embark on"'],
    [/\bnavigat(?:e|ing) the (?:complexities|challenges|world)\b/i, 10, '"navigating the complexities"'],
    [/\bhere'?s (?:what|why|how)\b.{0,60}\b(?:actually|really)\b/i, 10, '"here\'s what X actually"'],
    [/^everyone (?:wants|is|does|thinks|talks about)\b/im, 6, '"everyone wants X" contrast'],
    [/\bthe winners\b/i, 6, '"the winners"'],
    [/\bunsexy\b/i, 6, '"unsexy"'],
    [/\b10x\b/i, 5, '"10x"'],
  ];

  // Emoji commonly used as line bullets in AI-formatted posts.
  const EMOJI_BULLET = /^\s*(?:✅|✔️|☑️|🚀|💡|👉|🔥|✨|📈|📉|⚡|🎯|❌|➡️|→|📌|💪|🙌|⭐|🧠|🔑|1️⃣|2️⃣|3️⃣|4️⃣|5️⃣)/u;

  // Unicode "fake bold/italic" (mathematical alphanumeric symbols) used for styling.
  const FAKE_BOLD = /[\u{1D400}-\u{1D7FF}]/u;

  function scorePost(text) {
    const signals = [];
    let score = 0;
    if (!text) return { score: 0, signals };

    const words = text.trim().split(/\s+/).filter(Boolean);
    const wordCount = words.length;

    for (const [re, weight, label] of PHRASES) {
      if (re.test(text)) {
        score += weight;
        signals.push(label);
      }
    }

    // Structural signals are meaningless on very short posts.
    if (wordCount >= 20) {
      const lines = text.split('\n').map((l) => l.trim());
      const nonEmpty = lines.filter((l) => l.length > 0);

      // Em-dash density (per 100 words).
      const emDashes = (text.match(/—/g) || []).length;
      const dashRate = (emDashes / wordCount) * 100;
      if (dashRate >= 3) {
        score += 18;
        signals.push('very high em-dash density');
      } else if (dashRate >= 1.5) {
        score += 10;
        signals.push('high em-dash density');
      }

      // Emoji-bullet lists.
      const bulletLines = nonEmpty.filter((l) => EMOJI_BULLET.test(l)).length;
      if (bulletLines >= 5) {
        score += 25;
        signals.push(`${bulletLines} emoji-bullet lines`);
      } else if (bulletLines >= 3) {
        score += 15;
        signals.push(`${bulletLines} emoji-bullet lines`);
      }

      // One-short-line-per-paragraph "broetry" formatting.
      if (nonEmpty.length >= 6) {
        const shortLines = nonEmpty.filter((l) => l.length <= 90).length;
        if (shortLines / nonEmpty.length > 0.7) {
          score += 12;
          signals.push('one-sentence-per-line formatting');
        }
      }

      // Short hook line followed by a blank line.
      if (
        nonEmpty.length >= 3 &&
        lines[0].length > 0 &&
        lines[0].length <= 60 &&
        lines[1] === ''
      ) {
        score += 8;
        signals.push('hook-line opener');
      }

      // Numbered-slash listicle ("1/ ...", "2/ ...").
      const slashNumbered = nonEmpty.filter((l) => /^\d+\/\s?/.test(l)).length;
      if (slashNumbered >= 3) {
        score += 15;
        signals.push(`${slashNumbered} numbered-slash list items`);
      }

      // Arrows used mid-sentence ("The problem → ..."), beyond line-start bullets.
      const midlineArrows = (text.match(/\S\s*(?:→|➜|=>)\s*\S/g) || []).length;
      if (midlineArrows >= 2) {
        score += 8;
        signals.push('mid-sentence arrows');
      }

      // Hashtag pile.
      const hashtags = (text.match(/(?:^|\s)#\w+/g) || []).length;
      if (hashtags >= 4) {
        score += 8;
        signals.push(`${hashtags} hashtags`);
      }

      // Unicode fake-bold styling.
      if (FAKE_BOLD.test(text)) {
        score += 10;
        signals.push('unicode fake-bold text');
      }
    }

    return { score: Math.min(100, Math.round(score)), signals };
  }

  root.scorePost = scorePost;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { scorePost };
  }
})(typeof self !== 'undefined' ? self : globalThis);
