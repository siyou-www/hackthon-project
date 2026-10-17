import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { pushApi } from './pushApi.js'

const EMPTY = []

export function useReminders(capability, onRecords) {
  const current = useRef(capability)
  const receive = useRef(onRecords)
  const sequence = useRef(0)
  const writing = useRef(false)
  const invalidate = useCallback(() => { ++sequence.current }, [])
  useLayoutEffect(() => {
    current.current = capability
    receive.current = onRecords
    return () => { current.current = null; invalidate() }
  }, [capability, onRecords, invalidate])
  const [snapshot, setSnapshot] = useState({ owner: null, records: [], state: 'idle', error: '' })
  const owner = capability?.id
  const token = capability?.token
  const refresh = useCallback(async () => {
    if (!owner || writing.current) return
    const request = ++sequence.current
    setSnapshot((old) => ({ owner, records: old.owner === owner ? old.records : [], state: 'loading', error: '' }))
    try {
      const data = await pushApi(`/subscriptions/${owner}/reminders`, { headers: { Authorization: `Bearer ${token}` } })
      if (!Array.isArray(data.reminders)) throw new Error('Invalid reminder response. Refresh before editing saved reminders.')
      if (request === sequence.current && current.current?.id === owner && current.current?.token === token) {
        setSnapshot({ owner, records: data.reminders, state: 'ready', error: '' })
        receive.current?.(data.reminders, owner, true)
      }
    } catch (error) {
      if (request === sequence.current) setSnapshot((old) => ({ ...old, state: 'error', error: error.message }))
    }
  }, [owner, token])
  useEffect(() => {
    let active = true
    queueMicrotask(() => { if (active) refresh() })
    window.addEventListener('focus', refresh)
    return () => { active = false; invalidate(); window.removeEventListener('focus', refresh) }
  }, [refresh, invalidate])

  async function mutate(activityId, method, body) {
    if (!capability) throw new Error('Enable Notifications to access saved reminders.')
    if (writing.current) throw new Error('Please wait for the current reminder request.')
    writing.current = true
    ++sequence.current // Invalidate a stale GET before this write.
    try {
      const row = await pushApi(`/subscriptions/${owner}/reminders/${activityId}`, {
        method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      if (current.current?.id !== owner || current.current?.token !== token) throw new Error('Notification subscription changed. Refresh reminders before trying again.')
      setSnapshot((old) => ({ owner, state: 'ready', error: '', records: [...(old.owner === owner ? old.records.filter((r) => r.activity_id !== activityId) : []), row] }))
      receive.current?.([row], owner, false)
      return row
    } finally {
      writing.current = false
    }
  }
  const matches = owner && snapshot.owner === owner
  return {
    records: matches ? snapshot.records : EMPTY,
    ready: Boolean(matches && snapshot.state === 'ready'),
    loading: Boolean(owner && (!matches || snapshot.state === 'loading')),
    error: matches ? snapshot.error : '',
    refresh,
    save: (id, body) => mutate(id, 'PUT', body),
    cancel: (id) => mutate(id, 'DELETE'),
  }
}
