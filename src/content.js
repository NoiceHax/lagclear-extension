/*
 * LagClear - content.js  (the de-lag engine)
 * -------------------------------------------------------------------------
 * Runs on every page but bails cheaply unless the page looks like a long,
 * list-like chat. Two modes (chosen in the popup):
 *
 *   CPU  (default): tags each turn with `.lagclear-cull`, which applies
 *        content-visibility:auto so the browser skips layout/paint for
 *        off-screen turns. All nodes stay in the DOM: search, scrollback and
 *        copy all keep working. Saves CPU/paint; does not free node memory.
 *
 *   RAM  (conservative): uses an IntersectionObserver to detach the contents
 *        of turns that are FAR off-screen (big buffer, never the last/streaming
 *        turn, never a turn that changed recently) and restore them on
 *        scroll-up. Frees DOM-node memory. Experimental on React apps: only old,
 *        static, far-off-screen turns are touched, every DOM op is guarded, and
 *        if the app re-renders into a detached turn we hand it straight back.
 */
(function () {
  'use strict';

  if (globalThis.__lagclearLoaded) return;
  globalThis.__lagclearLoaded = true;

  var NS = globalThis.LAGCLEAR;
  if (!NS) return; // config.js failed to load
  var api = NS.api;

  // ===== Capabilities + config =====
  var cvSupported = typeof CSS !== 'undefined' && !!CSS.supports && CSS.supports('content-visibility', 'auto');
  var ioSupported = typeof IntersectionObserver !== 'undefined';
  var baseCfg = NS.resolve(location.hostname);
  var cfg = baseCfg;

  // ===== State =====
  var S = Object.assign({}, NS.DEFAULTS);
  var activated = false;
  var activeSelector = null;
  var heuristicParent = null;
  var processed = new WeakSet();   // CPU: turns tagged with .lagclear-cull
  var managed = new WeakSet();     // RAM: turns under IntersectionObserver
  var managedCount = 0;            // RAM: approx count of managed turns
  var htmlStore = new WeakMap();   // RAM: element -> saved innerHTML
  var mutatedAt = new WeakMap();   // RAM: element -> last mutation time
  var lastTurn = null;             // RAM: never detach the last (streaming) turn
  var io = null;
  var persistentObserver = null;
  var runScheduled = false;
  var lastRun = 0;
  var animStyleEl = null;
  var retryTimers = [];
  var lastUrl = location.href;

  var RAM_BUFFER_PX = 2000;         // keep this much above/below viewport live
  var RAM_MIN_TURNS = 24;           // don't detach in short chats
  var RAM_MUTATE_COOLDOWN = 3000;   // don't detach a turn that just changed
  var RAM_MIN_HEIGHT = 40;

  function perfNow() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : (+new Date());
  }

  // ===== Detection =====
  function listChildren(el) { return el ? Array.prototype.slice.call(el.children) : []; }

  // A real chat has a message composer (big text input). Required before the
  // structural heuristic may activate, so comment/feed lists don't qualify.
  function hasComposer() {
    var els = document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]');
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.width > 200 && r.height >= 16 && r.height < 400) return true;
    }
    return false;
  }

  function queryBySelectors(sels, minItems) {
    for (var i = 0; i < sels.length; i++) {
      var els;
      try { els = document.querySelectorAll(sels[i]); } catch (e) { continue; }
      if (els.length >= minItems) return { items: Array.prototype.slice.call(els), selector: sels[i], container: null };
    }
    return null;
  }

  // Bounded structural scan for a tall, repetitive, text-heavy conversation.
  function heuristicFind() {
    var vh = window.innerHeight || 800;
    var candidates = document.querySelectorAll('main, div, section, ul, ol');
    var n = Math.min(candidates.length, 4000);
    var best = null, bestScore = 0;
    for (var i = 0; i < n; i++) {
      var el = candidates[i];
      if (el.childElementCount < 6) continue;
      var sh = el.scrollHeight;
      if (sh < vh * 2.5) continue;
      var cs = getComputedStyle(el);
      var scrolls = /(auto|scroll|overlay)/.test(cs.overflowY);
      if (!scrolls && sh < vh * 4) continue;
      var kids = el.children, first = kids[0] && kids[0].tagName, same = 0;
      var sample = Math.min(kids.length, 20);
      for (var k = 0; k < sample; k++) { if (kids[k].tagName === first) same++; }
      var similarity = sample ? same / sample : 0;
      if (similarity < 0.6) continue;
      if ((el.textContent || '').length < 2000) continue;
      var score = sh * Math.min(el.childElementCount, 200) * similarity;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    if (!best) return null;
    var parent = best, guard = 0;
    while (parent.childElementCount === 1 && parent.firstElementChild && guard++ < 6) parent = parent.firstElementChild;
    return { items: listChildren(parent), container: parent };
  }

  function getItems() {
    if (cfg.disabled) return { items: [], selector: null, container: null };
    if (cfg.turnSelectors && cfg.turnSelectors.length) {
      var byS = queryBySelectors(cfg.turnSelectors, cfg.minItems);
      if (byS) return byS;
    }
    if (heuristicParent && heuristicParent.isConnected) {
      var kids = listChildren(heuristicParent);
      if (kids.length >= cfg.minItems) return { items: kids, selector: '[heuristic]', container: heuristicParent };
    }
    heuristicParent = null;
    var h = heuristicFind();
    if (h && h.items.length >= cfg.minItems) {
      heuristicParent = h.container;
      return { items: h.items, selector: '[heuristic]', container: h.container };
    }
    return { items: [], selector: null, container: null };
  }

  // Qualifying items, gated by the composer rule for heuristic detection.
  function detect() {
    var res = getItems();
    if (res.items.length < cfg.minItems) return null;
    if (res.selector === '[heuristic]' && !hasComposer() && !isForcedOn()) return null;
    return res;
  }

  // ===== CPU mode (content-visibility) =====
  function lazyifyMedia(el) {
    var imgs = el.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      if (!imgs[i].getAttribute('loading')) imgs[i].setAttribute('loading', 'lazy');
      imgs[i].setAttribute('decoding', 'async');
    }
  }

  function tagItems(items) {
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      if (!el || el.nodeType !== 1 || processed.has(el)) continue;
      processed.add(el);
      el.classList.add('lagclear-cull');
      if (S.lazyMedia) lazyifyMedia(el);
    }
  }

  function untagCPU() {
    var els = document.querySelectorAll('.lagclear-cull');
    for (var i = 0; i < els.length; i++) els[i].classList.remove('lagclear-cull');
    processed = new WeakSet();
  }

  function runCPU() {
    if (!cvSupported) return;
    var res = detect();
    if (!res) return;
    tagItems(res.items);
    activeSelector = res.selector;
    if (!activated) { activated = true; startPersistentObserver(); }
  }

  // ===== RAM mode (conservative detach) =====
  function ensureIO() {
    if (io || !ioSupported) return;
    io = new IntersectionObserver(onIO, { root: null, rootMargin: RAM_BUFFER_PX + 'px 0px', threshold: 0 });
  }

  function onIO(entries) {
    var pending = [];
    for (var i = 0; i < entries.length; i++) {
      var el = entries[i].target;
      if (entries[i].isIntersecting) restore(el);
      else if (collapseEligible(el)) pending.push(el);
    }
    if (!pending.length) return;
    // Read all heights first, then write, to avoid layout thrash.
    var heights = [];
    for (var j = 0; j < pending.length; j++) heights.push(pending[j].offsetHeight);
    for (var k = 0; k < pending.length; k++) collapseWith(pending[k], heights[k]);
  }

  function collapseEligible(el) {
    if (el === lastTurn) return false;
    if (managedCount < RAM_MIN_TURNS) return false;
    if (el.classList.contains('lagclear-collapsed')) return false;
    if (perfNow() - (mutatedAt.get(el) || 0) < RAM_MUTATE_COOLDOWN) return false;
    return true;
  }

  // Detach a turn's contents, holding a fixed height so nothing shifts.
  function collapseWith(el, h) {
    if (!h || h < RAM_MIN_HEIGHT) return;
    try {
      htmlStore.set(el, el.innerHTML);
      el.style.height = h + 'px';
      el.classList.add('lagclear-collapsed');
      el.textContent = ''; // drop the nodes -> frees memory
    } catch (e) { /* never break the page */ }
  }

  // Re-insert a turn's contents. Class is removed BEFORE re-inserting so the
  // resulting mutations are not mistaken for an app re-render (see observer).
  function restore(el) {
    if (!el.classList.contains('lagclear-collapsed')) return;
    try {
      var html = htmlStore.get(el);
      el.classList.remove('lagclear-collapsed');
      el.style.height = '';
      if (html != null) el.innerHTML = html;
      htmlStore.delete(el);
    } catch (e) { /* ignore */ }
  }

  function restoreAllCollapsed() {
    var els = document.querySelectorAll('.lagclear-collapsed');
    for (var i = 0; i < els.length; i++) restore(els[i]);
  }

  function runRAM() {
    if (!ioSupported) return;
    ensureIO();
    var res = detect();
    if (!res) return;
    var items = res.items;
    lastTurn = items[items.length - 1] || null;
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      if (!el || el.nodeType !== 1 || managed.has(el)) continue;
      managed.add(el);
      managedCount++;
      el.classList.add('lagclear-managed');
      io.observe(el);
    }
    activeSelector = res.selector;
    if (!activated) { activated = true; startPersistentObserver(); }
  }

  function teardownRAM() {
    if (io) { io.disconnect(); io = null; }
    restoreAllCollapsed();
    var m = document.querySelectorAll('.lagclear-managed');
    for (var i = 0; i < m.length; i++) m[i].classList.remove('lagclear-managed');
    managed = new WeakSet();
    managedCount = 0;
    lastTurn = null;
  }

  // ===== Shared scheduling / observers =====
  function run() {
    if (!isEnabledForSite() || cfg.disabled) return;
    if (S.mode === 'ram') runRAM();
    else runCPU();
  }

  function scheduleRun() {
    if (runScheduled) return;
    runScheduled = true;
    var since = perfNow() - lastRun;
    var minGap = 500;
    var delay = since >= minGap ? 0 : (minGap - since);
    setTimeout(function () {
      runScheduled = false;
      lastRun = perfNow();
      try { run(); } catch (e) { /* never break the host page */ }
    }, delay);
  }

  function scheduleRetries() {
    clearRetries();
    [400, 1200, 3000, 6000].forEach(function (ms) { retryTimers.push(setTimeout(scheduleRun, ms)); });
  }
  function clearRetries() {
    for (var i = 0; i < retryTimers.length; i++) clearTimeout(retryTimers[i]);
    retryTimers = [];
  }

  function startPersistentObserver() {
    if (persistentObserver) return;
    var target = document.body || document.documentElement;
    if (!target) return;
    persistentObserver = new MutationObserver(function (muts) {
      var added = false;
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.addedNodes && m.addedNodes.length) added = true;
        if (S.mode === 'ram' && m.target && m.target.nodeType === 1 && m.target.closest) {
          // If the app re-rendered into a detached turn, hand it back so its
          // content is never clipped by our fixed height.
          if (m.addedNodes && m.addedNodes.length) {
            var col = m.target.closest('.lagclear-collapsed');
            if (col) { col.classList.remove('lagclear-collapsed'); col.style.height = ''; htmlStore.delete(col); }
          }
          var owner = m.target.closest('.lagclear-managed');
          if (owner) mutatedAt.set(owner, perfNow());
        }
      }
      if (added) scheduleRun();
    });
    persistentObserver.observe(target, { childList: true, subtree: true });
  }
  function stopPersistentObserver() {
    if (persistentObserver) { persistentObserver.disconnect(); persistentObserver = null; }
  }

  function onNav() {
    activated = false;
    activeSelector = null;
    heuristicParent = null;
    processed = new WeakSet();
    stopPersistentObserver();
    teardownRAM();
    scheduleRun();
    scheduleRetries();
  }
  function urlWatch() {
    if (document.hidden) return;
    if (location.href !== lastUrl) { lastUrl = location.href; onNav(); }
  }

  // ===== Enable logic =====
  function isEnabledForSite() {
    if (!S.enabled) return false;
    var host = location.hostname;
    if (S.perSite && Object.prototype.hasOwnProperty.call(S.perSite, host)) return !!S.perSite[host];
    return true;
  }
  function isForcedOn() {
    return !!(S.perSite && S.perSite[location.hostname] === true);
  }
  function recomputeCfg() {
    if (baseCfg.disabled && S.perSite && S.perSite[location.hostname] === true) cfg = NS.GENERIC;
    else cfg = baseCfg;
  }

  function setCis() {
    document.documentElement.style.setProperty('--lagclear-cis', (S.intrinsic || 600) + 'px');
  }

  var ANIM_CSS =
    '*,*::before,*::after{animation-duration:.001s !important;animation-delay:0s !important;' +
    'transition-duration:.001s !important;transition-delay:0s !important}' +
    'html{scroll-behavior:auto !important}' +
    '*{backdrop-filter:none !important;-webkit-backdrop-filter:none !important}';

  function applyAnimStyle(on) {
    if (on) {
      if (!animStyleEl) {
        animStyleEl = document.createElement('style');
        animStyleEl.id = 'lagclear-anim-style';
        animStyleEl.textContent = ANIM_CSS;
        (document.head || document.documentElement).appendChild(animStyleEl);
      }
    } else if (animStyleEl) { animStyleEl.remove(); animStyleEl = null; }
  }

  function applyState() {
    setCis();
    var enabled = isEnabledForSite();
    applyAnimStyle(S.reduceAnimations && enabled);
    if (!enabled) {
      stopPersistentObserver();
      clearRetries();
      activated = false;
      untagCPU();
      teardownRAM();
      return;
    }
    // Clean up the other mode's effects before running the active one.
    if (S.mode === 'ram') untagCPU();
    else teardownRAM();
    scheduleRun();
    scheduleRetries();
  }

  // ===== Popup messaging =====
  api.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'lagclear:getStatus') return;
    var total = 0, affected = 0;
    try {
      total = getItems().items.length;
      affected = (S.mode === 'ram')
        ? document.querySelectorAll('.lagclear-collapsed').length
        : document.querySelectorAll('.lagclear-cull').length;
    } catch (e) { /* ignore */ }
    sendResponse({
      host: location.hostname,
      configId: cfg.id,
      denylisted: baseCfg.disabled === true,
      mode: S.mode,
      supported: (S.mode === 'ram') ? ioSupported : cvSupported,
      enabledForSite: isEnabledForSite(),
      active: isEnabledForSite() && activated,
      selector: activeSelector,
      affected: affected,
      total: total
    });
    return true;
  });

  if (api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener(function (changes) {
      if (changes.settings) {
        S = Object.assign({}, NS.DEFAULTS, changes.settings.newValue || {});
        recomputeCfg();
        applyState();
      }
    });
  }

  // ===== Boot =====
  function init() {
    window.addEventListener('popstate', onNav);
    setInterval(urlWatch, 1500);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) scheduleRun(); });
    applyState();
  }

  try {
    api.storage.sync.get('settings', function (res) {
      S = Object.assign({}, NS.DEFAULTS, (res && res.settings) || {});
      recomputeCfg();
      init();
    });
  } catch (e) {
    recomputeCfg();
    init();
  }
})();
