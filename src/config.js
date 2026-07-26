/*
 * LagClear - config.js
 * -------------------------------------------------------------------------
 * Defines the shared LAGCLEAR namespace used by content.js.
 * This file and content.js run in the SAME content-script isolated world,
 * so a global set here is visible to content.js.
 *
 * ── Tuning site selectors ──────────────────────────────────────────────
 * Chat apps change their markup often, so these selectors can go stale.
 * If LagClear stops detecting a site, open that site, inspect a single
 * chat message/turn, find a selector that matches ONE turn, and add it to
 * the matching entry's `turnSelectors` array below (most-specific first).
 * Each array entry may be a full comma-separated selector list. The engine
 * uses the FIRST entry that matches at least `minItems` elements; if none
 * match, it falls back to the generic heuristic - so a wrong selector here
 * never breaks a page, it just falls through.
 */
(function () {
  'use strict';

  // Cross-browser API handle. Prefer `chrome`: it exists in Chrome, Edge AND
  // Firefox, and uses callback style everywhere (Firefox's `browser.*` is
  // promise-only and would silently ignore the callbacks we pass).
  var api = (typeof chrome !== 'undefined') ? chrome : browser;

  // True if `host` equals or is a subdomain of any domain in `domains`.
  function hostMatches(host, domains) {
    host = String(host || '').toLowerCase();
    for (var i = 0; i < domains.length; i++) {
      var d = domains[i];
      if (host === d || host.endsWith('.' + d)) return true;
    }
    return false;
  }

  // Default settings, seeded into storage on install and merged on load.
  var DEFAULTS = {
    enabled: true,          // master switch
    intrinsic: 600,         // placeholder height (px) reserved for culled turns
    reduceAnimations: false,// disable CSS animations/transitions/blur (opt-in)
    lazyMedia: true,        // defer off-screen images/media
    mode: 'cpu',            // 'cpu' = content-visibility, 'ram' = detach off-screen turns
    perSite: {}             // { "host": true|false } per-site override of `enabled`
  };

  /*
   * Curated per-site hints. `match(host)` selects the config; `turnSelectors`
   * are candidate selectors for one chat turn. Even for a matched site, if no
   * selector hits `minItems`, the engine still falls back to the heuristic.
   */
  var CONFIGS = [
    {
      id: 'chatgpt',
      match: function (h) { return hostMatches(h, ['chatgpt.com', 'chat.openai.com', 'openai.com']); },
      turnSelectors: [
        'article[data-testid^="conversation-turn"]',
        '[data-testid^="conversation-turn"]',
        'main [data-message-author-role]'
      ],
      minItems: 3
    },
    {
      id: 'claude',
      match: function (h) { return hostMatches(h, ['claude.ai']); },
      turnSelectors: [
        'div[data-test-render-count]',
        '.font-claude-message, div[data-testid="user-message"]',
        '.font-claude-message'
      ],
      minItems: 3
    },
    {
      id: 'gemini',
      match: function (h) { return hostMatches(h, ['gemini.google.com']); },
      turnSelectors: [
        'div.conversation-container',
        'model-response, user-query',
        'message-content'
      ],
      minItems: 3
    },
    {
      id: 'aistudio',
      match: function (h) { return hostMatches(h, ['aistudio.google.com']); },
      turnSelectors: ['ms-chat-turn', 'div.chat-turn-container'],
      minItems: 3
    },
    {
      id: 'perplexity',
      match: function (h) { return hostMatches(h, ['perplexity.ai']); },
      turnSelectors: ['div[class*="prose"]', 'main div[class*="border-borderMain"]'],
      minItems: 4
    },
    {
      id: 'poe',
      match: function (h) { return hostMatches(h, ['poe.com']); },
      turnSelectors: ['div[class*="ChatMessage_messageRow"]', 'div[class*="Message_"]'],
      minItems: 4
    },
    {
      id: 'deepseek',
      match: function (h) { return hostMatches(h, ['deepseek.com']); },
      turnSelectors: ['div[class*="_4f9bf79"]', 'div[class*="message"]'],
      minItems: 4
    },
    {
      id: 'copilot',
      match: function (h) { return hostMatches(h, ['copilot.microsoft.com']); },
      turnSelectors: ['cib-message-group', 'cib-message', 'div[data-content="message"]'],
      minItems: 3
    },
    {
      id: 'mistral',
      match: function (h) { return hostMatches(h, ['chat.mistral.ai', 'mistral.ai']); },
      turnSelectors: ['div[class*="message"]', 'div[data-message-author-role]'],
      minItems: 4
    },
    {
      id: 'huggingchat',
      match: function (h) { return hostMatches(h, ['huggingface.co']); },
      turnSelectors: ['div[class*="group"] div[class*="prose"]', 'div[class*="message"]'],
      minItems: 4
    },
    {
      id: 't3chat',
      match: function (h) { return hostMatches(h, ['t3.chat']); },
      turnSelectors: ['div[class*="message"]', 'div[role="article"]'],
      minItems: 4
    },
    {
      id: 'grok',
      match: function (h) { return hostMatches(h, ['grok.com', 'x.ai']); },
      turnSelectors: ['div[class*="message-bubble"]', 'div[class*="message"]'],
      minItems: 4
    }
  ];

  /*
   * Generic fallback: no selectors, so the engine uses its structural
   * heuristic. `minItems` is high so ordinary pages don't qualify -
   * only genuinely long, repetitive, chat-like lists get virtualized.
   */
  var GENERIC = {
    id: 'generic',
    match: function () { return true; },
    turnSelectors: [],
    minItems: 12
  };

  /*
   * Denylist: sites that are structurally chat-like (long lists of repeated,
   * text-heavy blocks) but are NOT chat apps - e.g. YouTube comments, Reddit
   * threads, social feeds. The generic heuristic must never auto-activate here.
   * Curated CONFIGS still win (checked first), and a user can force-enable any
   * site with the popup's "This site" toggle.
   */
  var DENYLIST = [
    'youtube.com', 'reddit.com', 'twitter.com', 'x.com', 'facebook.com',
    'instagram.com', 'tiktok.com', 'linkedin.com', 'pinterest.com',
    'news.ycombinator.com', 'quora.com', 'twitch.tv'
  ];

  // Sentinel config for denylisted hosts: never activates (minItems Infinity).
  var DISABLED = {
    id: 'disabled',
    disabled: true,
    match: function () { return false; },
    turnSelectors: [],
    minItems: Infinity
  };

  globalThis.LAGCLEAR = {
    api: api,
    DEFAULTS: DEFAULTS,
    CONFIGS: CONFIGS,
    GENERIC: GENERIC,
    DISABLED: DISABLED,
    DENYLIST: DENYLIST,
    hostMatches: hostMatches,
    isDenylisted: function (host) { return hostMatches(host, DENYLIST); },
    // Resolve the config for a hostname: curated match → denylist → generic.
    resolve: function (host) {
      for (var i = 0; i < CONFIGS.length; i++) {
        if (CONFIGS[i].match(host)) return CONFIGS[i];
      }
      if (hostMatches(host, DENYLIST)) return DISABLED;
      return GENERIC;
    }
  };
})();
