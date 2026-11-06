/**
 * Browser half of `dsh-prompt-boost`.
 *
 * Registers one compact control in `conversation.input.right`, which the composer
 * renders immediately left of the model selector.
 *
 * Interaction:
 * - whole draft: `setDraft(enhanced)`; while the draft still equals the rewrite the
 *   control offers a one-click revert;
 * - non-empty selection: only the selected fragment is rewritten and spliced back
 *   through `insertText(text, span)` (one undoable edit);
 * - the draft is never overwritten when it changed while the request was in
 *   flight (`draftRev` + text are compared before applying).
 *
 * The selection range is captured on mousedown and the default action is
 * prevented: the composer refreshes its projected selection only inside the editor
 * update callback, so a focus-moving click reports a collapsed caret (and the
 * editor would also lose the Ctrl/Cmd+Z target).
 *
 * Failure policy: the Web boot audit treats ANY Loader entry that does not reach
 * `active` as fatal for the whole application, so the module factory and `apply()`
 * are total — every step is guarded and falls back instead of throwing.
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-boost',
  factory(require) {
    const ROUTE_ENHANCE = '/prompt-boost/enhance';
    const NS = 'prompt-boost';
    const BUTTON_CLASS = 'dsh-prompt-boost-btn';

    /** Attachment intake bounds mirrored by the Host route. */
    const MAX_ATTACHMENT_IMAGES = 4;
    const MAX_ATTACHMENT_FILES = 4;
    const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
    const MAX_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;
    const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

    let React = null;
    let h = null;
    try {
      React = require('react');
      h = React.createElement;
    } catch { /* the button simply does not render */ }

    const DICT = {
      en: {
        'button.label': 'AI enhance prompt',
        'button.revertLabel': 'Restore the prompt from before the enhancement',
        'button.tooltip': 'AI enhance the unsent prompt (with a selection, only the selected text is rewritten)',
        'button.tooltipSelection': 'AI enhance the selected text',
        'button.busy': 'Enhancing the prompt…',
        'button.empty': 'Type a prompt first',
        'button.unavailable': 'The draft cannot be edited right now',
        'button.references': 'Remove the attached files or references before enhancing',
        'button.revert': 'Undo the enhancement and restore the previous draft (with a selection, only the selection is rewritten)',
        'button.selectionDone': 'The selected text was rewritten; press Ctrl/Cmd+Z to undo it',
        'button.stale': 'The draft changed while enhancing, so the result was discarded',
        'button.error': 'AI enhancement failed',
      },
      zh: {
        'button.label': 'AI 增强提示词',
        'button.revertLabel': '还原到增强前的草稿',
        'button.tooltip': 'AI 增强还没发出的提示词（选中文字时只增强选中部分）',
        'button.tooltipSelection': 'AI 增强选中的这段文字',
        'button.busy': '正在增强提示词…',
        'button.empty': '先输入提示词',
        'button.unavailable': '当前草稿暂时无法编辑',
        'button.references': '含文件或会话引用时暂不支持增强，请先移除引用',
        'button.revert': '撤销增强，还原增强前的草稿（有选中文字时仍只增强选中部分）',
        'button.selectionDone': '已改写选中部分，可按 Ctrl/Cmd+Z 撤销',
        'button.stale': '增强期间草稿已变化，本次结果未应用',
        'button.error': 'AI 增强失败',
      },
    };

    /** Local dictionary fallback when the locale service is unavailable. */
    function localTranslate(key) {
      const tag = typeof navigator === 'object' && typeof navigator.language === 'string'
        ? navigator.language.toLowerCase()
        : 'en';
      const dict = tag.startsWith('zh') ? DICT.zh : DICT.en;
      return dict[key] ?? DICT.en[key] ?? key;
    }

    /**
     * Register this plugin's dictionary and return its translate function.
     * @param ctx - Client plugin context.
     * @returns a translate function that reads the active locale on every call.
     */
    function bindTranslate(ctx) {
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
      if (locale === undefined || locale === null || typeof locale.register !== 'function' || typeof locale.bind !== 'function') {
        return localTranslate;
      }
      try {
        locale.register(NS, { zh: DICT.zh, en: DICT.en });
      } catch {
        try {
          locale.register(NS, 'zh', DICT.zh);
          locale.register(NS, 'en', DICT.en);
        } catch { /* fall back to the local dictionary */ }
      }
      try {
        const bound = locale.bind(NS);
        if (typeof bound === 'function' && bound('button.label') !== 'button.label') return bound;
      } catch { /* fall back to the local dictionary */ }
      return localTranslate;
    }

    function sparkleIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M7.6 1.7l1.28 3.42 3.42 1.28-3.42 1.28L7.6 11.1 6.32 7.68 2.9 6.4l3.42-1.28L7.6 1.7z', fill: 'currentColor' }),
        h('path', { d: 'M12.35 9.6l.72 1.93 1.93.72-1.93.72-.72 1.93-.72-1.93L9.7 12.25l1.93-.72.72-1.93z', fill: 'currentColor', opacity: '0.72' }));
    }

    function spinnerIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false', className: 'pb-boost-spin' },
        h('path', { d: 'M8 1.75a6.25 6.25 0 106.25 6.25', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round' }));
    }

    function undoIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M3.9 6.1h3', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round' }),
        h('path', { d: 'M3.9 6.1l2.1-2.1M3.9 6.1l2.1 2.1', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M4.1 6.1h4.3a4.1 4.1 0 010 8.2H6.2', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round', fill: 'none' }));
    }

    /** Shorten one error message for a tooltip. */
    function clip(message) {
      return message.length > 300 ? `${message.slice(0, 300)}…` : message;
    }

    /** Encode bytes as canonical base64 without spreading a huge argument list. */
    function toBase64(bytes) {
      let binary = '';
      const chunk = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk));
      }
      return btoa(binary);
    }

    /**
     * Read the composer's draft attachments as wire payloads.
     *
     * Draft attachments live in the browser (a `File` plus its upload state) and
     * only become durable Host references at submit time, so the bytes are read
     * here and handed to the Host half, which admits images through the
     * `attachments` service and inlines text files.
     * @param ctx - Client plugin context.
     * @param attachmentIds - Ordered draft attachment ids from `InputState`.
     * @returns bounded payloads in draft order.
     */
    async function readAttachmentPayloads(ctx, attachmentIds) {
      if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) return [];
      try {
        const conversation = typeof ctx.get === 'function' ? ctx.get('conversation') : undefined;
        const resolve = conversation?.resolveDraftAttachments;
        if (typeof resolve !== 'function') return [];
        const draftAttachments = resolve(attachmentIds) ?? [];
        const payloads = [];
        let images = 0;
        let files = 0;
        let totalBytes = 0;
        for (const attachment of draftAttachments) {
          if (attachment === null || typeof attachment !== 'object') continue;
          const file = attachment.file;
          if (file === null || file === undefined || typeof file.arrayBuffer !== 'function') continue;
          const size = typeof file.size === 'number' ? file.size : 0;
          if (size <= 0 || size > MAX_ATTACHMENT_BYTES) continue;
          const kind = attachment.kind === 'image' ? 'image' : 'file';
          if (kind === 'image' && images >= MAX_ATTACHMENT_IMAGES) continue;
          if (kind === 'file' && files >= MAX_ATTACHMENT_FILES) continue;
          if (totalBytes + size > MAX_ATTACHMENT_TOTAL_BYTES) break;
          const mediaType = typeof file.type === 'string' ? file.type : '';
          if (kind === 'image' && !IMAGE_MEDIA_TYPES.has(mediaType)) continue;
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) continue;
            payloads.push({
              kind,
              name: String(typeof file.name === 'string' && file.name !== '' ? file.name : 'attachment').slice(0, 200),
              mediaType,
              data: toBase64(bytes),
            });
            totalBytes += bytes.length;
            if (kind === 'image') images += 1;
            else files += 1;
          } catch { /* skip an unreadable attachment */ }
        }
        return payloads;
      } catch {
        return [];
      }
    }

    /** Whether one DOM node belongs to a contenteditable surface. */
    function isEditableNode(node) {
      try {
        if (node === null || node === undefined) return false;
        const element = node.nodeType === 1 ? node : node.parentElement;
        if (element === null || element === undefined) return false;
        if (element.isContentEditable === true) return true;
        return typeof element.closest === 'function'
          && element.closest('[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]') !== null;
      } catch {
        return false;
      }
    }

    /**
     * Read the browser selection as a live composer selection.
     *
     * The projected span alone is not enough: it refreshes only on editor updates,
     * so a caret moved after selecting text can leave a stale non-empty range behind.
     * The DOM selection is the freshness check.
     * @returns the DOM selection facts, or null when unavailable.
     */
    function domSelection() {
      try {
        const selection = typeof window !== 'undefined' && typeof window.getSelection === 'function'
          ? window.getSelection()
          : null;
        if (selection === null || selection === undefined || selection.rangeCount === 0) return null;
        return {
          collapsed: selection.isCollapsed === true,
          inEditor: isEditableNode(selection.anchorNode) && isEditableNode(selection.focusNode),
        };
      } catch {
        return null;
      }
    }

    /**
     * Read the composer selection through the input action face.
     * @param inputActions - Standard slot prop.
     * @returns a valid, non-empty detect-coordinate span, or null.
     */
    function readSelection(inputActions) {
      try {
        if (inputActions === undefined || inputActions === null) return null;
        if (typeof inputActions.captureInsertion !== 'function') return null;
        if (typeof inputActions.insertText !== 'function') return null;
        const dom = domSelection();
        if (dom === null || dom.collapsed || !dom.inEditor) return null;
        const span = inputActions.captureInsertion();
        if (span === null || typeof span !== 'object') return null;
        if (typeof span.start !== 'number' || typeof span.end !== 'number') return null;
        if (span.start < 0 || span.start >= span.end) return null;
        return span;
      } catch {
        return null;
      }
    }

    /**
     * Pick the first usable selection span for the current draft revision.
     * @param candidates - Captured spans, most reliable first.
     * @param text - Current draft text.
     * @param draftRev - Current draft revision.
     * @returns a usable span, or null.
     */
    function pickSpan(candidates, text, draftRev) {
      for (const candidate of candidates) {
        if (candidate === null || candidate === undefined) continue;
        if (candidate.draftRev !== draftRev) continue;
        if (typeof candidate.start !== 'number' || typeof candidate.end !== 'number') continue;
        if (candidate.start < 0 || candidate.start >= candidate.end || candidate.end > text.length) continue;
        return candidate;
      }
      return null;
    }

    /**
     * Build the registered component.
     * @param ctx - Client plugin context.
     * @param translate - Translate function bound to this plugin's namespace.
     * @returns the React component registered into the slot.
     */
    function createButton(ctx, translate) {
      return function PromptBoostButton({ useInput, inputActions, sessionId }) {
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState(null);
        const [last, setLast] = React.useState(null);
        const [hasSelection, setHasSelection] = React.useState(false);
        const [, setLocaleRevision] = React.useState(0);
        const abortRef = React.useRef(null);
        const liveRef = React.useRef({ text: '', draftRev: undefined });
        const pendingSpanRef = React.useRef(null);
        const inputActionsRef = React.useRef(null);
        inputActionsRef.current = inputActions;

        React.useEffect(() => () => {
          if (abortRef.current !== null) abortRef.current.abort();
        }, []);
        React.useEffect(() => {
          try {
            const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
            const subscribe = locale?.subscribe;
            if (typeof subscribe !== 'function') return undefined;
            return subscribe(() => setLocaleRevision((revision) => revision + 1));
          } catch {
            return undefined;
          }
        }, []);
        // Keep the icon honest: while a composer selection exists the next click
        // rewrites that fragment, even when a revert is otherwise available.
        React.useEffect(() => {
          const sync = () => {
            try {
              setHasSelection(readSelection(inputActionsRef.current) !== null);
            } catch { /* ignore */ }
          };
          sync();
          try {
            document.addEventListener('selectionchange', sync);
            document.addEventListener('focusin', sync);
            document.addEventListener('focusout', sync);
            return () => {
              try {
                document.removeEventListener('selectionchange', sync);
                document.removeEventListener('focusin', sync);
                document.removeEventListener('focusout', sync);
              } catch { /* ignore */ }
            };
          } catch {
            return undefined;
          }
        }, []);

        if (typeof useInput !== 'function') return null;
        const draft = useInput((state) => state.draft);
        const phase = useInput((state) => state.phase);
        const occurrences = useInput((state) => state.occurrences);
        const attachmentIds = useInput((state) => state.attachmentIds);
        const draftRev = useInput((state) => state.draftRev);
        const text = typeof draft === 'string' ? draft : '';
        // Read by the in-flight request when it settles, so a draft edited during
        // the call is never clobbered.
        liveRef.current = { text, draftRev };

        const editable = phase === undefined || phase === 'plain';
        const referenceCount = Array.isArray(occurrences) ? occurrences.length : 0;
        const revertAvailable = !busy && last !== null && last.kind === 'draft' && text === last.enhanced;
        const canEnhance = !busy && editable && referenceCount === 0 && inputActions !== undefined
          && typeof inputActions.setDraft === 'function' && text.trim() !== '';
        const enhanceSelectionReady = hasSelection && canEnhance;
        const showRevert = revertAvailable && !enhanceSelectionReady;
        const canRun = showRevert || canEnhance;

        const title = (() => {
          if (busy) return translate('button.busy');
          if (error !== null) return `${translate('button.error')} · ${error}`;
          if (enhanceSelectionReady) return translate('button.tooltipSelection');
          if (revertAvailable) return translate('button.revert');
          if (text.trim() === '') return translate('button.empty');
          if (!editable) return translate('button.unavailable');
          if (referenceCount > 0) return translate('button.references');
          if (last !== null && last.kind === 'selection') return translate('button.selectionDone');
          return translate('button.tooltip');
        })();

        const run = async () => {
          if (busy) return;
          const stored = pendingSpanRef.current;
          pendingSpanRef.current = null;
          // A captured selection always means "rewrite the selection"; revert only
          // applies when nothing is selected.
          const span = canEnhance ? pickSpan([stored, readSelection(inputActions)], text, draftRev) : null;
          if (span === null) {
            if (revertAvailable) {
              try {
                inputActions.setDraft(last.original);
                setLast(null);
                setError(null);
                setHasSelection(false);
              } catch (failure) {
                setError(clip(failure instanceof Error ? failure.message : String(failure)));
              }
              return;
            }
            if (!canEnhance) return;
          }

          const controller = new AbortController();
          abortRef.current = controller;
          const snapshot = { text, draftRev, span };
          const target = snapshot.span === null ? text : text.slice(snapshot.span.start, snapshot.span.end);
          setBusy(true);
          setError(null);
          const attachmentPayloads = await readAttachmentPayloads(ctx, attachmentIds);
          try {
            const response = await fetch(ROUTE_ENHANCE, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-prompt-boost': '1' },
              body: JSON.stringify({
                text: target,
                sessionId,
                attachments: attachmentPayloads,
                selection: snapshot.span !== null,
                ...snapshot.span === null ? {} : { draft: snapshot.text },
              }),
              signal: controller.signal,
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok || payload === null || payload.ok !== true || typeof payload.text !== 'string') {
              const reason = payload !== null && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
              throw new Error(reason);
            }
            const live = liveRef.current;
            if (live.text !== snapshot.text || live.draftRev !== snapshot.draftRev) {
              throw new Error(translate('button.stale'));
            }
            if (snapshot.span === null) {
              inputActions.setDraft(payload.text);
              setLast({ kind: 'draft', original: snapshot.text, enhanced: payload.text });
              setHasSelection(false);
            } else {
              const applied = inputActions.insertText(payload.text, snapshot.span);
              if (applied === false) throw new Error(translate('button.stale'));
              setLast({ kind: 'selection' });
              setHasSelection(false);
            }
          } catch (failure) {
            if (failure instanceof Error && failure.name === 'AbortError') return;
            setError(clip(failure instanceof Error ? failure.message : String(failure)));
          } finally {
            abortRef.current = null;
            setBusy(false);
          }
        };

        /**
         * Capture the selection before this control takes focus from the editor.
         * Preventing the default also keeps the editor as the Ctrl/Cmd+Z target.
         */
        const handleMouseDown = (event) => {
          try {
            event.preventDefault();
          } catch { /* keep going */ }
          pendingSpanRef.current = readSelection(inputActions);
          setHasSelection(readSelection(inputActions) !== null);
        };

        const icon = busy ? spinnerIcon() : showRevert ? undoIcon() : sparkleIcon();
        return h('button', {
          type: 'button',
          className: BUTTON_CLASS,
          title,
          'aria-label': translate(showRevert ? 'button.revertLabel' : 'button.label'),
          'aria-busy': busy ? 'true' : 'false',
          'data-busy': busy ? 'true' : 'false',
          'data-error': error !== null ? 'true' : 'false',
          'data-mode': showRevert ? 'revert' : 'enhance',
          disabled: !canRun,
          onMouseDown: handleMouseDown,
          onClick: run,
        }, h('span', { className: 'pb-boost-icon' }, icon));
      };
    }

    const CSS = `
.${BUTTON_CLASS}{border-radius:var(--dsw-radius-sm);height:28px;min-width:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;justify-content:center;gap:4px;padding:0 5px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex;flex:none}
.${BUTTON_CLASS}:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.${BUTTON_CLASS}:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.${BUTTON_CLASS}:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.${BUTTON_CLASS}[data-busy="true"]{cursor:progress}
.${BUTTON_CLASS}[data-mode="revert"]{color:var(--dsw-alias-label-primary,var(--dsw-alias-label-secondary))}
.${BUTTON_CLASS}[data-error="true"]{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary))}
.${BUTTON_CLASS} .pb-boost-icon{display:inline-flex;flex:none}
.${BUTTON_CLASS} .pb-boost-icon svg{display:block;width:15px;height:15px}
.${BUTTON_CLASS} .pb-boost-spin{animation:pb-boost-spin 1s linear infinite}
@keyframes pb-boost-spin{to{transform:rotate(360deg)}}
`;

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.effect(() => {
            const tag = document.createElement('style');
            tag.dataset.pluginCss = 'dsh-prompt-boost';
            tag.textContent = CSS;
            document.head.appendChild(tag);
            return () => {
              tag.remove();
            };
          }, 'prompt-boost: control styles');
        } catch { /* the control renders without its own stylesheet */ }

        let translate = localTranslate;
        try {
          translate = bindTranslate(ctx);
        } catch { /* local dictionary */ }

        try {
          const Button = createButton(ctx, translate);
          const slots = ctx.slots ?? (typeof ctx.get === 'function' ? ctx.get('slots') : undefined);
          if (slots === undefined || slots === null || typeof slots.inject !== 'function') return;
          slots.inject('conversation.input.right', () => slots.register({
            name: 'conversation.input.right',
            id: 'prompt-boost',
            order: 100,
          }, Button));
        } catch { /* the entry still activates; the control simply does not appear */ }
      },
    };
  },
});
