import type { Unstable_TriggerAdapter, Unstable_TriggerItem } from '@assistant-ui/core'
import { ComposerPrimitive, useAui, useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type DragEvent as ReactDragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { hermesDirectiveFormatter } from '@/components/assistant-ui/directive-text'
import { Button } from '@/components/ui/button'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useResizeObserver } from '@/hooks/use-resize-observer'
import { chatMessageText } from '@/lib/chat-messages'
import { DATA_IMAGE_URL_RE } from '@/lib/embedded-images'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import {
  $composerAttachments,
  clearComposerAttachments,
  type ComposerAttachment
} from '@/store/composer'
import {
  browseBackward,
  browseForward,
  deriveUserHistory,
  isBrowsingHistory,
  resetBrowseState
} from '@/store/composer-input-history'
import {
  $composerPopoutPosition,
  $composerPoppedOut,
  POPOUT_WIDTH_REM,
  readPopoutBounds,
  setComposerPoppedOut,
  setComposerPopoutPosition
} from '@/store/composer-popout'
import {
  $queuedPromptsBySession,
  enqueueQueuedPrompt,
  type QueuedPromptEntry,
  removeQueuedPrompt,
  updateQueuedPrompt
} from '@/store/composer-queue'
import { $statusItemsBySession } from '@/store/composer-status'
import { $previewStatusBySession } from '@/store/preview-status'
import { notify } from '@/store/notifications'
import { $gatewayState, $messages, setSessionPickerOpen } from '@/store/session'
import { $threadScrolledUp } from '@/store/thread-scroll'
import { isSecondaryWindow } from '@/store/windows'
import { useTheme } from '@/themes'

import { extractDroppedFiles, HERMES_PATHS_MIME } from '../hooks/use-composer-actions'

import { AttachmentList } from './attachments'
import { ContextMenu } from './context-menu'
import { ComposerControls } from './controls'
import { COMPOSER_DROP_ACTIVE_CLASS, COMPOSER_DROP_FADE_CLASS } from './drop-affordance'
import {
  type ComposerInsertMode,
  focusComposerInput,
  markActiveComposer,
  onComposerFocusRequest,
  onComposerInsertRefsRequest,
  onComposerInsertRequest,
  onComposerVoiceToggleRequest
} from './focus'
import { HelpHint } from './help-hint'
import { useAtCompletions } from './hooks/use-at-completions'
import { useComposerPopoutGestures } from './hooks/use-popout-drag'
import { useSlashCompletions } from './hooks/use-slash-completions'
import { useVoiceConversation } from './hooks/use-voice-conversation'
import { useVoiceRecorder } from './hooks/use-voice-recorder'
import { dragHasAttachments, droppedFileInlineRef, insertInlineRefsIntoEditor } from './inline-refs'
import { QueuePanel } from './queue-panel'
import {
  composerPlainText,
  deleteChipBeforeCaret,
  deleteSelectionInEditor,
  insertPlainTextAtCaret,
  normalizeComposerEditorDom,
  placeCaretEnd,
  refChipElement,
  renderComposerContents,
  RICH_INPUT_SLOT
} from './rich-editor'
import { SkinSlashPopover } from './skin-slash-popover'
import { detectTrigger, extractClipboardImageBlobs, textBeforeCaret, type TriggerState } from './text-utils'
import { ComposerTriggerPopover } from './trigger-popover'
import type { ChatBarProps } from './types'
import { UrlDialog } from './url-dialog'
import { VoiceActivity, VoicePlaybackActivity } from './voice-activity'

const COMPOSER_STACK_BREAKPOINT_PX = 320

const COMPOSER_FADE_BACKGROUND =
  'linear-gradient(to bottom, transparent, color-mix(in srgb, var(--dt-background) 10%, transparent))'

const pickPlaceholder = (pool: readonly string[]) => pool[Math.floor(Math.random() * pool.length)]

/** Completion items can carry an `action` (set in use-slash-completions) that
 *  runs a side effect on pick instead of inserting a chip — e.g. the session
 *  picker's "Browse all…" entry opens the overlay. Table-driven so new action
 *  items are a registry row, not a composer branch. */
const COMPLETION_ACTIONS: Record<string, () => void> = {
  'session-picker': () => setSessionPickerOpen(true)
}

/** Map a picked `/` completion to its pill accent. Driven by the completion
 *  group set in use-slash-completions (Skills / Themes / Commands|Options). */
function slashChipKindForItem(item: Unstable_TriggerItem): SlashChipKind {
  const group = (item.metadata as { group?: unknown } | undefined)?.group

  if (group === 'Skills') {
    return 'skill'
  }

  if (group === 'Themes') {
    return 'theme'
  }

  return 'command'
}

/** A `/` query is at its arg stage once it's past the command name. */
const slashArgStage = (query: string) => query.includes(' ')

/** The `/command` token of a slash query (`personality x` → `/personality`). */
const slashCommandToken = (query: string) => `/${query.split(/\s+/, 1)[0]?.toLowerCase() ?? ''}`

interface QueueEditState {
  attachments: ComposerAttachment[]
  draft: string
  entryId: string
  sessionKey: string
}

const cloneAttachments = (attachments: ComposerAttachment[]) => attachments.map(a => ({ ...a }))

