import { useEffect, useRef, useState } from 'react'
import { api } from './api'

/**
 * The live half of chat.
 *
 * Three things about it are deliberate and easy to undo by accident.
 *
 * **It only receives.** Nothing is ever sent up this socket — posting is an
 * ordinary HTTP call that runs the real auth and validation path. So a socket
 * that is down costs live updates and nothing else: you can still speak, and
 * you still see your own message, because the POST returns it.
 *
 * **It opens with a ticket, not with your session token.** A browser cannot set
 * an Authorization header on a WebSocket handshake, so the credential has to go
 * in the URL — and a URL ends up in proxy logs and browser history. The console
 * exchanges its bearer token for a one-minute, socket-only ticket over HTTPS
 * first, and puts that in the URL instead.
 *
 * **Reconnection backs off, and the caller re-reads on reconnect.** A dropped
 * socket means messages were missed, and no amount of buffering here can know
 * which. `onReconnect` is the caller's cue to refetch the thread it is showing —
 * which is the only thing that can actually resynchronise it.
 */

export type ChatEvent =
  | { type: 'ready' }
  | { type: 'message'; message: Record<string, unknown> }
  | { type: 'deleted'; message: Record<string, unknown> }

interface Ticket {
  ticket: string
  expires_in: number
}

/** 1s, 2s, 4s… capped. Uncapped doubling means a laptop that slept overnight
 *  waits hours before trying again. */
const MAX_BACKOFF_MS = 30_000

export function useChatSocket(
  onEvent: (event: ChatEvent) => void,
  onReconnect?: () => void,
): { connected: boolean } {
  const [connected, setConnected] = useState(false)
  /* Held in a ref, not in state, and re-read on every message: the callback is
     rebuilt on every render of a component whose state changes on every message,
     and keying the effect on it would tear the socket down and reopen it each
     time one arrived. */
  const handler = useRef(onEvent)
  handler.current = onEvent
  const reconnected = useRef(onReconnect)
  reconnected.current = onReconnect

  useEffect(() => {
    let socket: WebSocket | null = null
    let timer: number | undefined
    let attempt = 0
    let closed = false
    // True once a socket has been up, so the first connect does not fire the
    // "you missed messages" refetch on a thread that was just loaded.
    let hadSession = false

    async function connect() {
      if (closed) return
      try {
        const { ticket } = await api.post<Ticket>('/chat/ticket')
        if (closed) return

        const base = import.meta.env.VITE_API_BASE ?? ''
        const origin = base
          ? base.replace(/^http/, 'ws')
          : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
        socket = new WebSocket(
          `${origin}/api/v1/chat/ws?ticket=${encodeURIComponent(ticket)}`,
        )

        socket.onopen = () => {
          attempt = 0
          setConnected(true)
          if (hadSession) reconnected.current?.()
          hadSession = true
        }
        socket.onmessage = (event) => {
          try {
            handler.current(JSON.parse(event.data) as ChatEvent)
          } catch {
            /* A frame we cannot parse is a frame from a newer server. Ignoring
               it is right: the thread is re-read on reconnect anyway. */
          }
        }
        socket.onclose = () => {
          setConnected(false)
          retry()
        }
        socket.onerror = () => socket?.close()
      } catch {
        // The ticket call failed — offline, or the session has expired. Either
        // way the answer is the same: wait and try again.
        setConnected(false)
        retry()
      }
    }

    function retry() {
      if (closed) return
      const wait = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt)
      attempt += 1
      timer = window.setTimeout(() => void connect(), wait)
    }

    void connect()
    return () => {
      closed = true
      if (timer) window.clearTimeout(timer)
      // onclose is cleared first: closing deliberately must not schedule a
      // reconnect for a component that is going away.
      if (socket) {
        socket.onclose = null
        socket.close()
      }
    }
  }, [])

  return { connected }
}
