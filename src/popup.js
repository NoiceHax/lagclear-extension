/* LagClear - popup.js */
(function () {
  'use strict';

  // Prefer `chrome` for callback-style APIs across Chrome/Edge/Firefox.
  var api = (typeof chrome !== 'undefined') ? chrome : browser;

  var DEFAULTS = {
    enabled: true,
    intrinsic: 600,
    reduceAnimations: false,
    lazyMedia: true,
    mode: 'cpu',
    perSite: {}
  };

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    enabled: $('enabled'),
    thisSite: $('thisSite'),
    lazyMedia: $('lazyMedia'),
    reduceAnimations: $('reduceAnimations'),
    seg: $('seg'),
    dot: $('dot'),
    statusText: $('statusText'),
    stat: $('stat'),
    siteLine: $('siteLine'),
    siteDesc: $('siteDesc')
  };

  var settings = Object.assign({}, DEFAULTS);
  var activeTabId = null;
  var activeHost = '';
  var isWebPage = false;
  var pageProto = '';

  // ── Settings I/O ─────────────────────────────────────────────────────
  function loadSettings(cb) {
    api.storage.sync.get('settings', function (res) {
      settings = Object.assign({}, DEFAULTS, (res && res.settings) || {});
      if (!settings.perSite) settings.perSite = {};
      cb();
    });
  }
  function saveSettings() {
    api.storage.sync.set({ settings: settings });
  }

  // ── Rendering ────────────────────────────────────────────────────────
  function setDot(cls) { els.dot.className = 'dot ' + cls; }

  function setSeg(mode) {
    var btns = els.seg.querySelectorAll('.seg-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-mode') === mode);
    }
  }

  function renderControls() {
    els.enabled.checked = settings.enabled !== false;
    els.lazyMedia.checked = settings.lazyMedia !== false;
    els.reduceAnimations.checked = !!settings.reduceAnimations;
    setSeg(settings.mode === 'ram' ? 'ram' : 'cpu');

    var override = Object.prototype.hasOwnProperty.call(settings.perSite, activeHost)
      ? settings.perSite[activeHost] : true;
    els.thisSite.checked = !!override;
    els.thisSite.disabled = !isWebPage;
  }

  function setStatMessage(verb, n, total) {
    els.stat.textContent = '';
    els.stat.append(verb + ' ');
    var b1 = document.createElement('b'); b1.textContent = String(n); els.stat.append(b1);
    els.stat.append(' of ');
    var b2 = document.createElement('b'); b2.textContent = String(total); els.stat.append(b2);
    els.stat.append(' messages');
  }

  function renderStatus(r) {
    if (r && r.host) {
      var showId = r.configId && r.configId !== 'generic' && r.configId !== 'disabled';
      els.siteLine.textContent = 'Site: ' + r.host + (showId ? '  ·  ' + r.configId : '');
    }
    if (!r) { setDot('off'); els.statusText.textContent = 'Not available on this page'; els.stat.textContent = ''; return; }
    if (!r.supported) { setDot('off'); els.statusText.textContent = 'Not supported in this browser'; els.stat.textContent = ''; return; }
    if (!r.enabledForSite) { setDot('off'); els.statusText.textContent = 'Paused here'; els.stat.textContent = ''; return; }
    if (r.configId === 'disabled') {
      setDot('off');
      els.statusText.textContent = 'Skipped here (not a chat app)';
      els.stat.textContent = 'Turn on "This site" to force it.';
      return;
    }
    if (r.active) {
      setDot('active');
      if (r.mode === 'ram') {
        els.statusText.textContent = 'Active - saving memory';
        setStatMessage('Freed', r.affected || 0, r.total || 0);
      } else {
        els.statusText.textContent = 'Active - de-lagging this chat';
        setStatMessage('Virtualizing', r.affected || 0, r.total || 0);
      }
      return;
    }
    setDot('idle');
    els.statusText.textContent = 'Standing by';
    els.stat.textContent = (r.total > 0)
      ? ('Found ' + r.total + ' messages')
      : 'No long chat detected on this page';
  }

  function renderUnavailable(text) {
    setDot('off');
    els.statusText.textContent = text || 'Not available on this page';
    els.stat.textContent = '';
    els.siteLine.textContent = activeHost ? ('Site: ' + activeHost) : '';
  }

  // ── Talk to the content script ───────────────────────────────────────
  function requestStatus() {
    if (activeTabId == null) { renderUnavailable('No active tab'); return; }
    if (!isWebPage) {
      renderUnavailable('Open a website (e.g. chatgpt.com), then click the icon.');
      return;
    }
    try {
      api.tabs.sendMessage(activeTabId, { type: 'lagclear:getStatus' }, function (resp) {
        if (api.runtime.lastError || !resp) {
          renderUnavailable(pageProto === 'file:'
            ? 'Local file: enable "Allow access to file URLs" in the extension details, then reload.'
            : 'Reload the page to activate here');
          return;
        }
        renderStatus(resp);
      });
    } catch (e) {
      renderUnavailable();
    }
  }

  // ── Wiring ───────────────────────────────────────────────────────────
  function wire() {
    els.enabled.addEventListener('change', function () {
      settings.enabled = els.enabled.checked;
      saveSettings(); setTimeout(requestStatus, 120);
    });
    els.lazyMedia.addEventListener('change', function () {
      settings.lazyMedia = els.lazyMedia.checked;
      saveSettings(); setTimeout(requestStatus, 120);
    });
    els.reduceAnimations.addEventListener('change', function () {
      settings.reduceAnimations = els.reduceAnimations.checked;
      saveSettings(); setTimeout(requestStatus, 120);
    });
    els.thisSite.addEventListener('change', function () {
      if (!activeHost) return;
      settings.perSite[activeHost] = els.thisSite.checked;
      saveSettings(); setTimeout(requestStatus, 120);
    });
    els.seg.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.seg-btn') : null;
      if (!btn) return;
      var mode = btn.getAttribute('data-mode');
      settings.mode = (mode === 'ram') ? 'ram' : 'cpu';
      setSeg(settings.mode);
      saveSettings(); setTimeout(requestStatus, 120);
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────
  function resolveActiveTab(cb) {
    api.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (tab) {
        activeTabId = tab.id;
        try {
          var u = new URL(tab.url);
          activeHost = u.hostname;
          pageProto = u.protocol;
          isWebPage = (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:');
        } catch (e) { activeHost = ''; pageProto = ''; isWebPage = false; }
      }
      cb();
    });
  }

  loadSettings(function () {
    resolveActiveTab(function () {
      if (!isWebPage) els.siteDesc.textContent = 'Open a website to use it';
      renderControls();
      wire();
      requestStatus();
      setInterval(requestStatus, 1500);
    });
  });
})();