export function ChatBar({
  busy,
  cwd,
  disabled,
  focusKey,
  gateway,
  maxRecordingSeconds = 120,
  queueSessionKey,
  sessionId,
  state,
  onCancel,
  onAddUrl,
  onAttachDroppedItems,
  onAttachImageBlob,
  onPasteClipboardImage,
  onPickFiles,
  onPickFolders,
  onPickImages,
  onRemoveAttachment,
  onSubmit,
  onTranscribeAudio
}: ChatBarProps) {
  const aui = useAui()
  const draft = useAuiState(s => s.composer.text)

  // assistant-ui's composer *mutators* (setText/send/…) throw "Composer is not
  // available" when the thread's composer core isn't bound yet — and unlike the
  // read path (`s.composer.text`, which is null-safe), there's no graceful
  // fallback. There's a startup/thread-swap window where this ChatBar's mount
  // effects (draft restore, clearDraft, external inserts) run before the core
  // binds; the popout refactor (#49488) widened it by moving the composer out
  // of the contain wrapper into a sibling of the thread, so the throw began
  // surfacing as an uncaught error that wedged the desktop input (#49903).
  //
  // Guard every mutation: if the core isn't ready, no-op the assistant-ui write.
  // The contentEditable DOM + draftRef already hold the text, and the
  // draft⇄editor sync reconciles composer state once the core attaches, so the
  // draft is never lost — only the (premature) state push is skipped.
  const setComposerText = useCallback(
    (value: string) => {
      try {
        aui.composer().setText(value)
      } catch {
        // Composer core not bound yet — DOM/draftRef carry the text; the sync
        // effect re-applies it after bind. Swallow so the input stays usable.
      }
    },
    [aui]
  )

  const attachments = useStore($composerAttachments)
  const queuedPromptsBySession = useStore($queuedPromptsBySession)
  const statusItemsBySession = useStore($statusItemsBySession)
  const previewStatusBySession = useStore($previewStatusBySession)
  const scrolledUp = useStore($threadScrolledUp)
  // Pop-out is a shared, persisted state — but secondary windows (the Ctrl+Shift+N
  // tiny window, subagent watch windows) always start docked and can't pop out:
  // a floating composer makes no sense in a single-session side window, and it
  // would otherwise write the shared atom and yank the main window's composer out.
  const popoutAllowed = !isSecondaryWindow()
  const poppedOut = useStore($composerPoppedOut) && popoutAllowed
  const popoutPosition = useStore($composerPopoutPosition)
  const activeQueueSessionKey = queueSessionKey || sessionId || null

  const queuedPrompts = useMemo(
    () => (activeQueueSessionKey ? (queuedPromptsBySession[activeQueueSessionKey] ?? []) : []),
    [activeQueueSessionKey, queuedPromptsBySession]
  )

  // Status items (subagents, background processes) are keyed by the RUNTIME
  // session id — gateway events and process.list both speak that id. Only the
  // queue uses the stored-session fallback key (prompts can queue pre-resume).
  const statusSessionId = sessionId ?? null

  const statusStackVisible = useMemo(
    () =>
      queuedPrompts.length > 0 ||
      (statusSessionId
        ? (statusItemsBySession[statusSessionId]?.length ?? 0) > 0 ||
          (previewStatusBySession[statusSessionId]?.length ?? 0) > 0
        : false),
    [previewStatusBySession, queuedPrompts.length, statusItemsBySession, statusSessionId]
  )

  const composerRef = useRef<HTMLFormElement | null>(null)
  const composerSurfaceRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)

  const handleComposerPopOut = useCallback(() => {
    triggerHaptic('open')
    setComposerPoppedOut(true)
  }, [])

  const handleComposerDock = useCallback(() => {
    triggerHaptic('success')
    setComposerPoppedOut(false)
  }, [])

  // Double-click the grab area toggles dock/float. Undocking restores the last
  // position (the persisted atom is never cleared on dock).
  const handleComposerToggle = useCallback(() => {
    poppedOut ? handleComposerDock() : handleComposerPopOut()
  }, [handleComposerDock, handleComposerPopOut, poppedOut])

  const { dockProximity, dragging, onPointerDown: onComposerGesturePointerDown } =
    useComposerPopoutGestures({
      composerRef,
      onDock: handleComposerDock,
      onPopOut: handleComposerPopOut,
      poppedOut,
      position: popoutPosition
    })

  const draftRef = useRef(draft)
  const previousBusyRef = useRef(busy)
  const drainingQueueRef = useRef(false)
  const urlInputRef = useRef<HTMLInputElement | null>(null)

  const [urlOpen, setUrlOpen] = useState(false)
  const [urlValue, setUrlValue] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [voiceConversationActive, setVoiceConversationActive] = useState(false)
  const [tight, setTight] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [queueEdit, setQueueEdit] = useState<QueueEditState | null>(null)
  const [focusRequestId, setFocusRequestId] = useState(0)
  const dragDepthRef = useRef(0)
  const lastSpokenIdRef = useRef<string | null>(null)

  const narrow = useMediaQuery('(max-width: 30rem)')

  const at = useAtCompletions({ gateway: gateway ?? null, sessionId: sessionId ?? null, cwd: cwd ?? null })
  const slash = useSlashCompletions({ gateway: gateway ?? null })

  const stacked = expanded || narrow || tight
  const hasComposerPayload = draft.trim().length > 0 || attachments.length > 0
  const canSubmit = busy || hasComposerPayload
  const editingQueuedPrompt = queueEdit ? (queuedPrompts.find(entry => entry.id === queueEdit.entryId) ?? null) : null
  const busyAction = busy && hasComposerPayload ? 'queue' : 'stop'
  const showHelpHint = draft === '?'

  const { t } = useI18n()
  const gatewayState = useStore($gatewayState)
  const newSessionPlaceholders = t.composer.newSessionPlaceholders
  const followUpPlaceholders = t.composer.followUpPlaceholders
  const reconnecting = gatewayState === 'closed' || gatewayState === 'error'
  const inputDisabled = disabled && !reconnecting

  // Resting placeholder: a starter for brand-new sessions, a continuation for
  // existing ones. Picked once and only re-rolled when we genuinely move to a
  // *different* conversation. Critically, the first id assignment of a freshly
  // started session (null → id, on the first send) is treated as the same
  // conversation so the placeholder doesn't visibly flip mid-stream.
  const [restingPlaceholder, setRestingPlaceholder] = useState(() =>
    pickPlaceholder(sessionId ? followUpPlaceholders : newSessionPlaceholders)
  )

  const prevSessionIdRef = useRef(sessionId)

  useEffect(() => {
    const prev = prevSessionIdRef.current
    prevSessionIdRef.current = sessionId

    if (prev === sessionId) {
      return
    }

    // null → id: the new session we're already in just got persisted. Keep the
    // starter we showed instead of swapping to a follow-up under the user.
    if (prev == null && sessionId) {
      return
    }

    resetBrowseState(prev)
    setRestingPlaceholder(pickPlaceholder(sessionId ? followUpPlaceholders : newSessionPlaceholders))
  }, [followUpPlaceholders, newSessionPlaceholders, sessionId])

  // When the transport is disabled it's because the gateway isn't open.
  // Distinguish a cold start ("Starting Hermes...") from a dropped connection
  // we're trying to restore. During reconnect, keep the textbox editable so a
  // flaky network doesn't block drafting; only submit/backend actions stay
  // disabled until the gateway is open again.
  const placeholder = disabled
    ? reconnecting
      ? t.composer.placeholderReconnecting
      : t.composer.placeholderStarting
    : restingPlaceholder

  const focusInput = useCallback(() => {
    focusComposerInput(editorRef.current)
    markActiveComposer('main')
  }, [])

  const requestMainFocus = useCallback(() => {
    setFocusRequestId(id => id + 1)
  }, [])

  const appendExternalText = useCallback(
    (text: string, mode: ComposerInsertMode) => {
      const value = text.trim()

      if (!value) {
        return
      }

      const base = mode === 'inline' ? draftRef.current.trimEnd() : draftRef.current
      const sep = mode === 'inline' ? (base ? ' ' : '') : base && !base.endsWith('\n') ? '\n\n' : ''
      const next = `${base}${sep}${value}`

      draftRef.current = next
      setComposerText(next)

      const editor = editorRef.current

      if (editor) {
        renderComposerContents(editor, next)
        placeCaretEnd(editor)
      }

      setFocusRequestId(id => id + 1)
    },
    [setComposerText]
  )

  useEffect(() => {
    if (!inputDisabled) {
      focusInput()
    }
  }, [focusInput, focusKey, focusRequestId, inputDisabled])

  useEffect(() => {
    if (inputDisabled) {
      return undefined
    }

    const offFocus = onComposerFocusRequest(target => {
      if (target === 'main') {
        setFocusRequestId(id => id + 1)
      }
    })

    const offInsert = onComposerInsertRequest(({ mode, target, text }) => {
      if (target === 'main') {
        appendExternalText(text, mode)
      }
    })

    return () => {
      offFocus()
      offInsert()
    }
  }, [appendExternalText, inputDisabled])

  // Keep draftRef in sync with the assistant-ui composer state for callers
  // that read the latest text outside the React render cycle. We don't push
  // to `$composerDraft` per keystroke any more — nobody outside the composer
  // subscribes to it (verified by grep), and the round-trip
  // `setText` ⇄ `subscribe` ⇄ `setText` was adding two useEffects to the per-
  // keystroke critical path. `reconcileComposerTerminalSelections` only
  // matters when the draft is submitted; we now call it from the submit
  // path instead.
  useEffect(() => {
    draftRef.current = draft

    const editor = editorRef.current

    if (editor && document.activeElement !== editor && composerPlainText(editor) !== draft) {
      renderComposerContents(editor, draft)
    }
  }, [draft])

  useEffect(() => {
    if (urlOpen) {
      window.requestAnimationFrame(() => urlInputRef.current?.focus({ preventScroll: true }))
    }
  }, [urlOpen])

  // Track expansion via cheap heuristics (newline or length threshold) instead
  // of reading editor.scrollHeight on every keystroke. scrollHeight forces a
  // synchronous layout flush — measured at 2.27 layouts per character typed
  // (see scripts/leak-typing.mjs). With ~30 chars before a typical wrap on
  // composer-default-width, this heuristic flips at roughly the right time
  // and the user only notices if they type far past the wrap boundary
  // without a newline; in that case the ResizeObserver below catches it via
  // a height delta and we still expand.
  useEffect(() => {
    if (!draft) {
      setExpanded(false)

      return
    }

    if (expanded) {
      return
    }

    // Only a non-trailing newline forces an immediate expand. A trailing newline
    // (or phantom \n from contenteditable junk) is left to the ResizeObserver,
    // which expands only when the editor's real height actually grows.
    if (draft.trimEnd().includes('\n')) {
      setExpanded(true)
    }
  }, [draft, expanded])

  // Bucket measured heights so we only invalidate the global CSS var when
  // the size crosses a meaningful threshold. Without bucketing, the editor
  // grows ~1px per character → setProperty fires every keystroke → entire
  // tree's computed style is invalidated → next paint forces a full
  // recalculate-style pass. With an 8px bucket, the invalidation rate drops
  // ~8× and small char-by-char typing produces no style invalidation at all
  // until a wrap or row change actually happens.
  const lastBucketedHeightRef = useRef(0)
  const lastBucketedSurfaceHeightRef = useRef(0)
  const lastTightRef = useRef<boolean | null>(null)

  const syncComposerMetrics = useCallback(() => {
    const composer = composerRef.current

    if (!composer) {
      return
    }

    // Floating composer is out of the thread's flow — it must not reserve any
    // bottom clearance. Zero the measured vars so the thread reclaims the space.
    // (Read globals here so the callback stays stable; mirror the popoutAllowed
    // gate since secondary windows are forced docked.)
    if ($composerPoppedOut.get() && !isSecondaryWindow()) {
      const root = document.documentElement
      lastBucketedHeightRef.current = 0
      lastBucketedSurfaceHeightRef.current = 0
      root.style.setProperty('--composer-measured-height', '0px')
      root.style.setProperty('--composer-surface-measured-height', '0px')

      return
    }

    const { height, width } = composer.getBoundingClientRect()
    const surfaceHeight = composerSurfaceRef.current?.getBoundingClientRect().height
    const root = document.documentElement

    if (width > 0) {
      const nextTight = width < COMPOSER_STACK_BREAKPOINT_PX

      if (nextTight !== lastTightRef.current) {
        lastTightRef.current = nextTight
        setTight(nextTight)
      }
    }

    if (height > 0) {
      const bucket = Math.round(height / 8) * 8

      if (bucket !== lastBucketedHeightRef.current) {
        lastBucketedHeightRef.current = bucket
        root.style.setProperty('--composer-measured-height', `${bucket}px`)
      }
    }

    if (surfaceHeight && surfaceHeight > 0) {
      const bucket = Math.round(surfaceHeight / 8) * 8

      if (bucket !== lastBucketedSurfaceHeightRef.current) {
        lastBucketedSurfaceHeightRef.current = bucket
        root.style.setProperty('--composer-surface-measured-height', `${bucket}px`)
      }
    }
  }, [])

  useResizeObserver(syncComposerMetrics, composerRef, composerSurfaceRef)

  // Toggling pop-out changes whether the composer reserves thread clearance.
  // The ResizeObserver may not fire (the box can keep the same box size), so
  // re-sync explicitly: docked republishes the measured height, floating zeroes
  // it so the thread reclaims the bottom space.
  useEffect(() => {
    syncComposerMetrics()
  }, [poppedOut, syncComposerMetrics])

  // Keep the floating box on-screen: re-clamp (with the real measured size +
  // thread bounds) when it pops out and on every window resize — so a position
  // persisted on a bigger/other monitor, a shrunk window, or now-wider sidebar
  // can never strand it. The rAF pass re-clamps after layout settles (sidebar
  // widths, fonts), so anyone loading in out of bounds is pulled back + saved
  // even if the first measure was premature.
  useEffect(() => {
    if (!poppedOut) {
      return undefined
    }

    const reclamp = (persist: boolean) => {
      const el = composerRef.current
      const size = el ? { height: el.offsetHeight, width: el.offsetWidth } : undefined
      setComposerPopoutPosition($composerPopoutPosition.get(), { area: readPopoutBounds(el), persist, size })
    }

    reclamp(true)
    const raf = requestAnimationFrame(() => reclamp(true))
    const onResize = () => reclamp(false)
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [poppedOut])

  useEffect(() => {
    return () => {
      const root = document.documentElement
      root.style.removeProperty('--composer-measured-height')
      root.style.removeProperty('--composer-surface-measured-height')
    }
  }, [])

  const insertText = (text: string) => {
    const currentDraft = draftRef.current
    const sep = currentDraft && !currentDraft.endsWith('\n') ? '\n' : ''
    const nextDraft = `${currentDraft}${sep}${text}`

    draftRef.current = nextDraft
    setComposerText(nextDraft)

    // Push the new text into the contentEditable editor directly. Setting the
    // assistant-ui composer state alone is not enough: the draft→editor sync
    // effect only re-renders the editor when it is NOT focused
    // (document.activeElement !== editor), and the dictation/insert paths
    // typically run while the editor has (or immediately regains) focus — so
    // the store would hold the text but the visible editor would stay empty
    // and there'd be nothing to send. Mirror appendExternalText here.
    const editor = editorRef.current

    if (editor) {
      renderComposerContents(editor, nextDraft)
      placeCaretEnd(editor)
    }

    requestMainFocus()
  }

  const insertInlineRefs = (refs: string[]) => {
    const editor = editorRef.current

    if (!editor) {
      return false
    }

    const nextDraft = insertInlineRefsIntoEditor(editor, refs)

    if (nextDraft === null) {
      return false
    }

    draftRef.current = nextDraft
    setComposerText(nextDraft)
    requestMainFocus()

    return true
  }

  const selectSkinSlashCommand = (command: string) => {
    draftRef.current = command
    aui.composer().setText(command)
    requestMainFocus()
  }

  const [trigger, setTrigger] = useState<TriggerState | null>(null)
  const [triggerActive, setTriggerActive] = useState(0)
  const [triggerItems, setTriggerItems] = useState<readonly Unstable_TriggerItem[]>([])

  const refreshTrigger = useCallback(() => {
    const editor = editorRef.current

    if (!editor) {
      return
    }

    // Fast-bail: if neither `@` nor `/` appears in the current draft, there's
    // nothing for `detectTrigger` to match. Use `textContent` (cheap browser-
    // native walk) for the precondition check rather than `composerPlainText`
    // (recursive child walk with chip-aware logic). Only when a trigger char
    // is present do we pay the cost of the full walk + DOM range work.
    const rawText = editor.textContent ?? ''

    if (!rawText.includes('@') && !rawText.includes('/')) {
      if (trigger) {
        setTrigger(null)
        setTriggerActive(0)
      }

      return
    }

    const before = textBeforeCaret(editor)
    const found = detectTrigger(before ?? composerPlainText(editor))

    // The arg-stage popover is only useful for commands with an options screen.
    // For a no-arg command it would dead-end on "No matches", so drop it — the
    // directive is already complete.
    const detected =
      found?.kind === '/' && slashArgStage(found.query) && !desktopSlashCommandTakesArgs(slashCommandToken(found.query))
        ? null
        : found

    setTrigger(detected)
    setTriggerActive(0)
  }, [trigger])

  const handleEditorInput = (event: FormEvent<HTMLDivElement>) => {
    const editor = event.currentTarget

    if (editor.childNodes.length === 1 && editor.firstChild?.nodeName === 'BR') {
      editor.replaceChildren()
    }

    const nextDraft = composerPlainText(editor)

    if (nextDraft !== draftRef.current) {
      draftRef.current = nextDraft
      setComposerText(nextDraft)
    }

    window.setTimeout(refreshTrigger, 0)
  }

  const handleEditorInput = (event: FormEvent<HTMLDivElement>) => {
    // During IME composition the DOM contains uncommitted preedit text
    // mixed with real content.  Skip state writes — compositionend flushes
    // the finalized text (see onCompositionEnd).
    if (composingRef.current) {
      return
    }

    flushEditorToDraft(event.currentTarget)
  }

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const imageBlobs = extractClipboardImageBlobs(event.clipboardData)

    if (imageBlobs.length > 0) {
      event.preventDefault()

      if (onAttachImageBlob) {
        triggerHaptic('selection')

        for (const blob of imageBlobs) {
          void onAttachImageBlob(blob)
        }
      }

      return
    }

    // Trim surrounding whitespace so a copy that dragged along leading/trailing
    // blank lines (common when selecting from terminals, code blocks, web pages)
    // doesn't dump multiline padding into the composer. Internal newlines are
    // preserved — only the edges are cleaned up.
    const pastedText = event.clipboardData.getData('text').trim()

    if (!pastedText) {
      event.preventDefault()

      return
    }

    if (DATA_IMAGE_URL_RE.test(pastedText)) {
      event.preventDefault()

      return
    }

    event.preventDefault()
    insertPlainTextAtCaret(event.currentTarget, pastedText)
    flushEditorToDraft(event.currentTarget)
  }

  const triggerAdapter: Unstable_TriggerAdapter | null =
    trigger?.kind === '@' ? at.adapter : trigger?.kind === '/' ? slash.adapter : null

  useEffect(() => {
    if (!trigger || !triggerAdapter?.search) {
      setTriggerItems([])

      return
    }

    setTriggerItems(triggerAdapter.search(trigger.query))
  }, [trigger, triggerAdapter])

  const triggerLoading = trigger?.kind === '@' ? at.loading : trigger?.kind === '/' ? slash.loading : false

  // Suppress the "No matches" empty state once a slash command is past its name:
  // a no-arg command has nothing to offer, and a fully-typed arg commits on
  // Space/Tab — neither should dead-end on a popover.
  const argStageEmpty =
    trigger?.kind === '/' && slashArgStage(trigger.query) && !triggerLoading && !triggerItems.length

  const closeTrigger = () => {
    setTrigger(null)
    setTriggerItems([])
    setTriggerActive(0)
  }

  useEffect(() => {
    setTriggerActive(idx => Math.min(idx, Math.max(0, triggerItems.length - 1)))
  }, [triggerItems.length])

  // Commit the literally-typed `/command arg` as a directive chip — used when
  // the completion list is empty because the arg is already fully typed (the
  // backend completer drops exact matches). Reuses the chip path via a
  // synthetic item whose serialized form is the verbatim text.
  const commitTypedSlashDirective = () => {
    if (trigger?.kind !== '/') {
      return
    }

    const text = `/${trigger.query.trimEnd()}`

    replaceTriggerWithChip({
      id: text,
      type: 'slash',
      label: text.slice(1),
      metadata: { command: slashCommandToken(trigger.query), display: text, meta: '', group: '', action: '', rawText: text }
    })
  }

  const replaceTriggerWithChip = (item: Unstable_TriggerItem) => {
    const editor = editorRef.current

    if (!editor || !trigger) {
      return
    }

    // Action items (e.g. "Browse all sessions…") run a side effect instead of
    // inserting a chip: strip the typed trigger token, then fire the action.
    const completionAction = (item.metadata as { action?: unknown } | undefined)?.action
    const runAction = typeof completionAction === 'string' ? COMPLETION_ACTIONS[completionAction] : undefined

    if (runAction) {
      const current = composerPlainText(editor)
      const prefix = current.slice(0, Math.max(0, current.length - trigger.tokenLength))

      renderComposerContents(editor, prefix)
      placeCaretEnd(editor)
      draftRef.current = composerPlainText(editor)
      setComposerText(draftRef.current)
      closeTrigger()
      runAction()
      requestMainFocus()

      return
    }

    const serialized = hermesDirectiveFormatter.serialize(item)
    const starter = serialized.endsWith(':')
    const text = starter || serialized.endsWith(' ') ? serialized : `${serialized} `
    const directive = !starter && serialized.match(/^@([^:]+):(.+)$/)

    const finish = () => {
      draftRef.current = composerPlainText(editor)
      setComposerText(draftRef.current)
      requestMainFocus()
      starter ? window.setTimeout(refreshTrigger, 0) : closeTrigger()
    }

    const sel = window.getSelection()
    const range = sel?.rangeCount ? sel.getRangeAt(0) : null
    const node = range?.startContainer
    const offset = range?.startOffset ?? 0

    if (!sel || !range || node?.nodeType !== Node.TEXT_NODE || offset < trigger.tokenLength) {
      const current = composerPlainText(editor)
      renderComposerContents(editor, `${current.slice(0, Math.max(0, current.length - trigger.tokenLength))}${text}`)
      placeCaretEnd(editor)

      return finish()
    }

    const replaceRange = document.createRange()
    replaceRange.setStart(node, offset - trigger.tokenLength)
    replaceRange.setEnd(node, offset)
    replaceRange.deleteContents()

    if (directive) {
      const chip = refChipElement(directive[1], directive[2])
      const space = document.createTextNode(' ')
      const fragment = document.createDocumentFragment()
      fragment.append(chip, space)
      replaceRange.insertNode(fragment)

      const caret = document.createRange()
      caret.setStart(space, 1)
      caret.collapse(true)
      sel.removeAllRanges()
      sel.addRange(caret)

      return finish()
    }

    document.execCommand('insertText', false, text)
    finish()
  }

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // IME composition: Enter confirms composed text, not a message submission.
    // We check both composingRef (set by compositionstart/compositionend, robust
    // across browsers) and nativeEvent.isComposing (Chromium fallback).  Without
    // this guard, pressing Enter to finalise a Korean/Japanese/Chinese IME
    // preedit fires submitDraft() and splits the message mid-word.
    if (composingRef.current || event.nativeEvent.isComposing) {
      return
    }

    // Plain Backspace right after a directive chip: remove the chip + its
    // auto-inserted trailing space as one unit, so deleting a directive never
    // leaves an orphaned space. (Modified backspaces stay native.)
    if (
      event.key === 'Backspace' &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      deleteChipBeforeCaret(event.currentTarget)
    ) {
      event.preventDefault()
      flushEditorToDraft(event.currentTarget)

      return
    }

    // Non-collapsed Backspace/Delete: native selection-delete is ~O(n²) on large
    // drafts (Ctrl+A → Delete froze ~1.3s). Collapsed carets fall through.
    if (
      (event.key === 'Backspace' || event.key === 'Delete') &&
      deleteSelectionInEditor(event.currentTarget)
    ) {
      event.preventDefault()
      flushEditorToDraft(event.currentTarget)

      return
    }

    // Cmd/Ctrl+Shift+K drains the next queued message. Plain Cmd/Ctrl+K is
    // reserved for the global command palette.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault()

      if (!busy) {
        void drainNextQueued()
      }

      return
    }

    if (trigger && triggerItems.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setTriggerActive(idx => (idx + 1) % triggerItems.length)

        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setTriggerActive(idx => (idx - 1 + triggerItems.length) % triggerItems.length)

        return
      }

      // Enter / Tab / Space all accept the highlighted item: a no-arg command
      // commits its directive chip, an arg-taking command expands to its
      // options step, and an arg option commits the full `/cmd arg` chip. Space
      // is slash-only (an `@` mention takes a literal space) and gated to a
      // non-empty query so a bare `/ ` still types a space.
      const acceptOnSpace = event.key === ' ' && trigger.kind === '/' && Boolean(trigger.query.trim())
      const accept = event.key === 'Enter' || event.key === 'Tab' || acceptOnSpace

      if (accept) {
        event.preventDefault()
        const item = triggerItems[triggerActive]

        if (item) {
          replaceTriggerWithChip(item)
        }

        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        closeTrigger()

        return
      }
    }

    // Arg stage with nothing left to suggest — a fully-typed arg the backend
    // completer no longer echoes (it drops the exact match), e.g.
    // `/personality creative`. Space/Tab still commit what's typed as a single
    // directive chip; Enter falls through to submit (send it as-is).
    if (
      trigger?.kind === '/' &&
      !triggerItems.length &&
      (event.key === ' ' || event.key === 'Tab') &&
      slashArgStage(trigger.query) &&
      trigger.query.trim()
    ) {
      event.preventDefault()
      triggerKeyConsumedRef.current = true
      commitTypedSlashDirective()

      return
    }

    // ArrowUp/ArrowDown navigate, in priority order: the queue (edit entries in
    // place) then sent-message history. The history ring is derived from live
    // session messages each press — single source of truth, no mirror.
    if (event.key === 'ArrowUp') {
      const currentDraft = draftRef.current

      // Editing a queued turn → walk to the older entry.
      if (queueEdit && stepQueuedEdit(-1)) {
        event.preventDefault()
        triggerKeyConsumedRef.current = true

        return
      }

      // Empty composer + a queued turn → open the newest queued entry for edit
      // (the row's pencil), not a text recall. Enter saves it back to the queue.
      if (!currentDraft.trim() && !queueEdit && queuedPrompts.length > 0) {
        event.preventDefault()
        triggerKeyConsumedRef.current = true
        beginQueuedEdit(queuedPrompts[queuedPrompts.length - 1]!)

        return
      }

      // Don't hijack a typed draft unless already browsing — they'd lose it.
      if (currentDraft.trim() && !isBrowsingHistory(sessionId)) {
        return
      }

      event.preventDefault()
      triggerKeyConsumedRef.current = true

      // $messages is read imperatively (not subscribed) so the composer
      // doesn't re-render on every streaming delta flush.
      const history = deriveUserHistory($messages.get(), chatMessageText)
      const entry = browseBackward(sessionId, currentDraft, history)

      if (entry !== null) {
        loadIntoComposer(entry, $composerAttachments.get())
      }

      return
    }

    if (event.key === 'ArrowDown') {
      // Editing a queued turn → walk to the newer entry (past the newest exits).
      if (queueEdit) {
        event.preventDefault()
        triggerKeyConsumedRef.current = true
        stepQueuedEdit(1)

        return
      }

      // Browsing sent history → step toward the present, restoring the draft.
      if (isBrowsingHistory(sessionId)) {
        event.preventDefault()
        triggerKeyConsumedRef.current = true

        const history = deriveUserHistory($messages.get(), chatMessageText)
        const result = browseForward(sessionId, history)

        if (result !== null) {
          loadIntoComposer(result.text, $composerAttachments.get())
        }
      }

      return
    }

    // Cmd/Ctrl+Enter is reserved for steering the live run — never a send.
    // Steer when there's a steerable draft, otherwise swallow it so it can't
    // surprise-send. (Plain Enter still queues while busy / sends when idle.)
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
      event.preventDefault()

      if (canSteer) {
        steerDraft()
      }

      return
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()

      // Decide from the DOM, not React state. `hasComposerPayload` is derived
      // from the AUI composer state, which lags the latest keystroke by a
      // render, so on fast typing / IME the just-typed text isn't in state yet.
      // Without the live read, a real message typed while prompts are queued
      // would drain the queue instead of sending. submitDraft() re-syncs and
      // sends the live editor text.
      const editorText = editorRef.current ? composerPlainText(editorRef.current) : draftRef.current
      const hasLivePayload = editorText.trim().length > 0 || attachments.length > 0

      if (disabled) {
        return
      }

      if (!busy && !hasLivePayload && queuedPrompts.length > 0) {
        void drainNextQueued()

        return
      }

      submitDraft()
    }
  }

  const handleEditorKeyUp = () => {
    window.setTimeout(refreshTrigger, 0)
  }

  const resetDragState = () => {
    dragDepthRef.current = 0
    setDragActive(false)
  }

  const handleDragEnter = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!onAttachDroppedItems || !dragHasAttachments(event.dataTransfer, HERMES_PATHS_MIME)) {
      return
    }

    event.preventDefault()
    dragDepthRef.current += 1

    if (!dragActive) {
      setDragActive(true)
    }
  }

  const handleDragOver = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!onAttachDroppedItems || !dragHasAttachments(event.dataTransfer, HERMES_PATHS_MIME)) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!onAttachDroppedItems) {
      return
    }

    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)

    if (dragDepthRef.current === 0) {
      setDragActive(false)
    }
  }

  const handleDrop = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!onAttachDroppedItems) {
      return
    }

    event.preventDefault()
    resetDragState()

    const candidates = extractDroppedFiles(event.dataTransfer)

    if (candidates.length === 0) {
      return
    }

    if (Array.from(event.dataTransfer.types || []).includes(HERMES_PATHS_MIME)) {
      const refs = candidates
        .map(candidate => droppedFileInlineRef(candidate, cwd))
        .filter((ref): ref is string => Boolean(ref))

      if (insertInlineRefs(refs)) {
        triggerHaptic('selection')
      }

      return
    }

    void Promise.resolve(onAttachDroppedItems(candidates)).then(attached => {
      if (attached) {
        triggerHaptic('selection')
        requestMainFocus()
      }
    })
  }

  const handleInputDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!dragHasAttachments(event.dataTransfer, HERMES_PATHS_MIME)) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleInputDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!dragHasAttachments(event.dataTransfer, HERMES_PATHS_MIME)) {
      return
    }

    const candidates = extractDroppedFiles(event.dataTransfer)

    const refs = candidates
      .map(candidate => droppedFileInlineRef(candidate, cwd))
      .filter((ref): ref is string => Boolean(ref))

    if (!refs.length) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    resetDragState()

    if (insertInlineRefs(refs)) {
      triggerHaptic('selection')
    }
  }

  const clearDraft = useCallback(() => {
    setComposerText('')
    draftRef.current = ''

    if (editorRef.current) {
      editorRef.current.replaceChildren()
    }
  }, [setComposerText])

  const loadIntoComposer = (text: string, attachments: ComposerAttachment[]) => {
    draftRef.current = text
    setComposerText(text)
    $composerAttachments.set(cloneAttachments(attachments))

    const editor = editorRef.current

    if (editor) {
      renderComposerContents(editor, text)
      placeCaretEnd(editor)
    }
  }

  const beginQueuedEdit = (entry: QueuedPromptEntry) => {
    if (!activeQueueSessionKey || queueEdit) {
      return
    }

    setQueueEdit({
      attachments: cloneAttachments($composerAttachments.get()),
      draft: draftRef.current,
      entryId: entry.id,
      sessionKey: activeQueueSessionKey
    })
    loadIntoComposer(entry.text, entry.attachments)
    triggerHaptic('selection')
    focusInput()
  }

  const exitQueuedEdit = (action: 'cancel' | 'save'): boolean => {
    if (!queueEdit) {
      return false
    }

    if (action === 'save') {
      const text = draftRef.current
      const next = cloneAttachments($composerAttachments.get())

      if (!text.trim() && next.length === 0) {
        return false
      }

      const saved = updateQueuedPrompt(queueEdit.sessionKey, queueEdit.entryId, { attachments: next, text })
      triggerHaptic(saved ? 'success' : 'selection')
    } else {
      triggerHaptic('cancel')
    }

    loadIntoComposer(queueEdit.draft, queueEdit.attachments)
    setQueueEdit(null)
    focusInput()

    return true
  }

  const queueCurrentDraft = useCallback(() => {
    if (!activeQueueSessionKey || (!draft.trim() && attachments.length === 0)) {
      return false
    }

    if (!enqueueQueuedPrompt(activeQueueSessionKey, { text: draft, attachments })) {
      return false
    }

    clearDraft()
    clearComposerAttachments()
    triggerHaptic('selection')

    return true
  }, [activeQueueSessionKey, attachments, clearDraft, draft])

  // All queue drain paths share one lock + send-then-remove sequence.
  // `pickEntry` lets each caller choose head, by-id, or skip-edited.
  const runDrain = useCallback(
    async (pickEntry: (entries: QueuedPromptEntry[]) => QueuedPromptEntry | undefined): Promise<boolean> => {
      if (drainingQueueRef.current || !activeQueueSessionKey) {
        return false
      }

      const entry = pickEntry(queuedPrompts)

      if (!entry) {
        return false
      }

      drainingQueueRef.current = true

      try {
        const accepted = await Promise.resolve(
          onSubmit(entry.text, { attachments: entry.attachments, fromQueue: true })
        )

        if (accepted === false) {
          return false
        }

        removeQueuedPrompt(activeQueueSessionKey, entry.id)

        return true
      } finally {
        drainingQueueRef.current = false
      }
    },
    [activeQueueSessionKey, onSubmit, queuedPrompts]
  )

  const drainNextQueued = useCallback(
    () =>
      runDrain(entries => {
        const skip = queueEdit?.entryId

        return skip ? entries.find(e => e.id !== skip) : entries[0]
      }),
    [queueEdit, runDrain]
  )

  const sendQueuedNow = useCallback(
    (id: string) => runDrain(entries => entries.find(e => e.id === id && id !== queueEdit?.entryId)),
    [queueEdit, runDrain]
  )

  const interruptAndSendNextQueued = useCallback(async () => {
    if (queuedPrompts.length === 0) {
      return false
    }

    await Promise.resolve(onCancel())

    return drainNextQueued()
  }, [drainNextQueued, onCancel, queuedPrompts.length])

  // Auto-drain on busy → false (turn settled).
  useEffect(() => {
    const wasBusy = previousBusyRef.current
    previousBusyRef.current = busy

    if (busy || !wasBusy || queuedPrompts.length === 0) {
      return
    }

    void drainNextQueued()
  }, [busy, drainNextQueued, queuedPrompts.length])

  // Clean up queue edit when its target disappears (session swap or external delete).
  useEffect(() => {
    if (!queueEdit) {
      return
    }

    if (queueEdit.sessionKey === activeQueueSessionKey && editingQueuedPrompt) {
      return
    }

    loadIntoComposer(queueEdit.draft, queueEdit.attachments)
    setQueueEdit(null)
  }, [activeQueueSessionKey, editingQueuedPrompt, queueEdit]) // eslint-disable-line react-hooks/exhaustive-deps

  const submitDraft = () => {
    if (disabled) {
      return
    }

    // Source the text from the DOM editor, not React state. The AUI composer
    // state (`draft`) and the derived `hasComposerPayload` lag the DOM by a
    // render, so on fast typing or IME composition the final keystroke(s) may
    // not have synced yet — reading state here drops the message (Enter looks
    // like it does nothing; typing a trailing space only "fixes" it because the
    // extra input event forces a state sync). draftRef is updated on every
    // input event; refresh it from the editor once more to also cover an
    // in-flight keystroke that hasn't fired its input event yet.
    const editor = editorRef.current

    if (editor) {
      const domText = composerPlainText(editor)

      if (domText !== draftRef.current) {
        draftRef.current = domText
        setComposerText(domText)
      }
    }

    const text = draftRef.current
    const payloadPresent = text.trim().length > 0 || attachments.length > 0

    if (queueEdit) {
      exitQueuedEdit('save')
    } else if (busy) {
      if (hasComposerPayload) {
        queueCurrentDraft()
      } else if (queuedPrompts.length > 0) {
        void interruptAndSendNextQueued()
      } else {
        triggerHaptic('cancel')
        void Promise.resolve(onCancel())
      }
    } else if (!hasComposerPayload && queuedPrompts.length > 0) {
      void drainNextQueued()
    } else if (draft.trim() || attachments.length > 0) {
      const submitted = draft
      triggerHaptic('submit')
      clearDraft()
      void onSubmit(submitted)
    }

    focusInput()
  }

  const submitUrl = () => {
    const url = urlValue.trim()

    if (!url) {
      return
    }

    if (onAddUrl) {
      onAddUrl(url)
    } else {
      insertText(`@url:${url}`)
    }

    triggerHaptic('success')
    setUrlValue('')
    setUrlOpen(false)
  }

  const { dictate, voiceActivityState, voiceStatus } = useVoiceRecorder({
    focusInput,
    maxRecordingSeconds,
    onTranscript: insertText,
    onTranscribeAudio
  })

  const pendingResponse = () => {
    const messages = $messages.get()
    const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)

    if (!last || last.id === lastSpokenIdRef.current) {
      return null
    }

    const text = chatMessageText(last).trim()

    if (!text) {
      return null
    }

    return {
      id: last.id,
      pending: Boolean(last.pending),
      text
    }
  }

  const consumePendingResponse = () => {
    const messages = $messages.get()
    const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)

    if (last) {
      lastSpokenIdRef.current = last.id
    }
  }

  const submitVoiceTurn = async (text: string) => {
    if (busy) {
      return
    }

    triggerHaptic('submit')
    clearDraft()
    await onSubmit(text)
  }

  const conversation = useVoiceConversation({
    busy,
    consumePendingResponse,
    enabled: voiceConversationActive,
    onFatalError: () => setVoiceConversationActive(false),
    onSubmit: submitVoiceTurn,
    onTranscribeAudio,
    pendingResponse
  })

  // The `composer.voice` hotkey (Ctrl+B) toggles the conversation. Starting
  // with STT unconfigured lets the conversation surface its own "configure
  // speech-to-text" notice rather than silently no-opping.
  const toggleVoiceConversation = useCallback(() => {
    if (disabled) {
      return
    }

    if (voiceConversationActive) {
      setVoiceConversationActive(false)
      void conversation.end()
    } else {
      setVoiceConversationActive(true)
    }
  }, [conversation, disabled, voiceConversationActive])

  useEffect(() => onComposerVoiceToggleRequest(toggleVoiceConversation), [toggleVoiceConversation])

  const contextMenu = (
    <ContextMenu
      onInsertText={insertText}
      onOpenUrlDialog={() => {
        triggerHaptic('open')
        setUrlOpen(true)
      }}
      onPasteClipboardImage={onPasteClipboardImage}
      onPickFiles={onPickFiles}
      onPickFolders={onPickFolders}
      onPickImages={onPickImages}
      state={state}
    />
  )

  const controls = (
    <ComposerControls
      busy={busy}
      busyAction={busyAction}
      canSubmit={canSubmit}
      compactModelPill={poppedOut}
      conversation={{
        active: voiceConversationActive,
        level: conversation.level,
        muted: conversation.muted,
        onEnd: () => {
          setVoiceConversationActive(false)
          void conversation.end()
        },
        onStart: () => setVoiceConversationActive(true),
        onStopTurn: conversation.stopTurn,
        onToggleMute: conversation.toggleMute,
        status: conversation.status
      }}
      disabled={disabled}
      hasComposerPayload={hasComposerPayload}
      onDictate={dictate}
      state={state}
      voiceStatus={voiceStatus}
    />
  )

  const input = (
    <div className={cn('relative', stacked ? 'w-full' : 'min-w-(--composer-input-inline-min-width) flex-1')}>
      <div
        aria-disabled={inputDisabled ? true : undefined}
        aria-label={t.composer.message}
        autoCapitalize="off"
        autoCorrect="off"
        className={cn(
          'min-h-(--composer-input-min-height) max-h-(--composer-input-max-height) cursor-text overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] bg-transparent pb-1 pr-1 pt-1 leading-normal text-foreground outline-none disabled:cursor-not-allowed',
          'empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/60',
          '**:data-ref-text:cursor-default',
          stacked && 'pl-3',
          stacked ? 'w-full' : 'min-w-(--composer-input-inline-min-width) flex-1'
        )}
        contentEditable={!inputDisabled}
        data-placeholder={placeholder}
        data-slot={RICH_INPUT_SLOT}
        onBlur={() => window.setTimeout(closeTrigger, 80)}
        onDragOver={handleInputDragOver}
        onDrop={handleInputDrop}
        onFocus={() => markActiveComposer('main')}
        onInput={handleEditorInput}
        onKeyDown={handleEditorKeyDown}
        onKeyUp={handleEditorKeyUp}
        onMouseUp={refreshTrigger}
        onPaste={handlePaste}
        ref={editorRef}
        role="textbox"
        suppressContentEditableWarning
      />
      {/* assistant-ui requires ComposerPrimitive.Input somewhere in the tree
        so the composer-state binding (text + IME + paste + form-submit hookup)
        wires up. We render the real input UI ourselves above via the
        contentEditable, so the primitive is invisible (sr-only).

        IMPORTANT: don't let it render its default <TextareaAutosize>. That
        component runs `useLayoutEffect(resizeTextarea)` on every value change
        and reads `node.scrollHeight` against a hidden measurement textarea,
        forcing two synchronous layouts per keystroke for an element the
        user can't see. Profiling 400-char synthetic typing showed >900ms
        cumulative cost in getHeight2/calculateNodeHeight alone (~2.3ms/key)
        on top of the per-keystroke React commit.

        `asChild` swaps TextareaAutosize for a Radix Slot wrapping our
        plain <textarea>, which carries the binding but skips autosize. */}
      <ComposerPrimitive.Input asChild tabIndex={-1} unstable_focusOnScrollToBottom={false}>
        <textarea aria-hidden className="sr-only" tabIndex={-1} />
      </ComposerPrimitive.Input>
    </div>
  )

  return (
    <>
      {dragging && poppedOut && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-x-0 bottom-0 z-20 h-32"
          style={{
            // A bottom-centered radial glow — soft on every side by construction,
            // so it reads as the dock target without any hard band edges. Its
            // intensity tracks how close the composer is to the dock (1 = peak).
            background:
              'radial-gradient(64% 130% at 50% 100%, color-mix(in srgb, var(--color-primary) 26%, transparent) 0%, transparent 70%)',
            // Scaled by --dock-glow-scale (lower in light mode — see styles.css).
            opacity: `calc(${0.1 + dockProximity * 0.57} * var(--dock-glow-scale, 1))`
          }}
        />
      )}
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
        <ComposerPrimitive.Root
          className={cn(
            'group/composer z-30 overflow-visible rounded-2xl',
            poppedOut
              ? // Floating: the composer (with its own border) floats with an even
                // 5px transparent grab margin around it — drag that to move it.
                'fixed w-[var(--composer-popout-width)] max-w-[calc(100vw-1.5rem)] bg-transparent p-[5px]'
              : 'absolute bottom-0 left-1/2 w-[min(var(--composer-width),calc(100%-2rem))] max-w-full -translate-x-1/2 pt-2 pb-[var(--composer-shell-pad-block-end)]',
            dragging && 'cursor-grabbing select-none touch-none'
          )}
          data-drag-active={dragActive ? '' : undefined}
          data-popped-out={poppedOut ? '' : undefined}
          data-slot="composer-root"
          data-thread-scrolled-up={scrolledUp ? '' : undefined}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onPointerDown={popoutAllowed ? onComposerGesturePointerDown : undefined}
          onSubmit={e => {
            e.preventDefault()
            submitDraft()
          }}
          ref={composerRef}
          style={
            poppedOut
              ? {
                  bottom: `${popoutPosition.bottom}px`,
                  right: `${popoutPosition.right}px`,
                  // A compact one-sentence width when floating.
                  ['--composer-popout-width' as string]: `${POPOUT_WIDTH_REM}rem`
                }
              : undefined
          }
        >
          {showHelpHint && <HelpHint />}
          {trigger && !argStageEmpty && (
            <ComposerTriggerPopover
              activeIndex={triggerActive}
              items={triggerItems}
              kind={trigger.kind}
              loading={triggerLoading}
              onHover={setTriggerActive}
              onPick={replaceTriggerWithChip}
            />
          )}
          {/* Session-scoped status stack (todos, subagents, background tasks,
              queue). Out of flow so it never inflates the composer's measured
              height; it overlays the chat instead of pushing it, and publishes
              its own --status-stack-measured-height so the thread's clearance
              accounts for it. Collapses to nothing when every status is empty. */}
          <ComposerStatusStack
            queue={
              activeQueueSessionKey && queuedPrompts.length > 0 ? (
                <QueuePanel
                  busy={busy}
                  editingId={queueEdit?.entryId ?? null}
                  entries={queuedPrompts}
                  onDelete={id => {
                    if (removeQueuedPrompt(activeQueueSessionKey, id) && queueEdit?.entryId === id) {
                      exitQueuedEdit('cancel')
                    }
                  }}
                  onEdit={beginQueuedEdit}
                  onSendNow={id => void sendQueuedNow(id)}
                />
              ) : null
            }
            sessionId={statusSessionId}
          />
          {!poppedOut && (
            <div
              className="pointer-events-none absolute inset-0 rounded-[inherit]"
              style={{ background: COMPOSER_FADE_BACKGROUND }}
            />
          )}
          {/* Drag region: covers the transparent grab margin around the surface.
              The surface sits on top (z-4) so only the exposed ring receives this
              element's hover/cursor — grab cursor + a diagonal hatch (/////)
              appear when you hover the draggable margin, never over the input.
              The hatch pattern + opacity ladder live in styles.css. */}
          {popoutAllowed && (
            <div
              aria-hidden
              className={cn('pointer-events-auto absolute inset-0', dragging ? 'cursor-grabbing' : 'cursor-grab')}
              data-dragging={dragging ? '' : undefined}
              data-slot="composer-drag-region"
              onDoubleClick={handleComposerToggle}
            />
          )}
          <div className="relative w-full rounded-[inherit]">
            <div
              className={cn(
                'relative z-4 isolate rounded-[inherit] border border-[color-mix(in_srgb,var(--dt-composer-ring)_calc(18%*var(--composer-ring-strength)),var(--dt-input))] shadow-composer transition-[border-color,box-shadow] duration-200 ease-out',
                COMPOSER_DROP_FADE_CLASS,
                dragActive && COMPOSER_DROP_ACTIVE_CLASS
              )}
              data-slot="composer-surface"
              ref={composerSurfaceRef}
            >
              <div
                aria-hidden
                className={cn(
                  'pointer-events-none absolute inset-0 -z-10 rounded-[inherit]',
                  'bg-[color-mix(in_srgb,var(--dt-card)_72%,transparent)]',
                  'backdrop-blur-[0.75rem] backdrop-saturate-[1.12]',
                  '[-webkit-backdrop-filter:blur(0.75rem)_saturate(1.12)]',
                  'transition-[background-color] duration-150 ease-out',
                  'group-data-[thread-scrolled-up]/composer:bg-[color-mix(in_srgb,var(--dt-card)_48%,transparent)]',
                  'group-focus-within/composer:bg-[color-mix(in_srgb,var(--dt-card)_85%,transparent)]'
                )}
              />
              <div
                className={cn(
                  'relative z-1 flex min-h-0 w-full flex-col gap-(--composer-row-gap) overflow-hidden rounded-[inherit] px-(--composer-surface-pad-x) py-(--composer-surface-pad-y) transition-opacity duration-200 ease-out',
                  scrolledUp
                    ? 'opacity-30 group-hover/composer:opacity-100 group-focus-within/composer:opacity-100'
                    : 'opacity-100'
                )}
                data-slot="composer-fade"
              >
                <VoiceActivity state={voiceActivityState} />
                <VoicePlaybackActivity />
                {queueEdit && editingQueuedPrompt && (
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-[color-mix(in_srgb,var(--dt-composer-ring)_32%,transparent)] bg-accent/18 px-2 py-1">
                    <div className="min-w-0 text-[0.7rem] text-muted-foreground/88">
                      Editing queued turn in composer
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        className="h-6 rounded-md px-2 text-[0.68rem]"
                        onClick={() => exitQueuedEdit('cancel')}
                        type="button"
                        variant="ghost"
                      >
                        Cancel
                      </Button>
                      <Button
                        className="h-6 rounded-md px-2 text-[0.68rem]"
                        onClick={() => exitQueuedEdit('save')}
                        type="button"
                      >
                        Save
                      </Button>
                    </div>
                  </div>
                )}
                {attachments.length > 0 && <AttachmentList attachments={attachments} onRemove={onRemoveAttachment} />}
                <div
                  className={cn(
                    'grid w-full',
                    stacked
                      ? 'grid-cols-[auto_1fr] gap-(--composer-row-gap) [grid-template-areas:"input_input"_"menu_controls"]'
                      : 'grid-cols-[auto_1fr_auto] items-end gap-(--composer-control-gap) [grid-template-areas:"menu_input_controls"]'
                  )}
                >
                  <div className="flex translate-y-[3px] items-start self-start [grid-area:menu]">{contextMenu}</div>
                  <div className="min-w-0 [grid-area:input]">{input}</div>
                  <div className="flex items-center justify-end [grid-area:controls]">{controls}</div>
                </div>
              </div>
            </div>
          </div>
        </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>

      <UrlDialog
        inputRef={urlInputRef}
        onChange={setUrlValue}
        onOpenChange={setUrlOpen}
        onSubmit={submitUrl}
        open={urlOpen}
        value={urlValue}
      />
    </>
  )
}

