import { useStore } from '@nanostores/react'
import { useQueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useCallback, useEffect, useRef } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'

import { BootFailureOverlay } from '@/components/boot-failure-overlay'
import { DesktopInstallOverlay } from '@/components/desktop-install-overlay'
import { DesktopOnboardingOverlay } from '@/components/desktop-onboarding-overlay'
import { GatewayConnectingOverlay } from '@/components/gateway-connecting-overlay'
import { Pane, PaneMain } from '@/components/pane-shell'
import { RemoteDisplayBanner } from '@/components/remote-display-banner'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useSkinCommand } from '@/themes/use-skin-command'

import { formatRefValue } from '../components/assistant-ui/directive-text'
import { getCronJobs, getSessionMessages, listAllProfileSessions, type SessionInfo, triggerCronJob } from '../hermes'
import { type ChatMessage, chatMessageText, preserveLocalAssistantErrors, toChatMessages } from '../lib/chat-messages'
import { storedSessionIdForNotification } from '../lib/session-ids'
import {
  $pinnedSessionIds,
  $sessionsLimit,
  bumpSessionsLimit,
  FILE_BROWSER_DEFAULT_WIDTH,
  FILE_BROWSER_MAX_WIDTH,
  FILE_BROWSER_MIN_WIDTH,
  pinSession,
  PREVIEW_PANE_ID,
  setSidebarOverlayMounted,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  unpinSession
} from '../store/layout'
import { respondToApprovalAction } from '../store/native-notifications'
import { setPetActivity } from '../store/pet'
import { setPetOverlayOpenAppHandler, setPetOverlaySubmitHandler } from '../store/pet-overlay'
import { $filePreviewTarget, $previewTarget, closeActiveRightRailTab } from '../store/preview'
import {
  $activeSessionId,
  $attentionSessionIds,
  $currentCwd,
  $freshDraftReady,
  $gatewayState,
  $messages,
  $messagingSessions,
  $resumeFailedSessionId,
  $resumeExhaustedSessionId,
  $selectedStoredSessionId,
  setAwaitingResponse,
  setBusy,
  setCurrentBranch,
  setCurrentCwd,
  setCurrentModel,
  setCurrentProvider,
  setMessages,
  setSessions,
  setSessionsLoading,
  setSessionsTotal
} from '../store/session'
import { onSessionsChanged } from '../store/session-sync'
import { clearSessionTodos, setSessionTodos, todoListActive } from '../store/todos'
import { openUpdatesWindow, startUpdatePoller, stopUpdatePoller } from '../store/updates'

import { ChatView } from './chat'
import { useComposerActions } from './chat/hooks/use-composer-actions'
import {
  ChatPreviewRail,
  PREVIEW_RAIL_MAX_WIDTH,
  PREVIEW_RAIL_MIN_WIDTH,
  PREVIEW_RAIL_PANE_WIDTH
} from './chat/right-rail'
import { ChatSidebar } from './chat/sidebar'
import { useGatewayBoot } from './gateway/hooks/use-gateway-boot'
import { useGatewayRequest } from './gateway/hooks/use-gateway-request'
import { ModelPickerOverlay } from './model-picker-overlay'
import { ModelVisibilityOverlay } from './model-visibility-overlay'
import { PetGenerateOverlay } from './pet-generate/pet-generate-overlay'
import { RightSidebarPane } from './right-sidebar'
import { $terminalTakeover } from './right-sidebar/store'
import { PersistentTerminal, TerminalSlot } from './right-sidebar/terminal/persistent'
import { NEW_CHAT_ROUTE, routeSessionId, sessionRoute } from './routes'
import { useContextSuggestions } from './session/hooks/use-context-suggestions'
import { useCwdActions } from './session/hooks/use-cwd-actions'
import { useHermesConfig } from './session/hooks/use-hermes-config'
import { useMessageStream } from './session/hooks/use-message-stream'
import { useModelControls } from './session/hooks/use-model-controls'
import { usePreviewRouting } from './session/hooks/use-preview-routing'
import { usePromptActions } from './session/hooks/use-prompt-actions'
import { useRouteResume } from './session/hooks/use-route-resume'
import { useSessionActions } from './session/hooks/use-session-actions'
import { useSessionStateCache } from './session/hooks/use-session-state-cache'
import { AppShell } from './shell/app-shell'
import { useOverlayRouting } from './shell/hooks/use-overlay-routing'
import { useStatusSnapshot } from './shell/hooks/use-status-snapshot'
import { useStatusbarItems } from './shell/hooks/use-statusbar-items'
import type { StatusbarItem } from './shell/statusbar-controls'
import type { TitlebarTool } from './shell/titlebar-controls'
import { useGroupRegistry } from './shell/use-group-registry'
import { UpdatesOverlay } from './updates-overlay'

