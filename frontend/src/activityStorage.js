export const ACTIVITIES_KEY = 'daycast.activities.v1'
export const DRAFT_KEY = 'daycast.activity-draft.v1'
export const LOCATION = { latitude: 34.0522, longitude: -118.2437 }
export const LIVE_STATES = ['pending', 'retry', 'processing']
export function readLocal(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback
  } catch { return fallback }
}
export function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) }
  catch { throw new Error('Device storage is unavailable. Allow site storage before saving activities or reminder drafts.') }
}
export function reminderTime(row) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: row.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(row.starts_at))
  const get = (type) => parts.find((part) => part.type === type).value
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}
export function mergeReminders(activities, rows, owner, complete = true) {
  const next = { ...activities }
  const ids = new Set(rows.map((row) => row.activity_id))
  for (const [time, activity] of Object.entries(next)) {
    if (complete && activity.subscriptionId === owner && !ids.has(activity.id)) next[time] = { ...activity, reminderStatus: 'removed' }
  }
  // Newest server snapshot wins for a slot; all history remains in the reminder list.
  for (const row of [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    if (row.latitude !== LOCATION.latitude || row.longitude !== LOCATION.longitude
      || row.timezone !== 'America/Los_Angeles') continue
    const time = reminderTime(row)
    const existing = next[time]
    if (!existing || existing.id === row.activity_id || LIVE_STATES.includes(row.status)) {
      next[time] = { id: row.activity_id, name: row.title, isOutdoor: row.outdoor, time,
        timezone: row.timezone, preference: row.preference, subscriptionId: owner, reminderStatus: row.status }
    }
  }
  return next
}
export function statusLabel(status) {
  return ({ pending: 'Pending', retry: 'Retry scheduled', processing: 'Processing', cancelled: 'Cancelled',
    sent: 'Sent (accepted by push service)', failed: 'Delivery failed', missed: 'Missed',
    uncertain: 'Delivery uncertain — no automatic retry', removed: 'Removed with notification subscription' })[status] || status
}
