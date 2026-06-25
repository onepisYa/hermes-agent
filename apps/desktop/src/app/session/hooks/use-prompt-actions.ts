import type { AppendMessage, ThreadMessage } from '@assistant-ui/react'
import { type MutableRefObject, useCallback } from 'react'

import { transcribeAudio } from '@/hermes'
import { appendTextPart, branchGroupForUser, type ChatMessage, chatMessageText, textPart } from '@/lib/chat-messages'
import {
  attachmentDisplayText,
  INTERRUPTED_MARKER,
  parseCommandDispatch,
  parseSlashCommand,
  pathLabel,
  SLASH_COMMAND_RE
} from '@/lib/chat-runtime'
import {
  type CommandsCatalogLike,
  desktopSlashUnavailableMessage,
  filterDesktopCommandsCatalog,
  isDesktopSlashCommand
} from '@/lib/desktop-slash-commands'
import { triggerHaptic } from '@/lib/haptics'
import { isProviderSetupErrorMessage } from '@/lib/provider-setup-errors'
import { setSessionYolo } from '@/lib/yolo-session'
import { openCommandPalettePage } from '@/store/command-palette'
import {
  $composerAttachments,
  addComposerAttachment,
  clearComposerAttachments,
  type ComposerAttachment,
  setComposerAttachmentUploadState,
  setComposerDraft,
  terminalContextBlocksFromDraft,
  updateComposerAttachment
} from '@/store/composer'
import { resetSessionBackground } from '@/store/composer-status'
import { clearPreviewArtifacts } from '@/store/preview-status'
import { clearNotifications, notify, notifyError } from '@/store/notifications'
import { requestDesktopOnboarding } from '@/store/onboarding'
import { setPetScale } from '@/store/pet-gallery'
import { $petGenInput, openPetGenerate } from '@/store/pet-generate'
import { $activeGatewayProfile, $newChatProfile, ensureGatewayProfile, normalizeProfileKey } from '@/store/profile'
import {
  $busy,
  $connection,
  $messages,
  $sessions,
  $yoloActive,
  setAwaitingResponse,
  setBusy,
  setMessages,
  setModelPickerOpen,
  setSessionPickerOpen,
  setSessions,
  setYoloActive
} from '@/store/session'
import { clearSessionSubagents } from '@/store/subagents'
import { clearSessionTodos } from '@/store/todos'

import type {
  BrowserManageResponse,
  ClientSessionState,
  FileAttachResponse,
  HandoffFailResponse,
  HandoffRequestResponse,
  HandoffStateResponse,
  ImageAttachResponse,
  SessionSteerResponse,
  SessionTitleResponse,
  SlashExecResponse
} from '../../types'

interface HandoffResult {
  ok: boolean
  error?: string
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isSessionIdCandidate(value: string): boolean {
  const trimmed = value.trim()

  return /^\d{8}_\d{6}_[A-Fa-f0-9]{6}$/.test(trimmed) || /^[A-Fa-f0-9]{32}$/.test(trimmed)
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('Could not read recorded audio'))
      }
    })
    reader.addEventListener('error', () => reject(reader.error || new Error('Could not read recorded audio')))
    reader.readAsDataURL(blob)
  })
}

function isProviderSetupError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)

  return isProviderSetupErrorMessage(message)
}

function inlineErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback

  return (raw.match(/Error invoking remote method '[^']+': Error: (.+)$/)?.[1] ?? raw).replace(/^Error:\s*/, '').trim()
}

interface PromptActionsOptions {
  activeSessionId: string | null
  activeSessionIdRef: MutableRefObject<string | null>
  busyRef: MutableRefObject<boolean>
  branchCurrentSession: () => Promise<boolean>
  createBackendSessionForSend: () => Promise<string | null>
  handleSkinCommand: (arg: string) => string
  requestGateway: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
  selectedStoredSessionIdRef: MutableRefObject<string | null>
  startFreshSessionDraft: () => void
  sttEnabled: boolean
  updateSessionState: (
    sessionId: string,
    updater: (state: ClientSessionState) => ClientSessionState,
    storedSessionId?: string | null
  ) => ClientSessionState
}

interface SubmitTextOptions {
  attachments?: ComposerAttachment[]
  fromQueue?: boolean
}

function renderCommandsCatalog(catalog: CommandsCatalogLike): string {
  const desktopCatalog = filterDesktopCommandsCatalog(catalog)

  const sections = desktopCatalog.categories?.length
    ? desktopCatalog.categories
    : [{ name: 'Desktop commands', pairs: desktopCatalog.pairs ?? [] }]

  const body = sections
    .filter(section => section.pairs.length > 0)
    .map(section => {
      const rows = section.pairs.map(([cmd, desc]) => `${cmd.padEnd(18)} ${desc}`)

      return [`${section.name}:`, ...rows].join('\n')
    })
    .join('\n\n')

  const tail = [
    desktopCatalog.skill_count ? `${desktopCatalog.skill_count} skill commands available.` : '',
    desktopCatalog.warning ? `warning: ${desktopCatalog.warning}` : ''
  ]
    .filter(Boolean)
    .join('\n')

  return [body || 'No desktop commands available.', tail].filter(Boolean).join('\n\n')
}