export function ChatBarFallback() {
  return (
    <div
      className={cn(
        'group/composer absolute bottom-0 left-1/2 z-30 w-[min(var(--composer-width),calc(100%-2rem))] max-w-full -translate-x-1/2 rounded-2xl pt-2 pb-[var(--composer-shell-pad-block-end)]',
        'bg-linear-to-b from-transparent to-background/55'
      )}
      data-slot="composer-root"
    >
      <div className="composer-fallback-surface relative isolate h-(--composer-fallback-height) w-full rounded-[inherit] border border-[color-mix(in_srgb,var(--dt-composer-ring)_calc(18%*var(--composer-ring-strength)),var(--dt-input))] shadow-composer">
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 -z-10 rounded-[inherit]',
            'bg-[color-mix(in_srgb,var(--dt-card)_72%,transparent)]',
            'backdrop-blur-[0.75rem] backdrop-saturate-[1.12]',
            '[-webkit-backdrop-filter:blur(0.75rem)_saturate(1.12)]',
            'transition-[background-color] duration-150 ease-out',
            'group-data-[thread-scrolled-up]/composer:bg-[color-mix(in_srgb,var(--dt-card)_48%,transparent)]',
            'group-focus-within/composer:bg-[color-mix(in_srgb,var(--dt-card)_85%,transparent)]'
          )}
        />
      </div>
    </div>
  )
}