const AgentsView = lazy(async () => ({ default: (await import('./agents')).AgentsView }))
const ArtifactsView = lazy(async () => ({ default: (await import('./artifacts')).ArtifactsView }))
const CommandCenterView = lazy(async () => ({ default: (await import('./command-center')).CommandCenterView }))
const CronView = lazy(async () => ({ default: (await import('./cron')).CronView }))
const MessagingView = lazy(async () => ({ default: (await import('./messaging')).MessagingView }))
const ProfilesView = lazy(async () => ({ default: (await import('./profiles')).ProfilesView }))
const SettingsView = lazy(async () => ({ default: (await import('./settings')).SettingsView }))
const SkillsView = lazy(async () => ({ default: (await import('./skills')).SkillsView }))

export function DesktopController() {
  const queryClient = useQueryClient()
  const location = useLocation()
  const navigate = useNavigate()

  const busyRef = useRef(false)
  const creatingSessionRef = useRef(false)
  const refreshSessionsRequestRef = useRef(0)

  const gatewayState = useStore($gatewayState)
  const activeSessionId = useStore($activeSessionId)
  const currentCwd = useStore($currentCwd)
  const freshDraftReady = useStore($freshDraftReady)
  const resumeFailedSessionId = useStore($resumeFailedSessionId)
  const resumeExhaustedSessionId = useStore($resumeExhaustedSessionId)
  const filePreviewTarget = useStore($filePreviewTarget)
  const previewTarget = useStore($previewTarget)
  const selectedStoredSessionId = useStore($selectedStoredSessionId)
  const terminalTakeover = useStore($terminalTakeover)

  const routedSessionId = routeSessionId(location.pathname)
  const routeToken = `${location.pathname}:${location.search}:${location.hash}`
  const routeTokenRef = useRef(routeToken)
  routeTokenRef.current = routeToken
  const getRouteToken = useCallback(() => routeTokenRef.current, [])

  const {
    agentsOpen,
    chatOpen,
    closeOverlayToPreviousRoute,
    commandCenterInitialSection,
    commandCenterOpen,
    currentView,
    openAgents,
    openCommandCenterSection,
    settingsOpen,
    toggleCommandCenter
  } = useOverlayRouting()

  const terminalTakeoverActive = chatOpen && terminalTakeover

  const titlebarToolGroups = useGroupRegistry<TitlebarTool>()
  const statusbarItemGroups = useGroupRegistry<StatusbarItem>()
  const setTitlebarToolGroup = titlebarToolGroups.set
  const setStatusbarItemGroup = statusbarItemGroups.set

  const {
    activeSessionIdRef,
    ensureSessionState,
    runtimeIdByStoredSessionIdRef,
    selectedStoredSessionIdRef,
    sessionStateByRuntimeIdRef,
    syncSessionStateToView,
    updateSessionState
  } = useSessionStateCache({
    activeSessionId,
    busyRef,
    selectedStoredSessionId,
    setAwaitingResponse,
    setBusy,
    setMessages
  })

  const { connectionRef, gatewayRef, requestGateway } = useGatewayRequest()

  useEffect(() => {
    window.hermesDesktop?.setPreviewShortcutActive?.(Boolean(chatOpen && (filePreviewTarget || previewTarget)))
  }, [chatOpen, filePreviewTarget, previewTarget])

  useEffect(() => {
    startUpdatePoller()
    const unsubscribe = window.hermesDesktop?.onOpenUpdatesRequested?.(() => openUpdatesWindow())

    return () => {
      unsubscribe?.()
      stopUpdatePoller()
    }
  }, [])

  // Notification click: the main process already focused the window; jump to its
  // session. Notifications are tagged with the gateway *runtime* session id, but
  // the chat route is keyed by the *stored* id — navigating with the runtime id
  // resumes a non-existent stored session ("session not found") and strands the
  // user. Translate runtime -> stored before navigating.
  useEffect(() => {
    const unsubscribe = window.hermesDesktop?.onFocusSession?.(sessionId => {
      if (sessionId) {
        navigate(sessionRoute(storedSessionIdForNotification(sessionId, runtimeIdByStoredSessionIdRef.current)))
      }
    })

    return () => unsubscribe?.()
  }, [navigate, runtimeIdByStoredSessionIdRef])

  // Notification action button (Approve/Reject) — resolve in place, no navigation.
  useEffect(() => {
    const unsubscribe = window.hermesDesktop?.onNotificationAction?.(({ actionId, sessionId }) => {
      void respondToApprovalAction(sessionId ?? null, actionId)
    })

    return () => unsubscribe?.()
  }, [])

  // hermes:// deep links (e.g. a docs "Send to App" button for an automation blueprint).
  // Build the equivalent /blueprint slash command from the payload and drop
  // it into the composer — the user reviews/edits, then sends; the agent (or
  // the shared command handler) creates the job. Signal readiness so a link
  // that arrived during boot is flushed exactly once.
  useEffect(() => {
    const unsubscribe = window.hermesDesktop?.onDeepLink?.(payload => {
      if (!payload || payload.kind !== 'blueprint' || !payload.name) {
        return
      }

      const slots = Object.entries(payload.params || {})
        .map(([k, v]) => {
          const sval = /\s/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v

          return `${k}=${sval}`
        })
        .join(' ')

      const command = `/blueprint ${payload.name}${slots ? ' ' + slots : ''}`
      requestComposerInsert(command, { mode: 'block', target: 'main' })
      requestComposerFocus('main')
    })

    // Tell the main process the renderer is ready to receive deep links.
    void window.hermesDesktop?.signalDeepLinkReady?.()

    return () => unsubscribe?.()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!$filePreviewTarget.get() && !$previewTarget.get()) {
        return
      }

      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        event.stopPropagation()
        closeActiveRightRailTab()
      }
    }

    const unsubscribe = window.hermesDesktop?.onClosePreviewRequested?.(closeActiveRightRailTab)

    window.addEventListener('keydown', onKeyDown, { capture: true })

    return () => {
      unsubscribe?.()
      window.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [])

  const refreshSessions = useCallback(async () => {
    const requestId = refreshSessionsRequestRef.current + 1
    refreshSessionsRequestRef.current = requestId
    setSessionsLoading(true)

    try {
      const limit = $sessionsLimit.get()
      // Require at least one message so abandoned/empty "Untitled" drafts (one
      // was created per TUI/desktop launch before the lazy-create fix) don't
      // clutter the sidebar.
      const result = await listSessions(limit, 1)

      if (refreshSessionsRequestRef.current === requestId) {
        setSessions(result.sessions)
        setSessionsTotal(typeof result.total === 'number' ? result.total : result.sessions.length)
      }
    } finally {
      if (refreshSessionsRequestRef.current === requestId) {
        setSessionsLoading(false)
      }
    }
  }, [])

  const loadMoreSessions = useCallback(() => {
    bumpSessionsLimit()
    void refreshSessions()
  }, [refreshSessions])

  // Another window mutated the shared session list (e.g. a chat started in the
  // pop-out). Re-pull so the sidebar reflects it. Pop-outs have no sidebar, so
  // only real windows bother.
  useEffect(() => {
    if (isSecondaryWindow()) {
      return
    }

    return onSessionsChanged(() => void refreshSessions().catch(() => undefined))
  }, [refreshSessions])

  // ALL-profiles view pages one profile at a time: fetch that profile's next
  // page and merge it in place, leaving every other profile's rows untouched.
  const loadMoreSessionsForProfile = useCallback(async (profile: string) => {
    const key = normalizeProfileKey(profile)
    const inKey = (s: SessionInfo) => normalizeProfileKey(s.profile) === key
    const loaded = $sessions.get().filter(inKey).length

    const result = await listAllProfileSessions(loaded + SIDEBAR_SESSIONS_PAGE_SIZE, 1, 'exclude', 'recent', key, {
      excludeSources: SIDEBAR_EXCLUDED_SOURCES
    })

    const keep = sessionsToKeep(key)

    setSessions(prev => [
      ...prev.filter(s => !inKey(s)),
      ...mergeSessionPage(prev.filter(inKey), result.sessions, keep)
    ])

    const total = result.profile_totals?.[key] ?? result.total ?? result.sessions.length
    setSessionProfileTotals(prev => ({ ...prev, [key]: Math.max(total, result.sessions.length) }))
  }, [])

  const toggleSelectedPin = useCallback(() => {
    const sessionId = $selectedStoredSessionId.get()

    if (!sessionId) {
      return
    }

    if ($pinnedSessionIds.get().includes(sessionId)) {
      unpinSession(sessionId)
    } else {
      pinSession(sessionId)
    }
  }, [])

  const { gatewayLogLines, inferenceStatus, statusSnapshot } = useStatusSnapshot(gatewayState, requestGateway)

  const updateActiveSessionRuntimeInfo = useCallback(
    (info: { branch?: string; cwd?: string }) => {
      const sessionId = activeSessionIdRef.current

      if (!sessionId) {
        return
      }

      updateSessionState(sessionId, state => ({
        ...state,
        branch: info.branch ?? state.branch,
        cwd: info.cwd ?? state.cwd
      }))
    },
    [activeSessionIdRef, updateSessionState]
  )

  const { changeSessionCwd, refreshProjectBranch } = useCwdActions({
    activeSessionId,
    activeSessionIdRef,
    onSessionRuntimeInfo: updateActiveSessionRuntimeInfo,
    requestGateway
  })

  const { refreshHermesConfig, sttEnabled, voiceMaxRecordingSeconds } = useHermesConfig({
    activeSessionIdRef,
    refreshProjectBranch
  })

  const { refreshCurrentModel, selectModel, updateModelOptionsCache } = useModelControls({
    activeSessionId,
    queryClient,
    requestGateway
  })

  useContextSuggestions({
    activeSessionId,
    activeSessionIdRef,
    currentCwd,
    gatewayState,
    requestGateway
  })

  const hydrateFromStoredSession = useCallback(
    async (
      attempts = 1,
      storedSessionId = selectedStoredSessionIdRef.current,
      runtimeSessionId = activeSessionIdRef.current
    ) => {
      if (!storedSessionId || !runtimeSessionId) {
        return
      }

      for (let index = 0; index < Math.max(1, attempts); index += 1) {
        try {
          const latest = await getSessionMessages(storedSessionId)
          updateSessionState(
            runtimeSessionId,
            state => ({
              ...state,
              messages: preserveLocalAssistantErrors(toChatMessages(latest.messages), state.messages)
            }),
            storedSessionId
          )

          return
        } catch {
          // Best-effort fallback when live stream payloads are empty.
        }

        if (index < attempts - 1) {
          await new Promise(resolve => window.setTimeout(resolve, 250))
        }
      }
    },
    [activeSessionIdRef, selectedStoredSessionIdRef, updateSessionState]
  )

  const { handleGatewayEvent } = useMessageStream({
    activeSessionIdRef,
    hydrateFromStoredSession,
    queryClient,
    refreshHermesConfig,
    refreshSessions,
    updateSessionState
  })

  const { handleDesktopGatewayEvent, restartPreviewServer } = usePreviewRouting({
    activeSessionIdRef,
    baseHandleGatewayEvent: handleGatewayEvent,
    currentCwd,
    currentView,
    requestGateway,
    routedSessionId,
    selectedStoredSessionId
  })

  const {
    archiveSession,
    branchCurrentSession,
    createBackendSessionForSend,
    openSettings,
    removeSession,
    resumeSession,
    selectSidebarItem,
    startFreshSessionDraft
  } = useSessionActions({
    activeSessionId,
    activeSessionIdRef,
    busyRef,
    creatingSessionRef,
    ensureSessionState,
    getRouteToken,
    navigate,
    requestGateway,
    runtimeIdByStoredSessionIdRef,
    selectedStoredSessionId,
    selectedStoredSessionIdRef,
    sessionStateByRuntimeIdRef,
    syncSessionStateToView,
    updateSessionState
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null

      const editing =
        target?.isContentEditable ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement

      if (editing || event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey) {
        return
      }

      if (event.shiftKey && event.code === 'KeyN') {
        event.preventDefault()
        startFreshSessionDraft()
      }
    }

    window.addEventListener('keydown', onKeyDown)

  // Swapping the live gateway to another profile must re-pull that profile's
  // global model + active-profile pill. Both are nanostores, so the blanket
  // invalidateQueries() the profile store fires on swap doesn't touch them —
  // without this the statusbar keeps showing the previous profile's model
  // (the "forgets the LLM setting" report). gatewayState stays 'open' across a
  // swap (background sockets persist), so the open→open effect won't re-run.
  const activeGatewayProfile = useStore($activeGatewayProfile)
  const lastGatewayProfileRef = useRef(activeGatewayProfile)

  useEffect(() => {
    if (activeGatewayProfile === lastGatewayProfileRef.current) {
      return
    }

    lastGatewayProfileRef.current = activeGatewayProfile
    // Force: the new profile has its own default, so reseed even if the composer
    // already shows the previous profile's model.
    void refreshCurrentModel(true)
    void refreshActiveProfile()
  }, [activeGatewayProfile, refreshCurrentModel])

  const composer = useComposerActions({
    activeSessionId,
    currentCwd,
    requestGateway
  })

  const branchInNewChat = useCallback(
    async (messageId?: string) => {
      const branched = await branchCurrentSession(messageId)

      if (branched) {
        await refreshSessions().catch(() => undefined)
      }

      return branched
    },
    [branchCurrentSession, refreshSessions]
  )

  // Clear a failed turn's red error banner from the transcript. Errors are
  // renderer-local state (never persisted), so dismissing is purely a view +
  // session-cache edit. A message that errored before emitting any visible
  // text is a bare error placeholder → drop it entirely; one that streamed
  // partial output then failed keeps its content and just sheds the error.
  // Both the per-runtime cache AND the live $messages view must be updated:
  // `preserveLocalAssistantErrors` re-grafts any still-errored message it
  // finds in the view onto the next session.info flush, so clearing only the
  // cache would let the heartbeat resurrect the banner.
  const dismissError = useCallback(
    (messageId: string) => {
      const runtimeSessionId = activeSessionIdRef.current

      if (!runtimeSessionId) {
        return
      }

      const clearErrorIn = (messages: ChatMessage[]): ChatMessage[] =>
        messages.flatMap(message => {
          if (message.id !== messageId || !message.error) {
            return [message]
          }

          if (!chatMessageText(message).trim() && !message.parts.some(part => part.type !== 'text')) {
            return []
          }

          return [{ ...message, error: undefined, pending: false }]
        })

      // View first: the flush below reads $messages as the "current" baseline
      // for error preservation, so the banner must be gone from it before the
      // cache update triggers a re-sync.
      setMessages(clearErrorIn($messages.get()))

      updateSessionState(runtimeSessionId, state => ({
        ...state,
        messages: clearErrorIn(state.messages)
      }))
    },
    [activeSessionIdRef, updateSessionState]
  )

  const startSessionInWorkspace = useCallback(
    (path: null | string) => {
      startFreshSessionDraft()

      const target = path?.trim()

      if (!target) {
        return
      }

      // The next message creates the backend session in $currentCwd, so seed
      // it (and the branch) from the workspace the user clicked the + on.
      setCurrentCwd(target)
      void requestGateway<{ branch?: string; cwd?: string }>('config.get', { key: 'project', cwd: target })
        .then(info => {
          setCurrentCwd(info.cwd || target)
          setCurrentBranch(info.branch || '')
        })
        .catch(() => undefined)
    },
    [requestGateway, startFreshSessionDraft]
  )

  const handleSkinCommand = useSkinCommand()

  const { cancelRun, editMessage, handleThreadMessagesChange, reloadFromMessage, submitText, transcribeVoiceAudio } =
    usePromptActions({
      activeSessionId,
      activeSessionIdRef,
      branchCurrentSession: branchInNewChat,
      busyRef,
      createBackendSessionForSend,
      handleSkinCommand,
      requestGateway,
      selectedStoredSessionIdRef,
      startFreshSessionDraft,
      sttEnabled,
      updateSessionState
    })

  // The popped-out pet drives two actions back into the app: send a prompt, and
  // open the most recent thread. Both are registered ONCE through refs that track
  // the latest callbacks — re-registering on every `submitText`/`resumeSession`
  // identity change left a brief window where the handler was nulled (cleanup
  // before re-register), which could drop a submit fired from the overlay (e.g.
  // creating a session from the new-session screen). The ref form keeps a stable,
  // always-current handler. Primary window only — it owns the overlay.
  const submitTextRef = useRef(submitText)
  submitTextRef.current = submitText
  const resumeSessionRef = useRef(resumeSession)
  resumeSessionRef.current = resumeSession

  useEffect(() => {
    if (isSecondaryWindow()) {
      return
    }

    setPetOverlaySubmitHandler(text => void submitTextRef.current(text))
    // Mail icon: $sessions is ordered most-recent-first; the pet is global (not
    // per session) so "most recent" is the right target. main.cjs already raised
    // the window before forwarding this.
    setPetOverlayOpenAppHandler(() => {
      const recent = $sessions.get()[0]

      if (recent?.id) {
        void resumeSessionRef.current(recent.id)
      }
    })

    return () => {
      setPetOverlaySubmitHandler(null)
      setPetOverlayOpenAppHandler(null)
    }
  }, [])

  // Mirror "a session is blocked on the user" (clarify/approval) into the pet's
  // awaitingInput flag so it shows the `waiting` pose. Lives on $petActivity so
  // it rides the same atom the pop-out overlay mirrors — no session list needed
  // there. Every window keeps its own in-window pet in sync.
  useEffect(() => {
    const sync = () => setPetActivity({ awaitingInput: $attentionSessionIds.get().length > 0 })

    sync()

    return $attentionSessionIds.listen(sync)
  }, [])

  useGatewayBoot({
    handleGatewayEvent: handleDesktopGatewayEvent,
    onConnectionReady: c => {
      connectionRef.current = c
    },
    onGatewayReady: g => {
      gatewayRef.current = g
    },
    refreshHermesConfig,
    refreshSessions
  })

  useEffect(() => {
    if (gatewayState === 'open') {
      void refreshCurrentModel()
      void refreshSessions().catch(() => undefined)
    }
  }, [gatewayState, refreshCurrentModel, refreshSessions])

  useRouteResume({
    activeSessionId,
    activeSessionIdRef,
    creatingSessionRef,
    currentView,
    freshDraftReady,
    gatewayState,
    locationPathname: location.pathname,
    resumeSession,
    resumeFailedSessionId,
    resumeExhaustedSessionId,
    routedSessionId,
    runtimeIdByStoredSessionIdRef,
    selectedStoredSessionId,
    selectedStoredSessionIdRef,
    startFreshSessionDraft
  })

  const { leftStatusbarItems, statusbarItems } = useStatusbarItems({
    agentsOpen,
    commandCenterOpen,
    extraLeftItems: statusbarItemGroups.flat.left,
    extraRightItems: statusbarItemGroups.flat.right,
    gatewayLogLines,
    gatewayState,
    inferenceStatus,
    openAgents,
    openCommandCenterSection,
    statusSnapshot,
    toggleCommandCenter
  })

  const sidebar = (
    <ChatSidebar
      currentView={currentView}
      onArchiveSession={sessionId => void archiveSession(sessionId)}
      onDeleteSession={sessionId => void removeSession(sessionId)}
      onLoadMoreSessions={loadMoreSessions}
      onNavigate={selectSidebarItem}
      onNewSessionInWorkspace={startSessionInWorkspace}
      onResumeSession={sessionId => navigate(sessionRoute(sessionId))}
    />
  )

  const overlays = (
    <>
      <RemoteDisplayBanner />
      {!isSecondaryWindow() && <DesktopInstallOverlay />}
      {!isSecondaryWindow() && (
        <DesktopOnboardingOverlay
          enabled={gatewayState === 'open'}
          onCompleted={() => {
            void refreshHermesConfig()
            void refreshCurrentModel()
            void queryClient.invalidateQueries({ queryKey: ['model-options'] })
          }}
          requestGateway={requestGateway}
        />
      )}
      <ModelPickerOverlay gateway={gatewayRef.current || undefined} onSelect={selectModel} />
      <UpdatesOverlay />
      <GatewayConnectingOverlay />
      <BootFailureOverlay />
      <CommandPalette />
      <PetGenerateOverlay />
      <SessionSwitcher />

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsView
            gateway={gatewayRef.current}
            onClose={closeOverlayToPreviousRoute}
            onConfigSaved={() => {
              void refreshHermesConfig()
              void refreshCurrentModel()
              void queryClient.invalidateQueries({ queryKey: ['model-options'] })
            }}
          />
        </Suspense>
      )}

      {commandCenterOpen && (
        <Suspense fallback={null}>
          <CommandCenterView
            initialSection={commandCenterInitialSection}
            onClose={closeOverlayToPreviousRoute}
            onDeleteSession={removeSession}
            onMainModelChanged={(provider, model) => {
              setCurrentProvider(provider)
              setCurrentModel(model)
              updateModelOptionsCache(provider, model, true)
              void refreshCurrentModel()
              void queryClient.invalidateQueries({ queryKey: ['model-options'] })
            }}
            onNavigateRoute={path => navigate(path)}
            onOpenSession={sessionId => navigate(sessionRoute(sessionId))}
          />
        </Suspense>
      )}

      {agentsOpen && (
        <Suspense fallback={null}>
          <AgentsView onClose={closeOverlayToPreviousRoute} />
        </Suspense>
      )}
    </>
  )

  const chatView = (
    <ChatView
      gateway={gatewayRef.current}
      maxVoiceRecordingSeconds={voiceMaxRecordingSeconds}
      modelMenuContent={modelMenuContent}
      onAddContextRef={composer.addContextRefAttachment}
      onAddUrl={url => composer.addContextRefAttachment(`@url:${formatRefValue(url)}`, url)}
      onAttachDroppedItems={composer.attachDroppedItems}
      onAttachImageBlob={composer.attachImageBlob}
      onBranchInNewChat={messageId => void branchInNewChat(messageId)}
      onCancel={cancelRun}
      onDeleteSelectedSession={() => {
        if (selectedStoredSessionId) {
          void removeSession(selectedStoredSessionId)
        }
      }}
      onDismissError={dismissError}
      onEdit={editMessage}
      onPasteClipboardImage={() => void composer.pasteClipboardImage()}
      onPickFiles={() => void composer.pickContextPaths('file')}
      onPickFolders={() => void composer.pickContextPaths('folder')}
      onPickImages={() => void composer.pickImages()}
      onReload={reloadFromMessage}
      onRemoveAttachment={id => void composer.removeAttachment(id)}
      onRestoreToMessage={restoreToMessage}
      onRetryResume={sessionId => void resumeSession(sessionId, true)}
      onSteer={steerPrompt}
      onSubmit={submitText}
      onThreadMessagesChange={handleThreadMessagesChange}
      onToggleSelectedPin={toggleSelectedPin}
      onTranscribeAudio={transcribeVoiceAudio}
    />
  )

  // Flipped layout mirrors the default: sessions sidebar → right, file
  // browser + preview rail → left. Same panes, swapped sides.
  const sidebarSide = panesFlipped ? 'right' : 'left'
  const railSide = panesFlipped ? 'left' : 'right'

  const previewPane = (
    <Pane
      disabled={!chatOpen || (!previewTarget && !filePreviewTarget)}
      id={PREVIEW_PANE_ID}
      key="preview"
      maxWidth={PREVIEW_RAIL_MAX_WIDTH}
      minWidth={PREVIEW_RAIL_MIN_WIDTH}
      resizable
      side={railSide}
      width={PREVIEW_RAIL_PANE_WIDTH}
    >
      {chatOpen ? (
        <ChatPreviewRail onRestartServer={restartPreviewServer} setTitlebarToolGroup={setTitlebarToolGroup} />
      ) : null}
    </Pane>
  )

  const fileBrowserPane = (
    <Pane
      defaultOpen={false}
      disabled={!chatOpen}
      forceCollapsed={narrowViewport}
      hoverReveal
      id="file-browser"
      key="file-browser"
      maxWidth={FILE_BROWSER_MAX_WIDTH}
      minWidth={FILE_BROWSER_MIN_WIDTH}
      resizable
      side={railSide}
      width={FILE_BROWSER_DEFAULT_WIDTH}
    >
      <RightSidebarPane
        onActivateFile={path => composer.insertContextPathInlineRef(path)}
        onActivateFolder={path => composer.insertContextPathInlineRef(path, true)}
        onChangeCwd={changeSessionCwd}
      />
    </Pane>
  )

  const terminalPane = (
    <Pane
      defaultOpen
      disabled={!terminalSidebarOpen}
      divider
      id="terminal-sidebar"
      key="terminal-sidebar"
      maxWidth="80vw"
      minWidth="22vw"
      resizable
      side={railSide}
      width="42vw"
    >
      <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-(--ui-editor-surface-background) pt-(--titlebar-height)">
        <TerminalSlot />
      </div>
    </Pane>
  )

  return (
    <AppShell
      commandCenterOpen={commandCenterOpen}
      leftStatusbarItems={leftStatusbarItems}
      leftTitlebarTools={titlebarToolGroups.flat.left}
      onOpenSearch={() => openCommandCenterSection('sessions')}
      onOpenSettings={openSettings}
      overlays={overlays}
      statusbarItems={statusbarItems}
      titlebarTools={titlebarToolGroups.flat.right}
    >
      <Pane
        disabled={terminalTakeoverActive}
        id="chat-sidebar"
        maxWidth={SIDEBAR_MAX_WIDTH}
        minWidth={SIDEBAR_DEFAULT_WIDTH}
        resizable
        side="left"
        width={`${SIDEBAR_DEFAULT_WIDTH}px`}
      >
        {sidebar}
      </Pane>
      <PaneMain>
        <Routes>
          <Route element={terminalTakeoverActive ? takeoverTerminalView : chatView} index />
          <Route element={terminalTakeoverActive ? takeoverTerminalView : chatView} path=":sessionId" />
          <Route
            element={
              <Suspense fallback={null}>
                <SkillsView setStatusbarItemGroup={setStatusbarItemGroup} />
              </Suspense>
            }
            path="skills"
          />
          <Route
            element={
              <Suspense fallback={null}>
                <MessagingView setStatusbarItemGroup={setStatusbarItemGroup} />
              </Suspense>
            }
            path="messaging"
          />
          <Route
            element={
              <Suspense fallback={null}>
                <ArtifactsView setStatusbarItemGroup={setStatusbarItemGroup} />
              </Suspense>
            }
            path="artifacts"
          />
          <Route
            element={
              <Suspense fallback={null}>
                <CronView setStatusbarItemGroup={setStatusbarItemGroup} />
              </Suspense>
            }
            path="cron"
          />
          <Route
            element={
              <Suspense fallback={null}>
                <ProfilesView
                  setStatusbarItemGroup={setStatusbarItemGroup}
                  setTitlebarToolGroup={setTitlebarToolGroup}
                />
              </Suspense>
            }
            path="profiles"
          />
          <Route element={null} path="settings" />
          <Route element={null} path="command-center" />
          <Route element={null} path="agents" />
          <Route element={<Navigate replace to={NEW_CHAT_ROUTE} />} path="new" />
          <Route element={<LegacySessionRedirect />} path="sessions/:sessionId" />
          <Route element={<Navigate replace to={NEW_CHAT_ROUTE} />} path="*" />
        </Routes>
      </PaneMain>
      <Pane
        disabled={!chatOpen || (!previewTarget && !filePreviewTarget)}
        id="preview"
        maxWidth={PREVIEW_RAIL_MAX_WIDTH}
        minWidth={PREVIEW_RAIL_MIN_WIDTH}
        resizable
        side="right"
        width={PREVIEW_RAIL_PANE_WIDTH}
      >
        {chatOpen ? (
          <ChatPreviewRail onRestartServer={restartPreviewServer} setTitlebarToolGroup={setTitlebarToolGroup} />
        ) : null}
      </Pane>
      <Pane
        defaultOpen={false}
        disabled={!chatOpen}
        id="file-browser"
        maxWidth={FILE_BROWSER_MAX_WIDTH}
        minWidth={FILE_BROWSER_MIN_WIDTH}
        resizable
        side="right"
        width={FILE_BROWSER_DEFAULT_WIDTH}
      >
        <RightSidebarPane
          onActivateFile={composer.attachContextFilePath}
          onActivateFolder={composer.attachContextFolderPath}
          onChangeCwd={changeSessionCwd}
        />
      </Pane>
    </AppShell>
  )
}

function LegacySessionRedirect() {
  const { sessionId } = useParams()

  return <Navigate replace to={sessionId ? sessionRoute(sessionId) : NEW_CHAT_ROUTE} />
}