function slashStatusText(command: string, output: string): string {
  return [`slash:${command}`, output.trim()].filter(Boolean).join('\n')
}

function appendText(message: AppendMessage): string {
  return message.content
    .map(part => ('text' in part ? part.text : ''))
    .join('')
    .trim()
}

function visibleUserOrdinal(messages: readonly ChatMessage[], end: number): number {
  return messages.slice(0, end).filter(m => m.role === 'user' && !m.hidden).length
}

export function usePromptActions({
  activeSessionId,
  activeSessionIdRef,
  busyRef,
  branchCurrentSession,
  createBackendSessionForSend,
  handleSkinCommand,
  requestGateway,
  selectedStoredSessionIdRef,
  startFreshSessionDraft,
  sttEnabled,
  updateSessionState
}: PromptActionsOptions) {
  const appendSessionTextMessage = useCallback(
    (sessionId: string, role: ChatMessage['role'], text: string) => {
      const body = text.trim()

      if (!body) {
        return
      }

      updateSessionState(
        sessionId,
        state => ({
          ...state,
          messages: [
            ...state.messages,
            {
              id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              role,
              parts: [textPart(body)]
            }
          ]
        }),
        selectedStoredSessionIdRef.current
      )
    },
    [selectedStoredSessionIdRef, updateSessionState]
  )

  const syncImageAttachmentsForSubmit = useCallback(
    async (
      sessionId: string,
      attachments: ComposerAttachment[],
      options: { updateComposerAttachments?: boolean } = {}
    ) => {
      const updateComposerAttachments = options.updateComposerAttachments ?? true
      const images = attachments.filter(attachment => attachment.kind === 'image' && attachment.path)

      for (const attachment of images) {
        if (attachment.attachedSessionId === sessionId) {
          continue
        }

        const result = await requestGateway<ImageAttachResponse>('image.attach', {
          session_id: sessionId,
          path: attachment.path
        })

        if (!result.attached) {
          const label = attachment.label || (attachment.path ? pathLabel(attachment.path) : 'image')
          throw new Error(result.message || `Could not attach ${label}`)
        }

        const attachedPath = result.path || attachment.path

        if (updateComposerAttachments) {
          addComposerAttachment({
            ...attachment,
            id: attachment.id,
            label: attachedPath ? pathLabel(attachedPath) : attachment.label,
            path: attachedPath,
            attachedSessionId: sessionId
          })
        }
      }
    },
    [requestGateway]
  )

  const submitPromptText = useCallback(
    async (rawText: string, options?: SubmitTextOptions) => {
      const visibleText = rawText.trim()
      const usingComposerAttachments = !options?.attachments
      // Drop undefined/null holes a session switch or draft restore can leave in
      // the attachments array (same bug class as AttachmentList #49624). Without
      // this, the sibling iterations below (a.kind / a.label / a.refText, and the
      // sync step) throw "Cannot read properties of undefined (reading 'refText')"
      // and break the chat surface.
      const attachments = (options?.attachments ?? $composerAttachments.get()).filter(
        (a): a is ComposerAttachment => Boolean(a)
      )

      const contextRefs = attachments
        .map(a => a.refText)
        .filter(Boolean)
        .join('\n')

      const terminalContextBlocks = terminalContextBlocksFromDraft(rawText).join('\n\n')
      const hasImage = attachments.some(a => a.kind === 'image')
      const attachmentRefs = attachments.map(attachmentDisplayText).filter((r): r is string => Boolean(r))

      const text =
        [contextRefs, terminalContextBlocks, visibleText].filter(Boolean).join('\n\n') ||
        (hasImage ? 'What do you see in this image?' : '')

      const buildContextText = (atts: ComposerAttachment[]): string => {
        // atts may be the post-sync array, which can reintroduce holes; filter
        // before touching a.refText / a.kind.
        const present = atts.filter((a): a is ComposerAttachment => Boolean(a))
        const contextRefs = present
          .map(a => a.refText)
          .filter(Boolean)
          .join('\n')

        return (
          [contextRefs, terminalContextBlocks, visibleText].filter(Boolean).join('\n\n') ||
          (present.some(a => a.kind === 'image') ? 'What do you see in this image?' : '')
        )
      }

      // Queue drains fire on the busy→false settle edge, where busyRef (synced
      // from $busy by a separate effect) may still read true — honoring it would
      // bounce the drained send. The drain lock serializes them; the user path
      // keeps the guard so a stray Enter mid-turn can't double-submit.
      const hasSendable = Boolean(visibleText || terminalContextBlocks || attachments.length || hasImage)

      if (!hasSendable || (!options?.fromQueue && busyRef.current)) {
        return false
      }

      const optimisticId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      const userMessage: ChatMessage = {
        id: optimisticId,
        role: 'user',
        parts: [textPart(visibleText || (attachmentRefs.length ? '' : attachments.map(a => a.label).join(', ')))],
        attachmentRefs
      }

      const releaseBusy = () => {
        busyRef.current = false
        setBusy(false)
        setAwaitingResponse(false)
      }

      // Idempotent optimistic insert — re-running with the resolved sessionId
      // after createBackendSessionForSend just overwrites with the same id.
      const seedOptimistic = (sid: string) =>
        updateSessionState(
          sid,
          state => ({
            ...state,
            messages: state.messages.some(m => m.id === optimisticId)
              ? state.messages
              : [...state.messages, userMessage],
            busy: true,
            awaitingResponse: true,
            pendingBranchGroup: null,
            sawAssistantPayload: false,
            interrupted: state.interrupted
          }),
          selectedStoredSessionIdRef.current
        )

      const dropOptimistic = (sid: null | string) => {
        if (!sid) {
          setMessages(current => current.filter(m => m.id !== optimisticId))

          return
        }

        updateSessionState(
          sid,
          state => ({
            ...state,
            messages: state.messages.filter(m => m.id !== optimisticId),
            busy: false,
            awaitingResponse: false,
            pendingBranchGroup: null
          }),
          selectedStoredSessionIdRef.current
        )
      }

      busyRef.current = true
      setBusy(true)
      setAwaitingResponse(true)
      clearNotifications()

      let sessionId: null | string = activeSessionId

      if (sessionId) {
        seedOptimistic(sessionId)
      } else {
        setMessages(current => [...current, userMessage])
      }

      if (!sessionId) {
        try {
          sessionId = await createBackendSessionForSend()
        } catch (err) {
          dropOptimistic(null)
          releaseBusy()
          notifyError(err, 'Session unavailable')

          return false
        }

        if (!sessionId) {
          dropOptimistic(null)
          releaseBusy()
          notify({ kind: 'error', title: 'Session unavailable', message: 'Could not create a new session' })

          return false
        }

        seedOptimistic(sessionId)
      }

      try {
        await syncImageAttachmentsForSubmit(sessionId, attachments, {
          updateComposerAttachments: usingComposerAttachments
        })
        await requestGateway('prompt.submit', { session_id: sessionId, text })

        if (usingComposerAttachments) {
          clearComposerAttachments()
        }

        return true
      } catch (err) {
        const message = inlineErrorMessage(err, 'Prompt failed')

        releaseBusy()
        updateSessionState(sessionId, state => ({
          ...state,
          messages: [
            ...state.messages,
            {
              id: `assistant-error-${Date.now()}`,
              role: 'assistant',
              parts: [],
              error: message || 'Prompt failed',
              branchGroupId: state.pendingBranchGroup ?? undefined
            }
          ],
          busy: false,
          awaitingResponse: false,
          pendingBranchGroup: null,
          sawAssistantPayload: true
        }))

        if (isProviderSetupError(err)) {
          requestDesktopOnboarding('Add a provider credential before sending your first message.')

          return false
        }

        notifyError(err, 'Prompt failed')

        return false
      }
    },
    [
      activeSessionId,
      busyRef,
      createBackendSessionForSend,
      requestGateway,
      selectedStoredSessionIdRef,
      syncImageAttachmentsForSubmit,
      updateSessionState
    ]
  )

  const executeSlashCommand = useCallback(
    async (rawCommand: string, options?: { sessionId?: string; recordInput?: boolean }) => {
      const runSlash = async (commandText: string, sessionHint?: string, recordInput = true): Promise<void> => {
        const command = commandText.trim()
        const { name, arg } = parseSlashCommand(command)
        const normalizedName = name.toLowerCase()

        if (!name) {
          const sessionId = sessionHint || activeSessionIdRef.current || (await createBackendSessionForSend())

          if (sessionId) {
            appendSessionTextMessage(sessionId, 'system', 'empty slash command')
          }

          return
        }

        if (normalizedName === 'new' || normalizedName === 'reset') {
          startFreshSessionDraft()

          return
        }

        if (normalizedName === 'branch' || normalizedName === 'fork') {
          await branchCurrentSession()

          return
        }

        if (normalizedName === 'skin' && !sessionHint && !activeSessionIdRef.current) {
          notify({ kind: 'success', message: handleSkinCommand(arg) })

          return
        }

        const sessionId = sessionHint || activeSessionIdRef.current || (await createBackendSessionForSend())

        if (!sessionId) {
          notify({
            kind: 'error',
            title: 'Session unavailable',
            message: 'Could not create a new session'
          })

          return
        }

        const renderSlashOutput = (text: string) =>
          appendSessionTextMessage(sessionId, 'system', recordInput ? slashStatusText(command, text) : text)

        if (normalizedName === 'skin') {
          renderSlashOutput(handleSkinCommand(arg))

          return
        }

        if (name === 'help' || name === 'commands') {
          try {
            const catalog = await requestGateway<CommandsCatalogLike>('commands.catalog', { session_id: sessionId })

            renderSlashOutput(renderCommandsCatalog(catalog))
          } catch (err) {
            renderSlashOutput(`error: ${err instanceof Error ? err.message : String(err)}`)
          }

          return
        }

        if (!isDesktopSlashCommand(name)) {
          renderSlashOutput(desktopSlashUnavailableMessage(name) || `/${name} is not available in the desktop app.`)

          return
        }

        const handleDispatch = async (dispatch: NonNullable<ReturnType<typeof parseCommandDispatch>>): Promise<void> => {
          if (dispatch.type === 'exec' || dispatch.type === 'plugin') {
            renderSlashOutput(dispatch.output ?? '(no output)')

            return
          }

          if (dispatch.type === 'alias') {
            await runSlash(`/${dispatch.target}${arg ? ` ${arg}` : ''}`, sessionId, false)

            return
          }

          // send / prefill carry an optional `notice` (e.g. "⊙ Goal set …")
          // that the backend wants shown as a system line before the message
          // is acted on. Mirrors the TUI's createSlashHandler — without it a
          // `/goal <text>` looked like it did nothing.
          if ((dispatch.type === 'send' || dispatch.type === 'prefill') && dispatch.notice?.trim()) {
            renderSlashOutput(dispatch.notice.trim())
          }

          const message = ('message' in dispatch ? dispatch.message : '')?.trim() ?? ''

          // /undo returns a prefill directive: drop the backed-up message into
          // the composer for editing instead of submitting it immediately.
          if (dispatch.type === 'prefill') {
            if (message) {
              setComposerDraft(message)
            }

            return
          }

          if (!message) {
            renderSlashOutput(
              `/${name}: ${dispatch.type === 'skill' ? 'skill payload missing message' : 'empty message'}`
            )

            return
          }

          if (dispatch.type === 'skill') {
            renderSlashOutput(`⚡ loading skill: ${dispatch.name}`)
          }

          if (busyRef.current) {
            renderSlashOutput('session busy — /interrupt the current turn before sending this command')

            return
          }

          await submitPromptText(message)
        }

        try {
          const result = await requestGateway<unknown>('slash.exec', {
            session_id: sessionId,
            command: command.replace(/^\/+/, '')
          })

          const dispatch = parseCommandDispatch(result)

          if (dispatch) {
            await handleDispatch(dispatch)

            return
          }

          const output = result && typeof result === 'object' ? (result as SlashExecResponse) : null
          const body = output?.output || `/${name}: no output`
          renderSlashOutput(output?.warning ? `warning: ${output.warning}\n${body}` : body)

          return
        } catch {
          // Fall back to command.dispatch for skill/send/alias directives.
        }

        try {
          const dispatch = parseCommandDispatch(
            await requestGateway<unknown>('command.dispatch', { session_id: sessionId, name, arg })
          )

          if (!dispatch) {
            renderSlashOutput('error: invalid response: command.dispatch')

            return
          }

          await handleDispatch(dispatch)
        } catch (err) {
          renderSlashOutput(`error: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // One handler per `action` command. Adding a desktop-native command is a
      // registry row in desktop-slash-commands.ts plus an entry here — never a
      // new branch in a dispatch ladder.
      const actionHandlers: Record<DesktopActionId, (ctx: SlashActionCtx) => Promise<void>> = {
        new: async () => {
          startFreshSessionDraft()
        },
        branch: async () => {
          await branchCurrentSession()
        },
        // /yolo maps to the status-bar YOLO control — a per-session approval
        // bypass, same scope as the TUI's Shift+Tab. With no session yet we arm
        // it locally; the session-create path applies it on the first message.
        yolo: async ({ sessionHint }) => {
          const sid = sessionHint || activeSessionIdRef.current
          const next = !$yoloActive.get()

          if (!sid) {
            setYoloActive(next)
            notify({ kind: 'success', message: next ? copy.yoloArmed : copy.yoloOff })

            return
          }

          try {
            const active = await setSessionYolo(requestGateway, sid, next)
            appendSessionTextMessage(sid, 'system', copy.yoloSystem(active))
          } catch {
            notify({ kind: 'error', title: copy.yoloTitle, message: copy.yoloToggleFailed })
          }
        },
        // /handoff hands this session to a messaging platform. The platform is
        // completed inline in the slash popover (backend _handoff_completions),
        // so there is no overlay: `/handoff <platform>` runs the desktop's own
        // handoff RPC. cli_only on the backend, so it must not reach slash.exec.
        handoff: async ({ arg, command, recordInput, sessionHint }) => {
          const platform = arg.trim()

          if (!platform) {
            notify({ kind: 'success', message: copy.handoff.pickPlatform })

            return
          }

          const sid = sessionHint || activeSessionIdRef.current

          if (!sid) {
            notify({ kind: 'error', title: copy.sessionUnavailable, message: copy.createSessionFailed })

            return
          }

          const result = await handoffSession(platform, { sessionId: sid })

          if (!result.ok && result.error) {
            appendSessionTextMessage(sid, 'system', recordInput ? slashStatusText(command, result.error) : result.error)
          }
        },
        // /profile selects which profile new chats open in — no app relaunch.
        // A profile is per-session now, so an existing thread can't change its
        // profile mid-stream; `/profile <name>` points the next new chat (and
        // the current empty draft) at that profile's backend.
        profile: async ({ arg }) => {
          const target = arg.trim()
          const current = normalizeProfileKey($activeGatewayProfile.get())

          if (!target) {
            notify({ kind: 'success', message: copy.profileStatus(current) })

            return
          }

          try {
            const { profiles } = await getProfiles()
            const match = profiles.find(profile => profile.name === target)

            if (!match) {
              notify({
                kind: 'error',
                title: copy.unknownProfile,
                message: copy.noProfileNamed(target, profiles.map(profile => profile.name).join(', '))
              })

              return
            }

            const key = normalizeProfileKey(match.name)

            $newChatProfile.set(key)
            await ensureGatewayProfile(key)
            notify({ kind: 'success', message: copy.newChatsProfile(match.name) })
          } catch (err) {
            notifyError(err, copy.setProfileFailed)
          }
        },
        skin: async ({ arg, command, recordInput, sessionHint }) => {
          const sid = sessionHint || activeSessionIdRef.current
          const message = handleSkinCommand(arg)

          // No session to print into yet — surface it as a toast instead of
          // spinning up a backend session just to change the theme.
          if (!sid) {
            notify({ kind: 'success', message })

            return
          }

          appendSessionTextMessage(sid, 'system', recordInput ? slashStatusText(command, message) : message)
        },
        // /title <name> renames via the gateway's session.title RPC — the same
        // path the TUI uses, NOT REST renameSession (which 404s on runtime ids)
        // nor the slash worker (whose DB write can silently fail). Bare /title
        // shows the current title, which the worker owns, so delegate to exec.
        title: async ctx => {
          if (!ctx.arg) {
            await runExec(ctx)

            return
          }

          const resolved = await withSlashOutput(ctx)

          if (!resolved) {
            return
          }

          const { render: renderSlashOutput, sessionId } = resolved
          const { arg } = ctx

          try {
            const result = await requestGateway<SessionTitleResponse>('session.title', {
              session_id: sessionId,
              title: arg
            })

            const finalTitle = (result?.title || arg).trim()
            const queued = result?.pending === true

            setSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, title: finalTitle || null } : s)))
            await refreshSessions().catch(() => undefined)
            renderSlashOutput(
              finalTitle
                ? `Session title set: ${finalTitle}${queued ? ' (queued while session initializes)' : ''}`
                : 'Session title cleared.'
            )
          } catch (err) {
            renderSlashOutput(`error: ${err instanceof Error ? err.message : String(err)}`)
          }
        },
        help: async ctx => {
          const resolved = await withSlashOutput(ctx)

          if (!resolved) {
            return
          }

          const { render: renderSlashOutput, sessionId } = resolved

          try {
            const catalog = await requestGateway<CommandsCatalogLike>('commands.catalog', { session_id: sessionId })

            renderSlashOutput(renderCommandsCatalog(catalog, copy))
          } catch (err) {
            renderSlashOutput(`error: ${err instanceof Error ? err.message : String(err)}`)
          }
        },
        // /hatch opens the pet generator overlay (the desktop's rich, multi-step
        // generate→pick→hatch→adopt flow). A typed description seeds the prompt
        // so `/hatch a cyber fox` lands on the composer step prefilled.
        hatch: async ({ arg }) => {
          const concept = arg.trim()

          if (concept) {
            $petGenInput.set(concept)
          }

          openPetGenerate()
        },
        pet: async ctx => {
          const [sub = '', rawValue = ''] = ctx.arg.trim().split(/\s+/)
          const lower = sub.toLowerCase()

          if (lower === 'list' || lower === 'gallery' || lower === 'browse' || lower === 'all') {
            openCommandPalettePage('pets')

            return
          }

          // `/pet scale <n>` resizes the floating pet locally (instant) and
          // persists via the store — no round-trip to the slash worker.
          if (lower === 'scale') {
            const value = Number(rawValue)

            if (!rawValue || Number.isNaN(value)) {
              const resolved = await withSlashOutput(ctx)
              resolved?.render('usage: /pet scale <factor>  (e.g. /pet scale 0.5)')

              return
            }

            setPetScale(requestGateway, value)

            return
          }

          await runExec(ctx)
        },
        // /browser connect|disconnect|status manages the live CDP connection on
        // the gateway host, mirroring the TUI's browser.manage RPC. It mutates
        // BROWSER_CDP_URL (and may launch Chrome) in the gateway process — only
        // meaningful when that process runs on this machine, so it's gated to
        // local connections. A remote gateway would act on the wrong host.
        browser: async ctx => {
          const resolved = await withSlashOutput(ctx)

          if (!resolved) {
            return
          }

          const { render: renderSlashOutput, sessionId } = resolved

          if ($connection.get()?.mode === 'remote') {
            renderSlashOutput(
              '/browser manages a Chromium-family browser on the gateway host — only available when connected to a local gateway.'
            )

            return
          }

          const [rawAction = 'status', ...rest] = ctx.arg.trim().split(/\s+/).filter(Boolean)
          const cmdAction = rawAction.toLowerCase()

          if (!['connect', 'disconnect', 'status'].includes(cmdAction)) {
            renderSlashOutput(
              'usage: /browser [connect|disconnect|status] [url] · persistent: set browser.cdp_url in config.yaml'
            )

            return
          }

          const url = cmdAction === 'connect' ? rest.join(' ').trim() || 'http://127.0.0.1:9222' : undefined

          if (url) {
            renderSlashOutput(`checking Chromium-family browser remote debugging at ${url}...`)
          }

          try {
            const result = await requestGateway<BrowserManageResponse>('browser.manage', {
              action: cmdAction,
              session_id: sessionId,
              ...(url && { url })
            })

            // Without a streamed session subscription, the gateway bundles its
            // progress lines into `messages` — flush them inline.
            result?.messages?.forEach(message => renderSlashOutput(message))

            if (cmdAction === 'status') {
              renderSlashOutput(
                result?.connected
                  ? `browser connected: ${result.url || '(url unavailable)'}`
                  : 'browser not connected (try /browser connect <url> or set browser.cdp_url in config.yaml)'
              )

              return
            }

            if (cmdAction === 'disconnect') {
              renderSlashOutput('browser disconnected')

              return
            }

            if (result?.connected) {
              renderSlashOutput('Browser connected to live Chromium-family browser via CDP')
              renderSlashOutput(`Endpoint: ${result.url || '(url unavailable)'}`)
              renderSlashOutput('next browser tool call will use this CDP endpoint')
            }
          } catch (err) {
            renderSlashOutput(`error: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }

      // Picker commands open a desktop overlay; a typed arg is resolved by that
      // picker so the command never dead-ends or falls through to the backend.
      const openPicker = async (pickerId: DesktopPickerId, ctx: SlashActionCtx): Promise<void> => {
        if (pickerId === 'model') {
          if (!ctx.arg.trim()) {
            setModelPickerOpen(true)

            return
          }

          // Power users can still type `/model <name>` — run it on the backend.
          await runExec(ctx)

          return
        }

        // session picker — /resume, /sessions, /switch
        const query = ctx.arg.trim()

        if (!query) {
          setSessionPickerOpen(true)

          return
        }

        const sessions = $sessions.get()
        const lower = query.toLowerCase()

        const match =
          sessions.find(session => session.id === query) ||
          sessions.find(session => sessionTitle(session).toLowerCase().includes(lower)) ||
          sessions.find(session => (session.preview ?? '').toLowerCase().includes(lower))

        if (!match) {
          if (isSessionIdCandidate(query)) {
            await resumeStoredSession(query)

            return
          }

          notify({ kind: 'error', message: copy.resumeFailed })

          return
        }

        await resumeStoredSession(match.id)
      }

      // The whole dispatcher: resolve the command's desktop surface, then act on
      // its kind. No per-command ladder — behavior lives in the registry.
      async function runSlash(commandText: string, sessionHint?: string, recordInput = true): Promise<void> {
        const command = commandText.trim()
        const { name, arg } = parseSlashCommand(command)

        if (!name) {
          const sessionId = await ensureSessionId(sessionHint)

          if (sessionId) {
            appendSessionTextMessage(sessionId, 'system', copy.emptySlashCommand)
          }

          return
        }

        const ctx: SlashActionCtx = { arg, command, name, recordInput, sessionHint }
        const surface = resolveDesktopCommand(`/${name}`)?.surface

        switch (surface?.kind) {
          case 'unavailable': {
            const resolved = await withSlashOutput(ctx)
            resolved?.render(desktopSlashUnavailableMessage(name) || `/${name} is not available in the desktop app.`)

            return
          }

          case 'picker':
            return openPicker(surface.picker, ctx)

          case 'action':
            return actionHandlers[surface.action](ctx)

          default:
            // exec spec, or an unknown skill / quick command the backend owns.
            return runExec(ctx)
        }
      }

      await runSlash(rawCommand, options?.sessionId, options?.recordInput ?? true)
    },
    [
      activeSessionIdRef,
      appendSessionTextMessage,
      branchCurrentSession,
      busyRef,
      createBackendSessionForSend,
      handleSkinCommand,
      requestGateway,
      startFreshSessionDraft,
      submitPromptText
    ]
  )

  const submitText = useCallback(
    async (rawText: string, options?: SubmitTextOptions) => {
      const visibleText = rawText.trim()
      const attachments = options?.attachments ?? $composerAttachments.get()

      if (!attachments.length && SLASH_COMMAND_RE.test(visibleText)) {
        triggerHaptic('selection')
        await executeSlashCommand(visibleText)

        return true
      }

      return await submitPromptText(rawText, options)
    },
    [executeSlashCommand, submitPromptText]
  )

  const transcribeVoiceAudio = useCallback(
    async (audio: Blob) => {
      if (!sttEnabled) {
        throw new Error('Speech-to-text is disabled in settings.')
      }

      const dataUrl = await blobToDataUrl(audio)
      const result = await transcribeAudio(dataUrl, audio.type)

      return result.transcript
    },
    [sttEnabled]
  )

  const cancelRun = useCallback(async () => {
    const sessionId = activeSessionId || activeSessionIdRef.current

    const releaseBusy = () => {
      setMutableRef(busyRef, false)
      setBusy(false)
    }

    busyRef.current = false
    setBusy(false)
    setAwaitingResponse(false)

    const finalizeMessages = (messages: ChatMessage[]) =>
      messages.map(message =>
        message.pending
          ? {
              ...message,
              parts: chatMessageText(message).trim()
                ? appendTextPart(message.parts, INTERRUPTED_MARKER)
                : [...message.parts, textPart(INTERRUPTED_MARKER.trim())],
              pending: false
            }
          : message
      )

    if (!sessionId) {
      setMessages(finalizeMessages($messages.get()))

      return
    }

    updateSessionState(sessionId, state => {
      const streamId = state.streamId

      const messages = streamId
        ? state.messages.map(message =>
            message.id === streamId
              ? {
                  ...message,
                  parts: chatMessageText(message).trim()
                    ? appendTextPart(message.parts, INTERRUPTED_MARKER)
                    : [...message.parts, textPart(INTERRUPTED_MARKER.trim())],
                  pending: false
                }
              : message
          )
        : finalizeMessages(state.messages)

      return {
        ...state,
        messages,
        busy: false,
        awaitingResponse: false,
        streamId: null,
        pendingBranchGroup: null,
        interrupted: true
      }
    })

    try {
      await requestGateway('session.interrupt', { session_id: sessionId })
    } catch (err) {
      notifyError(err, 'Stop failed')
    }
  }, [activeSessionId, activeSessionIdRef, busyRef, requestGateway, updateSessionState])

  const reloadFromMessage = useCallback(
    async (parentId: string | null) => {
      if (!activeSessionId || $busy.get()) {
        return
      }

      const messages = $messages.get()
      const parentIndex = parentId ? messages.findIndex(message => message.id === parentId) : messages.length - 1

      const userIndex =
        parentIndex >= 0
          ? [...messages.slice(0, parentIndex + 1)].reverse().findIndex(message => message.role === 'user')
          : -1

      if (userIndex < 0) {
        return
      }

      const absoluteUserIndex = parentIndex - userIndex
      const userMessage = messages[absoluteUserIndex]
      const userText = userMessage ? chatMessageText(userMessage).trim() : ''

      if (!userText) {
        return
      }

      const targetAssistant =
        parentId && messages[parentIndex]?.role === 'assistant'
          ? messages[parentIndex]
          : messages.slice(absoluteUserIndex + 1).find(message => message.role === 'assistant')

      const branchGroupId = targetAssistant?.branchGroupId ?? branchGroupForUser(userMessage)
      const truncateBeforeUserOrdinal = visibleUserOrdinal(messages, absoluteUserIndex)

      clearNotifications()
      updateSessionState(activeSessionId, state => {
        const nextUserIndex = state.messages.findIndex(
          (message, index) => index > absoluteUserIndex && message.role === 'user'
        )

        const end = nextUserIndex < 0 ? state.messages.length : nextUserIndex

        return {
          ...state,
          busy: true,
          awaitingResponse: true,
          pendingBranchGroup: branchGroupId,
          sawAssistantPayload: false,
          interrupted: false,
          messages: [
            ...state.messages.slice(0, absoluteUserIndex + 1),
            ...state.messages
              .slice(absoluteUserIndex + 1, end)
              .map(message => (message.role === 'assistant' ? { ...message, branchGroupId, hidden: true } : message))
          ]
        }
      })

      try {
        await requestGateway('prompt.submit', {
          session_id: activeSessionId,
          text: userText,
          truncate_before_user_ordinal: truncateBeforeUserOrdinal
        })
      } catch (err) {
        updateSessionState(activeSessionId, state => ({
          ...state,
          busy: false,
          awaitingResponse: false
        }))
        notifyError(err, 'Regenerate failed')
      }
    },
    [activeSessionId, copy.regenerateFailed, requestGateway, updateSessionState]
  )

  // Cursor-style "restore checkpoint": rewind the conversation to a past user
  // prompt and run it again from there. Reuses the edit composer's rewind
  // mechanism — `prompt.submit` with `truncate_before_user_ordinal` drops that
  // user turn and everything after it from the session history, then the same
  // text is submitted as a fresh turn. Callers confirm before invoking; errors
  // are rethrown so the confirmation dialog can surface them inline.
  // Submit a rewind (truncate-before-ordinal + resubmit). Because edit/restore
  // can fire while a turn is streaming, interrupt the live turn first — the
  // cooperative interrupt takes a beat, so the shared busy-retry rides it out.
  const submitRewindPrompt = useCallback(
    async (sessionId: string, text: string, truncateOrdinal: number | undefined, wasRunning: boolean) => {
      if (wasRunning) {
        try {
          await requestGateway('session.interrupt', { session_id: sessionId })
        } catch {
          // Best-effort — the busy-retry below still gates the submit.
        }
      }

      await withSessionBusyRetry(() =>
        requestGateway('prompt.submit', {
          session_id: sessionId,
          text,
          ...(truncateOrdinal !== undefined && { truncate_before_user_ordinal: truncateOrdinal })
        })
      )
    },
    [requestGateway]
  )

  const restoreToMessage = useCallback(
    async (messageId: string) => {
      const sessionId = activeSessionId || activeSessionIdRef.current

      if (!sessionId) {
        return
      }

      const messages = $messages.get()
      const sourceIndex = messages.findIndex(m => m.id === messageId)
      const source = messages[sourceIndex]

      if (!source || source.role !== 'user') {
        return
      }

      const text = chatMessageText(source).trim()

      if (!text) {
        return
      }

      const wasRunning = $busy.get()
      const truncateBeforeUserOrdinal = visibleUserOrdinal(messages, sourceIndex)

      // The turns we're discarding may have spawned todos and background
      // processes; they belong to the abandoned timeline, so wipe their status
      // rows (and kill the live processes) before the fresh run repopulates.
      clearSessionTodos(sessionId)
      resetSessionBackground(sessionId)
      clearPreviewArtifacts(sessionId)

      clearNotifications()
      setMutableRef(busyRef, true)
      setBusy(true)
      setAwaitingResponse(true)
      updateSessionState(sessionId, state => ({
        ...state,
        busy: true,
        awaitingResponse: true,
        pendingBranchGroup: null,
        sawAssistantPayload: false,
        interrupted: false,
        messages: state.messages.slice(0, sourceIndex + 1)
      }))

      try {
        await submitRewindPrompt(sessionId, text, truncateBeforeUserOrdinal, wasRunning)
      } catch (err) {
        setMutableRef(busyRef, false)
        setBusy(false)
        setAwaitingResponse(false)
        updateSessionState(sessionId, state => ({ ...state, busy: false, awaitingResponse: false }))
        throw err
      }
    },
    [activeSessionId, activeSessionIdRef, busyRef, submitRewindPrompt, updateSessionState]
  )

  const editMessage = useCallback(
    async (edited: AppendMessage) => {
      const sessionId = activeSessionId || activeSessionIdRef.current
      const sourceId = edited.sourceId || edited.parentId
      const text = appendText(edited)

      if (!sessionId || !sourceId || !text || edited.role !== 'user' || $busy.get()) {
        return
      }

      const messages = $messages.get()
      const sourceIndex = messages.findIndex(m => m.id === sourceId)
      const source = messages[sourceIndex]

      if (!source || source.role !== 'user' || chatMessageText(source).trim() === text) {
        return
      }

      // Failed turn: optimistic user msg never reached the gateway, so truncating
      // by ordinal would 422. Submit as a plain resend instead.
      const nextMessage = messages[sourceIndex + 1]
      const isFailedTurn = nextMessage?.role === 'assistant' && Boolean(nextMessage.error)
      const editedMessage: ChatMessage = { ...source, parts: [textPart(text)] }

      // Editing rewinds the conversation to this prompt — same as restore — so
      // drop the abandoned timeline's todos/background rows (and kill the live
      // processes) before the re-run repopulates them.
      clearSessionTodos(sessionId)
      resetSessionBackground(sessionId)
      clearPreviewArtifacts(sessionId)

      clearNotifications()
      busyRef.current = true
      setBusy(true)
      setAwaitingResponse(true)
      updateSessionState(sessionId, state => ({
        ...state,
        busy: true,
        awaitingResponse: true,
        pendingBranchGroup: null,
        sawAssistantPayload: false,
        interrupted: false,
        messages: [...state.messages.slice(0, sourceIndex), editedMessage]
      }))

      const submit = (truncateOrdinal?: number) =>
        requestGateway('prompt.submit', {
          session_id: sessionId,
          text,
          ...(truncateOrdinal !== undefined && { truncate_before_user_ordinal: truncateOrdinal })
        })

      const isStaleTargetError = (err: unknown) =>
        /no longer in session history|not in session history/i.test(err instanceof Error ? err.message : String(err))

      try {
        await submit(isFailedTurn ? undefined : visibleUserOrdinal(messages, sourceIndex))
      } catch (err) {
        let surfaced = err

        if (!isFailedTurn && isStaleTargetError(err)) {
          try {
            await submit()

            return
          } catch (retryErr) {
            surfaced = retryErr
          }
        }

        busyRef.current = false
        setBusy(false)
        setAwaitingResponse(false)
        updateSessionState(sessionId, state => ({ ...state, busy: false, awaitingResponse: false }))
        notifyError(surfaced, 'Edit failed')
      }
    },
    [activeSessionId, activeSessionIdRef, busyRef, requestGateway, updateSessionState]
  )

  const handleThreadMessagesChange = useCallback(
    (nextMessages: readonly ThreadMessage[]) => {
      const visibleIds = new Set(nextMessages.map(m => m.id))
      const sessionId = activeSessionIdRef.current

      if (!sessionId) {
        return
      }

      updateSessionState(sessionId, state => {
        let changed = false

        const messages = state.messages.map(message => {
          if (message.role !== 'assistant' || !message.branchGroupId) {
            return message
          }

          const hidden = !visibleIds.has(message.id)

          if (message.hidden === hidden) {
            return message
          }

          changed = true

          return { ...message, hidden }
        })

        return changed ? { ...state, messages } : state
      })
    },
    [activeSessionIdRef, updateSessionState]
  )

  return { cancelRun, editMessage, handleThreadMessagesChange, reloadFromMessage, submitText, transcribeVoiceAudio }
}
