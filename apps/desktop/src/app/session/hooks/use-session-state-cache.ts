import { useStore } from '@nanostores/react'
import { type MutableRefObject, useCallback, useEffect, useRef } from 'react'

import type { ChatMessage } from '@/lib/chat-messages'
import { preserveLocalAssistantErrors } from '@/lib/chat-messages'
import { createClientSessionState } from '@/lib/chat-runtime'
import { setMutableRef } from '@/lib/mutable-ref'
import {
  $busy,
  $messages,
  noteSessionActivity,
  onSessionWatchdogClear,
  setCurrentFastMode,
  setCurrentModel,
  setCurrentPersonality,
  setCurrentProvider,
  setCurrentReasoningEffort,
  setCurrentServiceTier,
  setSessionAttention,
  setSessionWorking,
  setTurnStartedAt,
  setYoloActive
} from '@/store/session'

import type { ClientSessionState } from '../../types'

interface SessionStateCacheOptions {
  activeSessionId: string | null
  busyRef: MutableRefObject<boolean>
  selectedStoredSessionId: string | null
  setAwaitingResponse: (awaiting: boolean) => void
  setBusy: (busy: boolean) => void
  setMessages: (messages: ChatMessage[]) => void
}

export function useSessionStateCache({
  activeSessionId,
  busyRef,
  selectedStoredSessionId,
  setAwaitingResponse,
  setBusy,
  setMessages
}: SessionStateCacheOptions) {
  const busy = useStore($busy)
  const activeSessionIdRef = useRef<string | null>(null)
  const selectedStoredSessionIdRef = useRef<string | null>(null)
  const sessionStateByRuntimeIdRef = useRef(new Map<string, ClientSessionState>())
  const runtimeIdByStoredSessionIdRef = useRef(new Map<string, string>())
  const pendingViewStateRef = useRef<{ sessionId: string; state: ClientSessionState } | null>(null)
  const viewSyncRafRef = useRef<number | null>(null)
  // Runtime id whose transcript currently occupies `$messages` — lets the
  // flush below tell a same-session refresh from a thread switch.
  const viewSessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId
  }, [activeSessionId])

  useEffect(() => {
    busyRef.current = busy
  }, [busy, busyRef])

  useEffect(() => {
    selectedStoredSessionIdRef.current = selectedStoredSessionId
  }, [selectedStoredSessionId])

  const ensureSessionState = useCallback((sessionId: string, storedSessionId?: string | null) => {
    const existing = sessionStateByRuntimeIdRef.current.get(sessionId)

    if (existing) {
      if (storedSessionId !== undefined) {
        const previousStoredSessionId = existing.storedSessionId
        existing.storedSessionId = storedSessionId

        if (storedSessionId) {
          runtimeIdByStoredSessionIdRef.current.set(storedSessionId, sessionId)

          if (existing.busy) {
            setSessionWorking(storedSessionId, true)
          }
        }

        if (previousStoredSessionId && previousStoredSessionId !== storedSessionId) {
          setSessionWorking(previousStoredSessionId, false)
        }
      }

      return existing
    }

    const created = createClientSessionState(storedSessionId ?? null)
    sessionStateByRuntimeIdRef.current.set(sessionId, created)

    if (storedSessionId) {
      runtimeIdByStoredSessionIdRef.current.set(storedSessionId, sessionId)
    }

    return created
  }, [])

  const flushPendingViewState = useCallback(() => {
    const pending = pendingViewStateRef.current
    pendingViewStateRef.current = null

    if (!pending || pending.sessionId !== activeSessionIdRef.current) {
      return
    }

    // `preserveLocalAssistantErrors` always returns a fresh array, so publishing
    // it unconditionally puts a new `$messages` reference on the store every
    // flush — including the periodic `session.info` heartbeats that don't touch
    // the transcript. That churns ChatView → runtimeMessageRepository → the
    // assistant-ui runtime → the virtualizer, which re-measures and visibly
    // jerks the scroll position while the user is reading. Skip the publish when
    // the merged result is content-identical to what's already on screen.
    const currentMessages = $messages.get()
    // On a thread switch `$messages` still holds the *previous* thread, so
    // preserving its local errors would graft that thread's failed turn (e.g.
    // an out-of-funds error) onto this one — then cascade it everywhere as the
    // polluted view becomes the next switch's baseline. Only carry errors
    // across a same-session refresh; our cached state already keeps its own.
    const nextMessages =
      viewSessionIdRef.current === pending.sessionId
        ? preserveLocalAssistantErrors(pending.state.messages, currentMessages)
        : pending.state.messages

    if (!sameMessageList(nextMessages, currentMessages)) {
      setMessages(nextMessages)
    }

    viewSessionIdRef.current = pending.sessionId

    syncRuntimeMetadataToView(pending.state)
    setBusy(pending.state.busy)
    busyRef.current = pending.state.busy
    setAwaitingResponse(pending.state.awaitingResponse)
  }, [busyRef, setAwaitingResponse, setBusy, setMessages])

  const syncSessionStateToView = useCallback(
    (sessionId: string, state: ClientSessionState) => {
      pendingViewStateRef.current = { sessionId, state }

      if (viewSyncRafRef.current !== null) {
        return
      }

      if (typeof window === 'undefined') {
        flushPendingViewState()

        return
      }

      viewSyncRafRef.current = window.requestAnimationFrame(() => {
        viewSyncRafRef.current = null
        flushPendingViewState()
      })
    },
    [flushPendingViewState]
  )

  useEffect(
    () => () => {
      if (viewSyncRafRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(viewSyncRafRef.current)
        viewSyncRafRef.current = null
      }
    },
    []
  )

  const updateSessionState = useCallback(
    (
      sessionId: string,
      updater: (state: ClientSessionState) => ClientSessionState,
      storedSessionId?: string | null
    ) => {
      const previous = ensureSessionState(sessionId, storedSessionId)
      const next = updater({ ...previous, messages: previous.messages })
      sessionStateByRuntimeIdRef.current.set(sessionId, next)

      if (previous.storedSessionId !== next.storedSessionId || !next.busy) {
        setSessionWorking(previous.storedSessionId, false)
      }

      setSessionWorking(next.storedSessionId, next.busy)
      syncSessionStateToView(sessionId, next)

      return next
    },
    [ensureSessionState, syncSessionStateToView]
  )

  // When the store watchdog force-clears a stuck session (8 min of stream
  // silence — a hung or looping turn that never delivered its terminal event),
  // also drop that session's busy/awaiting flags here. Clearing the sidebar dot
  // alone leaves the composer wedged on "Thinking"/Stop; updateSessionState
  // re-syncs `$busy` when the healed session is the one on screen.
  useEffect(
    () =>
      onSessionWatchdogClear(storedSessionId => {
        const runtimeId = runtimeIdByStoredSessionIdRef.current.get(storedSessionId)
        const state = runtimeId ? sessionStateByRuntimeIdRef.current.get(runtimeId) : undefined

        if (!runtimeId || !state?.busy) {
          return
        }

        updateSessionState(runtimeId, current => ({
          ...current,
          awaitingResponse: false,
          busy: false,
          needsInput: false
        }))
      }),
    [updateSessionState]
  )

  return {
    activeSessionIdRef,
    ensureSessionState,
    runtimeIdByStoredSessionIdRef,
    selectedStoredSessionIdRef,
    sessionStateByRuntimeIdRef,
    syncSessionStateToView,
    updateSessionState
  }
}
