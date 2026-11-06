# dsh-prompt-boost

A DeepSeek Harness profile plugin that adds a compact **AI-enhance** button to the chat composer tool
row, immediately **left of the model selector** (the red-box position in the request).

Click it and the unsent prompt is rewritten by the model, then written back into the composer draft in
place. It never sends the message.

## What it does

| State | Behavior |
| --- | --- |
| Draft empty | Button disabled, tooltip "先输入提示词" |
| Draft has text | Button enabled; click rewrites the draft |
| **Text selected** in the draft | Only the selected fragment is rewritten, then spliced back as one undoable edit |
| **After a whole-draft rewrite** (draft untouched) | The button switches to an undo icon; one more click restores the pre-enhancement draft |
| Rewrite in flight | Button shows a spinner, further clicks are disabled |
| **Draft edited while enhancing** | The result is discarded and reported in the tooltip — the newer draft is never overwritten |
| Draft has `@file` / `@folder` / `@session` chips, or a claimed `/command` | Button disabled — a plain-text rewrite cannot preserve those structured nodes |
| Failure | Button turns red-tinted; tooltip carries the reason; click again retries |

## Interaction details

- **Selection-aware.** With a non-empty selection inside the draft, the button sends the selected
  fragment plus the surrounding draft (so the replacement fits the sentence) and applies it through
  `inputActions.captureInsertion()` → `insertText(text, span)`, which is revision-checked and undoable
  with Ctrl/Cmd+Z. Without a selection the whole draft is rewritten through `setDraft`.
  *Implementation note:* the range is captured on **mousedown** and the default action is prevented.
  The composer's `caretSpan()` reads `projection.selection`, which is only refreshed inside the editor
  update callback, so a plain click that moves focus reports a collapsed caret; preventing the focus
  change both preserves the range and keeps Ctrl/Cmd+Z aimed at the editor.
- **Attachments are real context.** Draft images and files are read from the composer (they live in
  the browser until submit) and sent with the request: images are admitted through the Host
  `attachments` service and travel as `image` content blocks, UTF-8 files are decoded and inlined,
  and binary files contribute a factual note instead of invented content. Bounds: 4 images + 4 files,
  3 MB each, 8 MB combined.
- **One-click revert.** After a whole-draft rewrite the control remembers the previous text; while the
  draft still equals the rewrite it shows an undo icon and restores the original draft on click. Any
  edit clears that state automatically. **A captured selection always wins over revert**: otherwise a
  click meant to rewrite a fragment would silently restore the whole draft.

### Icon states

The icon describes the **next** click, so it accounts for a live selection:

| Situation | Icon | Tooltip |
| --- | --- | --- |
| Idle | sparkle | AI 增强还没发出的提示词 |
| A non-empty selection sits in the composer | sparkle | AI 增强选中的这段文字 |
| Revert available (whole-draft rewrite, no selection) | undo | 撤销增强，还原增强前的草稿 |
| Rewrite in flight | spinner | 正在增强提示词… |

Selection presence is tracked through `selectionchange` / `focusin` / `focusout` plus a check that the
focused element is still the composer editor; without that check a selection in the chat transcript
would flip the icon by mistake.
- **No stale overwrite.** The request captures `draftRev` and text; if either changed before the reply
  arrives, the result is dropped instead of clobbering what the user typed.
- **Rewrite quality.** The system prompt preserves code/paths/identifiers byte-for-byte, keeps Markdown
  layout, does not translate technical terms, and only pads when the draft is genuinely thin.

## Conversation context sent with the draft

The rewrite is **context-aware by default**: the enhancement is computed against the ongoing
conversation, not just the draft text. A bounded envelope travels with every request:

| Included | Limit |
| --- | --- |
| Recent user/assistant turns, from the Session's own message projection (`deriveMessages()`, so edits and replacements are honoured) | up to 16 messages, 1200 chars each, 8000 chars total; older turns are counted and the omission is stated in the envelope |
| Session working directory | one line |
| Agent preset id | one line |
| Attachment content (images / text files) | see [Attachment support](#attachment-support-how-the-content-reaches-the-model) |

The system prompt is explicit about *how* to use it: treat the history as background (never answer it,
never continue the task, never dump it), but resolve elliptical drafts — `它`, `这个`, `继续`, `上面说的`,
`那个问题`, or a bare follow-up — into the concrete subject, task, files and decisions the conversation
shows, so the rewritten prompt still stands on its own.

Tool results and `@file`/`@folder`/`@session` reference chips are not sent (the button is disabled while
such chips exist, since a plain-text rewrite would drop them). Disable the conversation envelope per row
with `config.context: "none"`.

## Layout

```
plugins/dsh-prompt-boost/
├── package.json       # bundle manifest + dsh.bundle.patch + dsh.client
├── cordis.patch.yml   # inserts row id `prompt-boost`
├── index.js           # Host half: loopback routes + one ctx.llm rewrite call
├── client.js          # Browser half: composer button in conversation.input.right
├── locale/en.json     # Plugin Manager title/description (English)
├── locale/zh.json     # Plugin Manager title/description (Chinese)
└── icon.svg           # Plugin Manager icon
```

## Transport: a loopback route, not `host.call`

A profile-installed `dsh.client` bundle receives only `require` in its browser factory; the
package-private `host.call` RPC exists only for dynamic Cordis packages. The two halves therefore talk
over one named route on the Web carrier, which the page reaches with a same-origin `fetch` (on Desktop
the `dsh-app://app` protocol handler forwards non-static paths to the Host with its cookie):

- `POST /prompt-boost/enhance` — `{ text, sessionId?, selection?, draft?, attachments? }` →
  `{ ok, text, provider, model, source, context }`

`attachments` entries are `{ kind: "image" | "file", name, mediaType, data }`, where `data` is canonical
base64 read from the draft's browser-side `File`. The route is bounded (12 MB body, 8 MB of attachment
bytes) because image bytes travel inline exactly once, before the Host turns them into durable
references.

