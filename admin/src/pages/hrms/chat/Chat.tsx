import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import '../../../styles/chat.css'
import { api, download } from '../../../lib/api'
import { useQuery } from '../../../lib/useQuery'
import { useAuth } from '../../../lib/auth'
import { useChatSocket, type ChatEvent } from '../../../lib/useChatSocket'
import { relativeTime, shortDate } from '../../../lib/format'
import { Avatar, EmptyState, ErrorNote, Loading } from '../../../components/ui'
import { AuthedImage } from '../../../components/AuthedImage'
import {
  IconCheck,
  IconClose,
  IconDownload,
  IconPaperclip,
  IconPlus,
  IconSearch,
  IconSheet,
  IconUsers,
} from '../../../components/Icons'

/**
 * Team chat.
 *
 * The organising idea is that **channels are not managed, they are derived**.
 * You do not create a team channel or invite anyone to it — your team has one
 * because your team exists, and you are in it because `users.team_id` says so.
 * Move desks and the rail changes that afternoon. The only channel anybody
 * opens by hand is a direct message, which is the one kind the org structure
 * has nothing to say about.
 *
 * Two consequences run through this file.
 *
 * **The socket is not the source of truth.** It delivers messages that HTTP has
 * already accepted, and a dropped socket costs live updates rather than the
 * ability to speak — posting is a POST, and it returns the message. On
 * reconnect the open thread is re-read, because a socket that was down cannot
 * know what it missed and nothing here pretends otherwise.
 *
 * **A message that arrives for a channel you are not looking at bumps a badge,
 * never the view.** Nothing steals the scroll position of a thread you are
 * reading because somebody posted somewhere else.
 */

/* ---------------------------------------------------------------- types --- */

interface Channel {
  id: string
  kind: 'team' | 'department' | 'direct' | 'group'
  title: string
  members: number
  unread: number
  last_message_at: string | null
  last_message_preview: string | null
  /** Groups only: whether this reader may rename it or change who is in it. */
  can_administer: boolean
}

interface Message {
  id: string
  channel_id: string
  user_id: string | null
  user_name: string | null
  body: string
  created_at: string
  edited_at: string | null
  is_deleted: boolean
  /* The file, described but never located. There is no URL here on purpose —
     the bytes come from `/chat/messages/{id}/attachment`, which re-checks
     membership on every request. */
  attachment_name: string | null
  attachment_type: string | null
  attachment_size: number | null
  attachment_inline: boolean
}

interface Member {
  id: string
  full_name: string
  is_admin: boolean
}

interface DirectoryEntry {
  user_id: string
  full_name: string
  email: string
  designation: string | null
  department: string | null
}

const GROUPS: Array<{ kind: Channel['kind']; heading: string }> = [
  { kind: 'team', heading: 'Teams' },
  { kind: 'department', heading: 'Departments' },
  /* Above direct messages: a group is a room somebody made deliberately, and
     it belongs with the other rooms rather than among one-to-one threads. */
  { kind: 'group', heading: 'Groups' },
  { kind: 'direct', heading: 'Direct messages' },
]

/** Mirrors `services.chat.MAX_ATTACHMENT_BYTES`. Checked here only to fail fast
 *  — the server refuses an oversize upload whatever this says. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** "2.4 MB". Sizes are shown so nobody clicks a 9 MB file on a phone by accident. */
function fileSize(bytes: number | null): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/* ============================================================== the page === */

