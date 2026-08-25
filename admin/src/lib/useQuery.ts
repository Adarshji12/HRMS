import { useCallback, useEffect, useRef, useState } from 'react'

interface QueryState<T> {
  data: T | undefined
  error: string | null
  /**
   * The thrown error itself, so a caller can branch on
   * `ApiError.reason` / `.detail`.
   *
   * `error` stays a string because almost every caller only renders it.
   * But reducing to `.message` here threw away the typed refusal codes the
   * server sends specifically so a page can tell `page_hidden` from a real
   * outage — and a page that cannot tell them apart shows an employee an
   * error for a page they were simply never given.
   */
  cause: unknown
  loading: boolean
  refetching: boolean
  reload: () => void
}

/**
 * Minimal data hook.
 *
 * `refetching` is separate from `loading` on purpose: on a refetch the caller
 * keeps rendering the previous data at reduced opacity instead of swapping in a
 * skeleton, which avoids the layout jump every polling dashboard otherwise gets.
 */
export function useQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: { pollMs?: number; enabled?: boolean } = {},
): QueryState<T> {
  const { pollMs, enabled = true } = options
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [cause, setCause] = useState<unknown>(null)
  const [loading, setLoading] = useState(enabled)
  const [refetching, setRefetching] = useState(false)

  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const hasData = useRef(false)

  const run = useCallback(async () => {
    if (hasData.current) setRefetching(true)
    else setLoading(true)
    try {
      const result = await fetcherRef.current()
      setData(result)
      setError(null)
      setCause(null)
      hasData.current = true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setCause(err)
    } finally {
      setLoading(false)
      setRefetching(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    hasData.current = false
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled])

  useEffect(() => {
    if (!enabled || !pollMs) return
    const id = window.setInterval(() => void run(), pollMs)
    return () => window.clearInterval(id)
  }, [enabled, pollMs, run])

  return { data, error, cause, loading, refetching, reload: run }
}