The enhance route refuses anything that is not the plugin's own client (`application/json` plus the
`x-prompt-boost: 1` header). Both headers are non-simple, so a cross-origin page cannot reach it without
a CORS preflight this route never approves.

**No diagnostic endpoints ship.** Earlier development builds exposed `/prompt-boost/health` and
`/prompt-boost/registered`; both are gone. The browser half is covered by the local harness
`tools/test-client.mjs` (activation, slot registration, whole-draft and selection flows, icon state
machine), so no runtime instrumentation is left in the product surface.

## Model selection (why the rewrite sometimes fails)

The rewrite uses this chain, first usable entry wins:

1. `config.provider` + `config.model` from the row config;
2. the **current Session's own route** (`session.requestContext()`, then `requestHeader().config`);
3. the most recent live Session that reports a route (a brand-new Session has none yet);
4. `agentDefaultModel.currentSelection()` — the deployment default.

Step 2/3 matter: the deployment default can name a provider whose credential is absent (for example an
API-key route while the Session runs on the signed-in account route), and the composer would otherwise
fail with an authentication error even though chat works.

## Attachment support (how the content reaches the model)

Draft attachments are browser-owned until submit: the composer keeps a `File` plus upload state, and the
`conversation` client service exposes them through `resolveDraftAttachments(ids)`. The button therefore
reads the bytes itself and posts them with the draft; the Host half then:

1. **Images** — validates `image/png|jpeg|webp|gif`, admits each through `ctx.get('attachments').saveImage`
   (which normalizes and content-addresses it), and attaches the resulting `ImageAttachmentRef` as
   `{ type: 'image', attachment }` content blocks. Images are only attached when the prepared call
   reports `inputModalities` including `image`; otherwise they are skipped and the prompt carries an
   explicit note instead of silent loss.
2. **Text files** — decoded as strict UTF-8 (NUL/control-heavy files count as binary) and inlined under
   an `[[Attached file: name (N bytes)]]` header, truncated per file (20k chars) and overall (60k chars).
3. **Binary files** — never faked: the prompt gets `name (N bytes)` plus a "content not inlined" note.

Consequences worth knowing:

- Each image sent for an enhancement is stored once in the attachment object store (content-addressed and
  normalized, e.g. `~/.dsh/attachments/v1/objects/...`). An enhancement that is never submitted leaves
  those objects behind; the store's own garbage collection is not invoked here.
- Model support decides whether image content can be used at all; `deepseek-flash` reports image input,
  and a text-only route degrades to the note above.
- Attachments never block the button: a failed read just yields a smaller payload.

## Configuration (optional, via the profile patch row)

```yaml
- id: prompt-boost
  name: dsh-prompt-boost
  config:
    provider: deepseek-account   # pin a route instead of following the session
    model: deepseek-flash
    system: "..."                # replaces the built-in rewrite instruction
    context: none                # omit session context (default: auto)
    temperature: 0.4
    maxTokens: 1200
    timeoutMs: 45000
```

## Failure policy (important on Desktop)

The Harness **web boot audit treats any Loader entry that does not reach `active` as fatal** for the
whole Desktop app: it reports a crash and the next launch offers a native recovery that resets the
profile's bundle list and patch. This plugin therefore keeps its browser half total — the module factory
and `apply()` guard every step and fall back instead of throwing. Never add an unguarded throw to
`client.js`.

The Host half is a normal plugin; its `apply()` only registers routes.

## Desktop operational notes

- The browser half is injected from the Web boot graph. Enabling the bundle while the app runs is picked
  up **live** through the client graph transport (no refresh or restart needed) — verified on 0.2.1-rc.5.
- The bundle is installed as a `link:` dependency to this workspace, so edits to `index.js` take effect
  after a profile recomposition (any Plugin Manager toggle) or app restart; edits to `client.js` also
  reach an open page through the same live transport.
- The `desktop` profile is owned by the Electron app. A **fatal recovery** rewrites `package.json`'s
  `dsh.profile.bundles` and backs up `cordis.patch.yml`; link-installed bundles are dropped by that
  rewrite, registry-installed ones are restored. If the plugin ever disappears after a crash dialog, just
  re-enable it (`set_bundle dsh-prompt-boost` or Plugin Manager → Plugins); nothing is lost.

## Install / remove

```powershell
plugin_manager install_bundle C:\PlayerWang\plugins\dsh-prompt-boost
plugin_manager set_plugin include:prompt-boost enabled=false   # temporarily inert
plugin_manager remove_bundle dsh-prompt-boost                  # uninstall
```