export default function Chat() {
  const { user } = useAuth()
  const channelsQ = useQuery<Channel[]>('chat-channels', () =>
    api.get<Channel[]>('/chat/channels'),
  )
  const [openId, setOpenId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loadingThread, setLoadingThread] = useState(false)
  const [threadError, setThreadError] = useState<string | null>(null)
  const [unread, setUnread] = useState<Record<string, number>>({})
  const [picking, setPicking] = useState(false)
  const [makingGroup, setMakingGroup] = useState(false)
  const [showMembers, setShowMembers] = useState(false)

  const channels = channelsQ.data ?? []
  const open = channels.find((channel) => channel.id === openId) ?? null

  /* The first channel, once, and never again. Re-selecting on every refetch
     would drag somebody out of the thread they were reading the moment the
     channel list reordered under them — which it does on every message. */
  const picked = useRef(false)
  useEffect(() => {
    if (picked.current || channels.length === 0) return
    picked.current = true
    setOpenId(channels[0].id)
  }, [channels])

  // Server counts on load; this map takes over as messages arrive live.
  useEffect(() => {
    setUnread(Object.fromEntries(channels.map((c) => [c.id, c.unread])))
  }, [channelsQ.data])

  const loadThread = useCallback(
    async (channelId: string) => {
      setLoadingThread(true)
      setThreadError(null)
      try {
        setMessages(await api.get<Message[]>(`/chat/channels/${channelId}/messages`))
        setUnread((current) => ({ ...current, [channelId]: 0 }))
      } catch (err) {
        setThreadError(err instanceof Error ? err.message : 'That conversation could not be read.')
      } finally {
        setLoadingThread(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (openId) void loadThread(openId)
    else setMessages([])
  }, [openId, loadThread])

  /* Live delivery. A message for the open channel joins the thread; one for any
     other channel bumps its badge and its preview, and touches nothing on
     screen that the reader is in the middle of. */
  const onEvent = useCallback(
    (event: ChatEvent) => {
      if (event.type === 'message' || event.type === 'deleted') {
        const message = event.message as unknown as Message
        if (message.channel_id === openId) {
          setMessages((current) => {
            const without = current.filter((row) => row.id !== message.id)
            return event.type === 'deleted'
              ? without.concat(message).sort(byTime)
              : [...without, message].sort(byTime)
          })
          // Reading it as it arrives is reading it.
          void api.post(`/chat/channels/${message.channel_id}/read`).catch(() => {})
        } else if (event.type === 'message' && message.user_id !== user?.id) {
          setUnread((current) => ({
            ...current,
            [message.channel_id]: (current[message.channel_id] ?? 0) + 1,
          }))
        }
        // Reorders the rail by recency and refreshes previews.
        channelsQ.reload()
      }
    },
    [openId, user?.id, channelsQ],
  )

  const { connected } = useChatSocket(onEvent, () => {
    // The socket was down, so messages were missed and nothing here knows
    // which. Re-reading is the only thing that actually resynchronises.
    if (openId) void loadThread(openId)
    channelsQ.reload()
  })

  async function send(body: string) {
    if (!openId) return
    const posted = await api.post<Message>(`/chat/channels/${openId}/messages`, { body })
    /* Added from the response rather than waiting for the socket to echo it
       back. The sender must see their own message immediately even with the
       socket down — and the id makes the echo a no-op when it does arrive. */
    setMessages((current) =>
      current.some((row) => row.id === posted.id) ? current : [...current, posted],
    )
    channelsQ.reload()
  }

  async function remove(id: string) {
    const gone = await api.del<Message>(`/chat/messages/${id}`)
    setMessages((current) => current.map((row) => (row.id === id ? gone : row)))
  }

  /** Send one file, with whatever caption was typed beside it. */
  async function sendFile(file: File, caption: string) {
    if (!openId) return
    const form = new FormData()
    form.append('file', file)
    if (caption.trim()) form.append('body', caption.trim())
    const posted = await api.upload<Message>(`/chat/channels/${openId}/attachments`, form)
    setMessages((current) =>
      current.some((row) => row.id === posted.id) ? current : [...current, posted],
    )
    channelsQ.reload()
  }

  async function startGroup(name: string, userIds: string[]) {
    const channel = await api.post<Channel>('/chat/groups', { name, user_ids: userIds })
    setMakingGroup(false)
    await channelsQ.reload()
    setOpenId(channel.id)
  }

  async function startDirect(entry: DirectoryEntry) {
    setPicking(false)
    const channel = await api.post<Channel>('/chat/direct', { user_id: entry.user_id })
    await channelsQ.reload()
    setOpenId(channel.id)
  }

  if (channelsQ.error) return <ErrorNote>{channelsQ.error}</ErrorNote>
  if (channelsQ.loading) return <Loading label="Reading your conversations…" />

  return (
    <div className="page ch">
      <div className="page-head">
        <div>
          <h1 className="page-title">Chat</h1>
          <p className="page-sub">
            Your team and department have a channel because they exist — nobody has to create
            one or invite anybody. Move teams and the rail follows you.
          </p>
        </div>
        <span className={`ch-live${connected ? ' is-on' : ''}`} title={
          connected ? 'Live — new messages arrive as they are sent' : 'Reconnecting…'
        }>
          <span className="ch-live-dot" aria-hidden="true" />
          {connected ? 'Live' : 'Reconnecting'}
        </span>
      </div>

      <div className="ch-shell">
        <aside className="card ch-rail">
          <div className="ch-rail-head">
            <h2 className="card-title">Conversations</h2>
            <button
              className="ch-new"
              onClick={() => setMakingGroup(true)}
              title="Start a group"
              aria-label="Start a group"
            >
              <IconUsers size={15} />
            </button>
            <button className="ch-new" onClick={() => setPicking(true)} title="Message somebody"
              aria-label="Message somebody">
              <IconPlus size={15} />
            </button>
          </div>

          {channels.length === 0 ? (
            <p className="ch-rail-empty">
              You are not on a team or in a department yet, so there is no channel waiting for
              you. You can still message somebody directly, or start a group.
            </p>
          ) : (
            GROUPS.map((group) => {
              const rows = channels.filter((channel) => channel.kind === group.kind)
              if (rows.length === 0) return null
              return (
                <div className="ch-group" key={group.kind}>
                  <div className="ch-group-head">{group.heading}</div>
                  {rows.map((channel) => {
                    const count = unread[channel.id] ?? 0
                    return (
                      <button
                        key={channel.id}
                        className={`ch-item${channel.id === openId ? ' is-open' : ''}`}
                        onClick={() => setOpenId(channel.id)}
                      >
                        <span className="ch-item-body">
                          <span className="ch-item-title">{channel.title}</span>
                          <span className="ch-item-preview">
                            {channel.last_message_preview ?? 'No messages yet'}
                          </span>
                        </span>
                        {count > 0 && <span className="ch-badge">{count}</span>}
                      </button>
                    )
                  })}
                </div>
              )
            })
          )}
        </aside>

        <section className="card ch-thread">
          {!open ? (
            <EmptyState
              icon={<IconUsers size={20} />}
              title="Nothing open"
              body="Pick a conversation on the left."
            />
          ) : (
            <>
              <div className="ch-thread-head">
                <div>
                  <h2 className="ch-thread-title">{open.title}</h2>
                  <p className="ch-thread-meta">
                    {open.kind === 'direct'
                      ? 'Just the two of you'
                      : open.kind === 'group'
                        ? `${open.members} ${open.members === 1 ? 'person' : 'people'} · added by hand`
                        : `${open.members} ${open.members === 1 ? 'person' : 'people'} · everyone in this ${open.kind}`}
                  </p>
                </div>
                {open.kind !== 'direct' && (
                  <button className="btn btn-sm" onClick={() => setShowMembers(true)}>
                    <IconUsers size={14} /> {open.kind === 'group' ? 'Members' : 'Who is here'}
                  </button>
                )}
              </div>

              <Thread
                messages={messages}
                loading={loadingThread}
                error={threadError}
                meId={user?.id}
                onRemove={remove}
              />

              <Composer channelId={open.id} onSend={send} onSendFile={sendFile} />
            </>
          )}
        </section>
      </div>

      {picking && <PersonPicker onCancel={() => setPicking(false)} onPick={startDirect} />}
      {makingGroup && (
        <GroupDialog onCancel={() => setMakingGroup(false)} onCreate={startGroup} />
      )}
      {showMembers && open && (
        <MembersDialog
          channel={open}
          onClose={() => setShowMembers(false)}
          onChanged={() => {
            void channelsQ.reload()
          }}
          onLeft={() => {
            setShowMembers(false)
            setOpenId(null)
            void channelsQ.reload()
          }}
        />
      )}
    </div>
  )
}

function byTime(a: Message, b: Message): number {
  return a.created_at.localeCompare(b.created_at)
}

/* --------------------------------------------------------------- thread --- */

function Thread({
  messages,
  loading,
  error,
  meId,
  onRemove,
}: {
  messages: Message[]
  loading: boolean
  error: string | null
  meId: string | undefined
  onRemove: (id: string) => Promise<void>
}) {
  const endRef = useRef<HTMLDivElement>(null)

  /* Pinned to the bottom on every change. A chat that does not follow the
     newest message is a chat you have to scroll after every reply — and this is
     a thread people read from the end, not an archive they browse. */
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  if (loading) return <div className="ch-thread-body"><Loading label="Reading…" /></div>
  if (error) return <div className="ch-thread-body"><ErrorNote>{error}</ErrorNote></div>
  if (messages.length === 0) {
    return (
      <div className="ch-thread-body">
        <EmptyState title="No messages yet" body="Say something — everyone here will see it." />
      </div>
    )
  }

  return (
    <div className="ch-thread-body">
      {messages.map((message, index) => {
        const previous = messages[index - 1]
        /* Consecutive messages from one person inside a few minutes are drawn
           as one block with a single avatar. Repeating the name and face on
           every line turns a three-line thought into three announcements. */
        const grouped =
          previous !== undefined &&
          previous.user_id === message.user_id &&
          Date.parse(message.created_at) - Date.parse(previous.created_at) < 5 * 60_000 &&
          shortDate(message.created_at.slice(0, 10)) ===
            shortDate(previous.created_at.slice(0, 10))
        const mine = message.user_id === meId

        return (
          <div className={`ch-msg${grouped ? ' is-grouped' : ''}`} key={message.id}>
            {grouped ? (
              <span className="ch-msg-gutter" aria-hidden="true" />
            ) : (
              <Avatar name={message.user_name ?? '?'} small />
            )}
            <div className="ch-msg-body">
              {!grouped && (
                <div className="ch-msg-head">
                  <span className="ch-msg-who">
                    {message.user_name ?? 'A former colleague'}
                  </span>
                  <span className="ch-msg-when" title={message.created_at}>
                    {relativeTime(message.created_at)}
                  </span>
                </div>
              )}
              {message.is_deleted ? (
                /* The row stays. A thread that closed up around a removed
                   message would silently rewrite a conversation. */
                <p className="ch-msg-gone">Message removed</p>
              ) : (
                <>
                  {/* The caption is optional: a file sent on its own has an
                      empty body, and an empty paragraph would open a gap. */}
                  {message.body && <p className="ch-msg-text">{message.body}</p>}
                  {message.attachment_name && <Attachment message={message} />}
                </>
              )}
            </div>
            {mine && !message.is_deleted && (
              <button
                className="ch-msg-remove"
                onClick={() => void onRemove(message.id)}
                aria-label="Remove this message"
                title="Remove"
              >
                <IconClose size={13} />
              </button>
            )}
          </div>
        )
      })}
      <div ref={endRef} />
    </div>
  )
}

/* ----------------------------------------------------------- attachment --- */

/**
 * One attached file.
 *
 * Images are drawn in the thread; everything else is a row with a download.
 * Which of those it is, is decided by the **server** (`attachment_inline`) and
 * not by sniffing the type here — the list of formats safe to render lives next
 * to the allow-list that admits them, and two copies of that decision is one
 * too many.
 *
 * Both paths go through `AuthedImage` / `download`, which send the bearer
 * token. A plain `<img src>` would arrive unauthenticated and 401, and the
 * endpoint deliberately has no public URL to give it.
 */
function Attachment({ message }: { message: Message }) {
  const path = `/chat/messages/${message.id}/attachment`
  const [failed, setFailed] = useState<string | null>(null)

  if (message.attachment_inline) {
    return (
      <figure className="ch-shot">
        <AuthedImage
          path={`/api/v1${path}`}
          alt={message.attachment_name ?? 'Attached image'}
          className="ch-shot-img"
        />
        <figcaption className="ch-file-meta">
          {message.attachment_name} · {fileSize(message.attachment_size)}
          <button
            className="link-btn"
            onClick={() =>
              void download(path, message.attachment_name ?? 'file').catch((err) =>
                setFailed(err instanceof Error ? err.message : 'Could not download that file.'),
              )
            }
          >
            Download
          </button>
        </figcaption>
        {failed && <ErrorNote>{failed}</ErrorNote>}
      </figure>
    )
  }

  return (
    <div className="ch-file">
      <span className="ch-file-icon" aria-hidden="true">
        <IconSheet size={16} />
      </span>
      <span className="ch-file-body">
        <span className="ch-file-name">{message.attachment_name}</span>
        <span className="ch-file-meta">{fileSize(message.attachment_size)}</span>
      </span>
      <button
        className="btn btn-sm"
        onClick={() =>
          void download(path, message.attachment_name ?? 'file').catch((err) =>
            setFailed(err instanceof Error ? err.message : 'Could not download that file.'),
          )
        }
      >
        <IconDownload size={14} /> Download
      </button>
      {failed && <ErrorNote>{failed}</ErrorNote>}
    </div>
  )
}

/* ------------------------------------------------------------- composer --- */

function Composer({
  channelId,
  onSend,
  onSendFile,
}: {
  channelId: string
  onSend: (body: string) => Promise<void>
  onSendFile: (file: File, caption: string) => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  /* Chosen but not yet sent. Held here rather than uploaded on selection, so
     the caption goes up with the file in one request and one message — and so
     picking the wrong file costs nothing to undo. */
  const [pending, setPending] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // A draft belongs to the channel it was typed in, not to the composer.
  useEffect(() => {
    setDraft('')
    setPending(null)
    setFailure(null)
  }, [channelId])

  function choose(file: File | null) {
    setFailure(null)
    if (!file) return
    if (file.size > MAX_ATTACHMENT_BYTES) {
      // Refused here as well as on the server: a 10 MB upload that fails after
      // it has finished uploading is a minute of somebody's life for nothing.
      setFailure(`Attachments are limited to ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`)
      return
    }
    setPending(file)
  }

  async function submit() {
    const body = draft.trim()
    if ((!body && !pending) || busy) return
    setBusy(true)
    setFailure(null)
    try {
      if (pending) await onSendFile(pending, body)
      else await onSend(body)
      setDraft('')
      setPending(null)
      if (fileRef.current) fileRef.current.value = ''
    } catch (err) {
      // The draft and the chosen file are both kept. Losing what somebody typed
      // because the network blinked is the worst thing a composer can do.
      setFailure(err instanceof Error ? err.message : 'That could not be sent.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ch-composer">
      {failure && <ErrorNote>{failure}</ErrorNote>}

      {pending && (
        <div className="ch-pending">
          <IconSheet size={15} />
          <span className="ch-file-name">{pending.name}</span>
          <span className="ch-file-meta">{fileSize(pending.size)}</span>
          <button
            className="link-btn"
            onClick={() => {
              setPending(null)
              if (fileRef.current) fileRef.current.value = ''
            }}
          >
            Remove
          </button>
        </div>
      )}

      <div className="ch-composer-row">
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(event) => choose(event.target.files?.[0] ?? null)}
        />
        <button
          className="ch-attach"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          title="Attach a file"
          aria-label="Attach a file"
        >
          <IconPaperclip size={16} />
        </button>
        <textarea
          className="ch-input"
          rows={1}
          value={draft}
          placeholder={pending ? 'Add a caption (optional)…' : 'Write a message…'}
          maxLength={4000}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            /* Enter sends, Shift+Enter breaks the line — the convention every
               chat client shares, and the one people type without thinking. */
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <button
          className="btn btn-primary"
          disabled={busy || (draft.trim().length === 0 && !pending)}
          onClick={() => void submit()}
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- picker --- */

function PersonPicker({
  onCancel,
  onPick,
}: {
  onCancel: () => void
  onPick: (entry: DirectoryEntry) => Promise<void>
}) {
  const { user } = useAuth()
  const q = useQuery<DirectoryEntry[]>('chat-directory', () =>
    api.get<DirectoryEntry[]>('/people/directory'),
  )
  const [query, setQuery] = useState('')

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const needle = query.trim().toLowerCase()
  const rows = useMemo(
    () =>
      (q.data ?? [])
        // Yourself is not somebody you can message, and the server refuses it.
        .filter((entry) => entry.user_id !== user?.id)
        .filter(
          (entry) =>
            !needle ||
            entry.full_name.toLowerCase().includes(needle) ||
            (entry.designation ?? '').toLowerCase().includes(needle) ||
            (entry.department ?? '').toLowerCase().includes(needle),
        ),
    [q.data, needle, user?.id],
  )

  return (
    <div className="hx-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="hx-dialog" role="dialog" aria-modal="true" aria-label="Message somebody">
        <div className="hx-dialog-head">
          <h2 className="hx-dialog-title">Message somebody</h2>
        </div>
        <label className="ch-picker-search">
          <IconSearch size={15} />
          <input
            type="search"
            value={query}
            placeholder="Search the directory…"
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search the directory"
          />
        </label>
        <div className="hx-list">
          {q.loading && <Loading />}
          {q.error && <ErrorNote>{q.error}</ErrorNote>}
          {!q.loading && rows.length === 0 && <p className="ch-rail-empty">Nobody matches that.</p>}
          {rows.map((entry) => (
            <button className="hx-option" key={entry.user_id} onClick={() => void onPick(entry)}>
              <span className="hx-option-name">
                <Avatar name={entry.full_name} small /> {entry.full_name}
              </span>
              <span className="hx-option-meta">
                {[entry.designation, entry.department].filter(Boolean).join(' · ') || entry.email}
              </span>
            </button>
          ))}
        </div>
        <div className="hx-dialog-foot">
          <button className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- groups --- */

/**
 * Start a group: a name, and the colleagues who should be in it.
 *
 * Multi-select rather than the one-at-a-time picker direct messages use,
 * because a group is defined by *who is in it* — adding six people through six
 * round trips would make the common case the slow one.
 */
function GroupDialog({
  onCancel,
  onCreate,
}: {
  onCancel: () => void
  onCreate: (name: string, userIds: string[]) => Promise<void>
}) {
  const { user } = useAuth()
  const q = useQuery<DirectoryEntry[]>('chat-directory', () =>
    api.get<DirectoryEntry[]>('/people/directory'),
  )
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const needle = query.trim().toLowerCase()
  const rows = useMemo(
    () =>
      (q.data ?? [])
        // You are in your own group by definition; the server adds you.
        .filter((entry) => entry.user_id !== user?.id)
        .filter(
          (entry) =>
            !needle ||
            entry.full_name.toLowerCase().includes(needle) ||
            (entry.designation ?? '').toLowerCase().includes(needle) ||
            (entry.department ?? '').toLowerCase().includes(needle),
        ),
    [q.data, needle, user?.id],
  )

  function toggle(id: string) {
    setChosen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function submit() {
    if (!name.trim() || chosen.size === 0 || busy) return
    setBusy(true)
    setFailure(null)
    try {
      await onCreate(name.trim(), [...chosen])
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'That group could not be created.')
      setBusy(false)
    }
  }

  return (
    <div className="hx-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="hx-dialog" role="dialog" aria-modal="true" aria-label="Start a group">
        <div className="hx-dialog-head">
          <h2 className="hx-dialog-title">Start a group</h2>
          <p className="ch-dialog-sub">
            A conversation for people who are not already a team or a department — a project,
            a launch, a committee.
          </p>
        </div>

        <label className="ch-picker-search">
          <input
            value={name}
            placeholder="Group name — what is this about?"
            maxLength={120}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            aria-label="Group name"
          />
        </label>

        <label className="ch-picker-search">
          <IconSearch size={15} />
          <input
            type="search"
            value={query}
            placeholder="Search the directory…"
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search the directory"
          />
        </label>

        <div className="hx-list">
          {q.loading && <Loading />}
          {q.error && <ErrorNote>{q.error}</ErrorNote>}
          {!q.loading && rows.length === 0 && <p className="ch-rail-empty">Nobody matches that.</p>}
          {rows.map((entry) => (
            <button
              className={`hx-option${chosen.has(entry.user_id) ? ' is-chosen' : ''}`}
              key={entry.user_id}
              onClick={() => toggle(entry.user_id)}
              aria-pressed={chosen.has(entry.user_id)}
            >
              <span className="hx-option-name">
                <Avatar name={entry.full_name} small /> {entry.full_name}
              </span>
              <span className="hx-option-meta">
                {chosen.has(entry.user_id) ? (
                  <IconCheck size={15} />
                ) : (
                  [entry.designation, entry.department].filter(Boolean).join(' · ') || entry.email
                )}
              </span>
            </button>
          ))}
        </div>

        <div className="hx-dialog-foot">
          {failure && <ErrorNote>{failure}</ErrorNote>}
          <span className="ch-file-meta">
            {chosen.size === 0
              ? 'Pick at least one colleague'
              : `${chosen.size} chosen · you are added automatically`}
          </span>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !name.trim() || chosen.size === 0}
            onClick={() => void submit()}
          >
            {busy ? 'Creating…' : 'Create group'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Who is in a channel, and — for a group — the controls to change it.
 *
 * Readable for a team or department channel too, where it is purely
 * informational: "who can see this" is a fair question about any room, and the
 * answer for those is the org chart rather than a list anybody can edit.
 */
function MembersDialog({
  channel,
  onClose,
  onChanged,
  onLeft,
}: {
  channel: Channel
  onClose: () => void
  onChanged: () => void
  onLeft: () => void
}) {
  const { user } = useAuth()
  const membersQ = useQuery<Member[]>(`chat-members-${channel.id}`, () =>
    api.get<Member[]>(`/chat/channels/${channel.id}/members`),
  )
  const directoryQ = useQuery<DirectoryEntry[]>('chat-directory', () =>
    api.get<DirectoryEntry[]>('/people/directory'),
  )
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const members = membersQ.data ?? []
  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members])
  const isGroup = channel.kind === 'group'

  const needle = query.trim().toLowerCase()
  const candidates = useMemo(
    () =>
      (directoryQ.data ?? [])
        .filter((entry) => !memberIds.has(entry.user_id))
        .filter((entry) => !needle || entry.full_name.toLowerCase().includes(needle)),
    [directoryQ.data, memberIds, needle],
  )

  async function act(run: () => Promise<unknown>) {
    setBusy(true)
    setFailure(null)
    try {
      await run()
      await membersQ.reload()
      onChanged()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'That could not be done.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hx-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="hx-dialog" role="dialog" aria-modal="true" aria-label={`${channel.title} members`}>
        <div className="hx-dialog-head">
          <h2 className="hx-dialog-title">{channel.title}</h2>
          <p className="ch-dialog-sub">
            {isGroup
              ? 'Anyone added can read everything already said here — a group is a room, not a thread that starts when you arrive.'
              : `Everyone in this ${channel.kind} is here. Membership follows the org chart, so it changes when somebody moves.`}
          </p>
        </div>

        {adding ? (
          <>
            <label className="ch-picker-search">
              <IconSearch size={15} />
              <input
                type="search"
                value={query}
                placeholder="Search the directory…"
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search the directory"
              />
            </label>
            <div className="hx-list">
              {directoryQ.loading && <Loading />}
              {candidates.length === 0 && !directoryQ.loading && (
                <p className="ch-rail-empty">Everybody who matches is already here.</p>
              )}
              {candidates.map((entry) => (
                <button
                  className="hx-option"
                  key={entry.user_id}
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      api.post(`/chat/channels/${channel.id}/members`, {
                        user_ids: [entry.user_id],
                      }),
                    )
                  }
                >
                  <span className="hx-option-name">
                    <Avatar name={entry.full_name} small /> {entry.full_name}
                  </span>
                  <span className="hx-option-meta">Add</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="hx-list">
            {membersQ.loading && <Loading />}
            {membersQ.error && <ErrorNote>{membersQ.error}</ErrorNote>}
            {members.map((member) => (
              <div className="hx-option is-static" key={member.id}>
                <span className="hx-option-name">
                  <Avatar name={member.full_name} small /> {member.full_name}
                  {member.is_admin && <span className="ch-tag">created it</span>}
                  {member.id === user?.id && <span className="ch-tag">you</span>}
                </span>
                {isGroup && channel.can_administer && member.id !== user?.id && (
                  <button
                    className="link-btn"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        api.del(`/chat/channels/${channel.id}/members/${member.id}`),
                      )
                    }
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="hx-dialog-foot">
          {failure && <ErrorNote>{failure}</ErrorNote>}
          {isGroup && channel.can_administer && (
            <button className="btn" onClick={() => setAdding((open) => !open)}>
              {adding ? 'Back to members' : 'Add people'}
            </button>
          )}
          {isGroup && (
            /* Leaving is everybody's, including the person who created it —
               who then hands the group to whoever is left. */
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api.del(`/chat/channels/${channel.id}/members/${user?.id}`)
                  onLeft()
                })
              }
            >
              Leave group
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
