# ⚡ LagClear - Long Chat De-Lagger

A lightweight browser extension that keeps **long AI chats fast**. Threads on
ChatGPT, Claude, Gemini, Perplexity, and similar apps get laggy because every
message stays in the DOM - after a few hundred turns the browser is laying out,
painting, and hit-testing thousands of nodes on every scroll and keystroke.

LagClear fixes this by **virtualizing off-screen messages**: it tells the
browser to skip rendering work for turns that aren't on screen, while keeping
the scrollbar and scroll position correct. A 2,000-message thread then renders
about as cheaply as a short one.

Works in **Chrome, Edge, and Firefox** (Manifest V3).

---

## How it works

The whole trick is one modern CSS mechanism, applied to each chat turn:

```css
content-visibility: auto;
contain-intrinsic-size: auto var(--lagclear-cis);   /* e.g. 600px */
```

- `content-visibility: auto` lets the browser **skip layout, paint, and
  hit-testing** for an element while it is off-screen, and do the work only when
  it scrolls near the viewport.
- `contain-intrinsic-size: auto <h>` reserves space so the scrollbar stays
  stable, and the `auto` keyword makes the browser **remember each turn's real
  size** after rendering it once, which prevents scroll jumps.

A small engine (`src/content.js`):

1. **Detects** the conversation - tuned CSS selectors for known chat sites, or a
   conservative structural heuristic (tall, repetitive, text-heavy scroll region)
   for anything else. On ordinary pages it finds nothing and stays dormant.
2. **Tags** each turn with `.lagclear-cull` (the CSS above), tracked via a
   `WeakSet` so nothing is processed twice.
3. **Keeps up** with streaming responses, newly loaded turns, and chat switches
   using a throttled `MutationObserver` plus a URL watcher.

No message content is read, stored, or sent anywhere - it only toggles CSS.

---

## Install (developer / unpacked)

### Chrome / Edge
1. Go to `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `lagclear-extension` folder.

### Firefox
1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `manifest.json` inside this folder.
   *(Temporary add-ons are removed when Firefox restarts; reload to reinstall.)*

---

## Usage

Click the ⚡ toolbar icon for the popup:

| Control | What it does |
|---|---|
| **Enabled** | Master switch for every site. |
| **This site** | Turn LagClear on/off for the current site only. |
| **Lazy-load media** | Defer off-screen images (`loading="lazy"`). On by default. |
| **Reduce animations & blur** | Disable CSS animations/transitions and `backdrop-filter` - common scroll-jank sources. Opt-in. |
| **Mode** | ***Save CPU*** (default): content-visibility keeps every message in the page and just skips rendering off-screen ones. Smooth and safe; search/scrollback/copy all intact. ***Save RAM*** (experimental): detaches messages that are far off-screen from the DOM to free memory, restoring them on scroll-up. Bigger memory win, but may hiccup on React apps (ChatGPT/Claude), and Ctrl+F/copy won't see detached messages until you scroll back. |

The status card shows whether it's **Active** on the current page and how many
messages are being virtualized (e.g. *"Virtualizing 1,840 of 1,900 messages"*).

---

## Try it without logging in

Open `test/longchat.html` in your browser - it builds a 2,500-message chat.

- With the extension **off**, hit **Stress scroll** and watch the FPS counter
  drop; the banner says *inactive*.
- With the extension **on** (reload the file after loading the extension), the
  banner turns green (*ACTIVE ✓*), the FPS stays high, and the popup shows the
  virtualized count.

---

## Supported sites

Tuned selectors ship for: **ChatGPT, Claude, Gemini, Google AI Studio,
Perplexity, Poe, DeepSeek, Copilot, Mistral (Le Chat), HuggingChat, T3 Chat,
Grok.** Every other site is handled by the generic heuristic, so long chats on
apps not in this list still get sped up.

On unrecognized sites the generic heuristic activates only when the page both
looks like a conversation **and** has a message composer (a big text input), and
it **skips known non-chat sites** (YouTube, Reddit, X, Facebook, …) whose
comment/feed lists are structurally identical to chats. You can force LagClear
on for any site - or turn it off - with the popup's **This site** toggle.

### If a site stops being detected

Chat apps change their markup often. To re-point LagClear at a site, edit
`src/config.js`:

1. Open the site, right-click a single chat message → **Inspect**.
2. Find a CSS selector that matches **one turn** (e.g. an attribute like
   `[data-testid="…"]` or a stable class).
3. Add it to that site's `turnSelectors` array (most-specific first), then
   reload the extension. A wrong selector never breaks the page - it just falls
   through to the heuristic.

---

## Files

```
manifest.json          MV3 manifest (Chrome/Edge/Firefox)
src/config.js          Per-site selectors, defaults, the LAGCLEAR namespace
src/content.js         Detection + culling engine (runs on every page)
src/content.css        The .lagclear-cull rule
src/popup.*            Toolbar popup UI
icons/                 Toolbar/store icons (16/32/48/128)
test/longchat.html      2,500-message demo page
```

## Notes

- **Save CPU** mode needs `content-visibility` (Chrome/Edge ≥ 85, Firefox ≥ 125);
  **Save RAM** mode only needs `IntersectionObserver` (supported everywhere). If
  CPU mode isn't supported the popup says *Not supported* - switch to Save RAM.
- Universal (`<all_urls>`) injection is kept safe by a fast bail-out and
  conservative thresholds, so normal (non-chat) pages are left untouched.
- Privacy: no network requests, no analytics, nothing leaves your browser. (Save
  RAM mode reads a message's HTML locally, only to detach and later restore it.)
  Settings live in `storage.sync` only.
