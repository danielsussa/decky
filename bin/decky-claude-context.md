You are in a **decky session** (an Electron shell with a preview panel to the right of the terminal). The `decky` MCP (`mcp__decky__*`) is available and has tools to **show** content to the user instead of just reading it.

- **`preview_show`** — when the user asks to *see / show / open* a file (`.html`, `.json`, `.xlsx`, `.diff`/`.patch`, legacy `.md`), use **this** tool instead of `Read`. `Read` pulls the content into your context but the user **doesn't see** the formatted file; `preview_show` displays it in the shell's center panel.
- `Read` is still right when you need to **process** the content (parse, edit, search, grep).
- Other decky MCP tools: `preview_html` (inline HTML — canonical for new cards), `preview_json` (collapsible tree, better than dumping huge JSON in the terminal), `preview_me` (back to the me daemon's Live View), `preview_hide`. `preview_markdown` was discontinued on 2026-06-16 — call `preview_html` instead.
- **`preview_diff`** — to show code changes (output of `git diff`/`git show`/`diff -u`), use **this** tool, passing the raw diff text. It renders structured (per-file header with +/-, line gutter, green/red lines) — **never** dump the diff into a ```diff markdown block, it's much worse.
- **Keep the card in sync after acting**: a card does NOT update from your reasoning — only a file-backed card auto-reloads, and only when the file changes on disk. `preview_show(path)` live-reloads on every save (just keep editing the file, no need to re-render). `preview_html`, in turn, materializes the content automatically into `.decky/cards/<id>.html` and the tool response tells you **`card '<id>' at <path>`** — to update it, edit the `.html` directly (live-reload picks it up on save). `preview_json` stays an inline snapshot: to update it, call the tool again with `card: '<same id>'` and the new value.
- **`preview_html` accepts a fragment OR a full document**: if `content` starts with `<!doctype` or `<html`, it's used as-is. Otherwise it's wrapped in the default scaffold (`/__decky/default.css`, body with padding). In both cases, the renderer scans the content for `data-decky-<name>` and auto-injects `<script src="/__decky/widgets/<name>.js">` before `</body>` — you don't need to remember to include the widget scripts, it's automatic.
- **Session context = ONLY the focused card**: the user points at ONE card per session (the highlighted tab in the panel) and THAT is the context. Other open tabs exist but do NOT count — the user isn't asking you to look at them. Call `list_cards` **proactively** to find the focused card when: (1) the question has little context and seems to expect prior context — e.g. "let's go back to that?", "so?", "continue", "what's left?" with no antecedent in this conversation; (2) the question references something via an ambiguous demonstrative — "this / that / that one / that thing / the doc / that list / the card" without you having an id at hand; (3) the request is to edit/update something that clearly isn't from this conversation. Return: `{ card }` (the single focused card) or `{ card: null }` if none is focused. For HTML the `path` is already editable with `Edit`. To find ANOTHER card that isn't focused, use `search_cards` — don't try to "list everything". Do **not** call it if the question is self-contained (clear instruction, enough context in this conversation, technical work on code files).
- **Card library**: the cards you create are real `.html` files under the project's `.decky/cards/` (the env var `$DECKY_CARDS_DIR` has the absolute path), shared across all sessions of the workspace. Before generating a doc from scratch, do a Glob over `$DECKY_CARDS_DIR/**/*.html` and reuse/edit the existing one. `$DECKY_CARDS_DIR/PINNED.md` is the only legitimate `.md` (the pinned index, not a card).

### The `decky` command — operations CLI

You have **`decky`** on this session's PATH (it only exists inside decky). It's a CLI to **operate decky itself** from the terminal, complementary to the `mcp__decky__*` tools (which show content). Run it via `Bash`.

- **Discover what it does with `decky help`** — the command set grows incrementally, so `help` is the source of truth: don't memorize a list, check it on the spot. For a specific command, `decky <cmd>` with no args usually explains its usage.
- It acts **on behalf of this session** (the `DECKY_SESSION_ID`/`DECKY_URL` env is already injected) — no need to pass a session id.
- Use it when the user asks to **operate/test decky from the terminal**, or when a command covers something the MCP tools don't.

### Widgets in HTML cards

HTML cards can have **live widgets** — interactive elements rendered by a vanilla JS runtime served at `/__decky/widgets/<name>.js`.

**Discover the catalog**: run `decky widgets` in the terminal — it's the source of truth, listing every widget type with its description and JSON spec shape. Run it before guessing a spec; the type set grows incrementally, so don't rely on a memorized list.

`list_widgets()` (MCP) is a different thing — it enumerates the widget INSTANCES currently mounted in open cards (`{ cardId, widgetId, type }`), not the type catalog. Use it to find what's live on screen (e.g. to address a widget by id), NOT to learn what types exist or their specs — that's `decky widgets`.

**Create a widget in an HTML card**: inside the HTML, a `<div data-decky-<name>>{...JSON spec...}</div>`. The JSON needs an `id` if you want to address the widget later. E.g.:

```html
<div data-decky-matrix>
{ "id": "my-widget", "options": [...], "criteria": [...], "scores": {...} }
</div>
```

The `<script src="/__decky/widgets/matrix.js">` is **auto-injected** by `preview_html` — you don't need to add it manually.

**Spec `readonly: true`** disables user interaction (inputs/buttons become disabled, an "AI-only" badge appears) — useful for dashboards/analyses the AI maintains and the user only observes.

**Imperative I/O (`card_invoke` / `card_get`)**: today wired only for in-app rendered widgets (the React side — flow + checklist in legacy `.md` cards). Vanilla widgets in the HTML mini-app do **not** yet expose ops via MCP — to mutate them, edit the JSON of the `<div data-decky-*>` in the `.html` directly. When the postMessage bridge lands (planned), `card_invoke` will work the same way.

**Anti-pattern**: trying to invoke an op on a vanilla widget via `card_invoke` — it'll give "no active window or ws client" or time out. Edit the spec JSON in the HTML.

### Preview before sending a message (WhatsApp, email, etc)

Whenever the user asks to send a message over any channel (WhatsApp, email, SMS, DM — via `me`/handoff or any other path), **do NOT send directly**. First render a card in decky (right panel) with a visual preview of the message (recipient + subject/context + text), and only send after the user presses SEND. Pressing SEND is the explicit authorization signal — it prevents firing a message with the wrong text, the wrong recipient, or when the user changed their mind.

- **WhatsApp**: `preview_html` with a header (avatar/initial + name + phone), the last 3-5 messages of the conversation as context (incoming = gray bubble on the left, outgoing = green bubble on the right, with timestamps — fetch them via `me`/handoff first), and the message to send as a green bubble at the end with a dashed border / opacity / "PREVIEW" label.
- **Email**: `preview_html` with a header (`From:`, `To:`, `Cc:` if any, `Subject:`) and the body formatted as it will go out (HTML, not raw); if there's a thread, show the last 2-3 emails above as context.
- **Other channels**: adapt the mockup to the channel, but always keep recipient + context + text visible.
- Then `prompt_form` with a pre-filled (editable) `textarea` for the body + a `text` field showing the recipient (and subject, for email) for review. Button `submitLabel: "Send"`.
- Respect the final text that comes back in `values` (the user may have edited it). Cancel = don't send; don't resend without new authorization.
- No history available (new contact/thread, handoff error): render just the header + preview and mention in the card that it's a new conversation.
