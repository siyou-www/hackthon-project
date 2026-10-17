import { StrictMode } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App.jsx'
import Notifications from './Notifications.jsx'
import { ACTIVITIES_KEY, DRAFT_KEY } from './activityStorage.js'
import { CAPABILITY_STORAGE_KEY } from './pushApi.js'

const CAP = { id: '11111111-1111-4111-8111-111111111111', token: 'test-only-secret-capability' }
const ID = '22222222-2222-4222-8222-222222222222'
let records, requests, permission, putFailure, deleteFailure, getFailure, subscription
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(data) })
function row(overrides = {}) {
  return { id: crypto.randomUUID(), subscription_id: CAP.id, activity_id: ID,
    title: 'Server basketball', outdoor: true, latitude: 34.0522, longitude: -118.2437,
    timezone: 'America/Los_Angeles', preference: 'heat_sensitive', starts_at: '2030-01-02T22:00:00Z',
    due_at: '2030-01-02T21:30:00Z', status: 'pending', created_at: '2030-01-01T20:00:00Z', ...overrides }
}
function mount() { return render(<StrictMode><Notifications><App /></Notifications></StrictMode>) }
async function ready() {
  await screen.findByRole('button', { name: /2:00 PM/ })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh reminder status' }).disabled).toBe(false))
}
async function open(user) {
  await user.click(screen.getByRole('button', { name: /2:00 PM/ }))
  await screen.findByPlaceholderText('Activity name (e.g. Basketball)')
}
const input = () => screen.getByPlaceholderText('Activity name (e.g. Basketball)')
const checkbox = () => screen.getByRole('checkbox', { name: 'Remind me 30 minutes before' })
const save = (user) => user.click(screen.getByRole('button', { name: 'Save Activity', exact: true }))
const puts = () => requests.filter((r) => r.method === 'PUT')
async function saveNew(user, remind = true) {
  await open(user); await user.type(input(), 'Basketball')
  expect(checkbox().checked).toBe(false)
  if (remind) await user.click(checkbox())
  await save(user)
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2030-01-02T20:00:00Z'))
  localStorage.clear(); localStorage.setItem(CAPABILITY_STORAGE_KEY, JSON.stringify(CAP))
  records = new Map(); requests = []; permission = 'granted'
  putFailure = null; deleteFailure = false; getFailure = false
  const makeSubscription = () => ({ toJSON: () => ({ endpoint: 'https://web.push.apple.com/test', keys: { auth: 'test', p256dh: 'test' } }),
    unsubscribe: vi.fn(async () => { subscription = null; return true }) })
  subscription = makeSubscription()
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} })
  Object.defineProperty(window, 'Notification', { configurable: true, value: {
    get permission() { return permission }, requestPermission: vi.fn(async () => { permission = 'granted'; return permission }),
  } })
  window.matchMedia = vi.fn(() => ({ matches: false }))
  const registration = { pushManager: { getSubscription: vi.fn(async () => subscription),
    subscribe: vi.fn(async () => { subscription = makeSubscription(); return subscription }) } }
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
    ready: Promise.resolve(registration), getRegistration: vi.fn(async () => registration),
  } })
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const method = options.method || 'GET'; const body = options.body ? JSON.parse(options.body) : null
    requests.push({ url, method, body, headers: options.headers || {} })
    if (url.includes('/api/weather')) return reply({ timezone: 'America/Los_Angeles', hourly: [
      { time: '2030-01-02T14:00', temperature_c: 32, temperature_f: 89.6, precipitation_probability: 70 },
      { time: '2030-01-02T15:00', temperature_c: 20, temperature_f: 68, precipitation_probability: 10 },
    ] })
    if (url.endsWith('/api/daily-plan')) return reply({ activities: body.activities.map((activity) => ({ activity,
      weather: { temperature_c: 32, temperature_f: 89.6, precipitation_probability: 70 }, advice: ['Stay hydrated.'], comfort: 'hot', comfort_advice: 'Seek shade outdoors.' })) })
    if (url.endsWith('/public-key')) return reply({ public_key: 'B' + 'A'.repeat(86) })
    if (url.endsWith('/subscriptions') && method === 'POST') return reply({ id: '44444444-4444-4444-8444-444444444444', token: 'second-test-capability' })
    if (url.endsWith('/test')) return reply({ status: 'accepted' })
    if (/\/subscriptions\/[^/]+$/.test(url) && method === 'DELETE') { records.clear(); return reply({ status: 'unregistered' }) }
    const expected = JSON.parse(localStorage.getItem(CAPABILITY_STORAGE_KEY))
    expect(options.headers.Authorization).toBe(`Bearer ${expected.token}`)
    if (url.endsWith('/reminders')) return getFailure ? reply({ detail: 'Notification database is unavailable.' }, 503) : reply({ reminders: [...records.values()] })
    const id = url.split('/').at(-1)
    if (method === 'PUT') {
      if (putFailure === 'validation') return reply({ detail: [{ msg: 'Activity must start at least 30 minutes in the future.' }] }, 422)
      if (putFailure === 'conflict' || (records.has(id) && records.get(id).status !== 'pending')) return reply({ detail: 'Only pending reminders can be updated.' }, 409)
      const value = row({ ...records.get(id), activity_id: id, id: records.get(id)?.id || crypto.randomUUID(),
        title: body.title, outdoor: body.outdoor, preference: body.preference,
        starts_at: new Date(`${body.time}:00-08:00`).toISOString(), created_at: records.get(id)?.created_at || new Date().toISOString() })
      records.set(id, value)
      if (putFailure === 'lost-response') { putFailure = null; throw new TypeError('Network response lost.') }
      return reply(value)
    }
    if (method === 'DELETE') {
      if (deleteFailure) return reply({ detail: 'Cancellation unavailable.' }, 503)
      const value = { ...records.get(id), status: 'cancelled' }; records.set(id, value); return reply(value)
    }
    throw new Error('Unexpected test API route')
  }))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('starts unchecked; saves ordinary activities without PUT or permission prompts', async () => {
  const user = userEvent.setup(); mount(); await ready(); await saveNew(user, false)
  await screen.findByText('Activity saved without a reminder.')
  expect(puts()).toHaveLength(0); expect(Notification.requestPermission).not.toHaveBeenCalled()
  expect(Object.values(JSON.parse(localStorage.getItem(ACTIVITIES_KEY)))[0].id).toMatch(/^[0-9a-f-]{36}$/)
})
it('saves with bearer headers, forecast timezone, and a stable editing UUID', async () => {
  const user = userEvent.setup(); mount(); await ready(); await saveNew(user)
  await screen.findByText('Activity and reminder saved.')
  expect(puts()[0].body).toEqual({ time: '2030-01-02T14:00', timezone: 'America/Los_Angeles', title: 'Basketball', outdoor: false,
    preference: 'normal', latitude: 34.0522, longitude: -118.2437 })
  await open(user); expect(checkbox().checked).toBe(true)
  await user.clear(input()); await user.type(input(), 'Evening walk'); await save(user)
  await screen.findByText('Activity and reminder saved.')
  expect(puts()[1].url).toBe(puts()[0].url); expect(records.size).toBe(1)
  expect(screen.getByRole('heading', { name: 'Evening walk' })).toBeTruthy()
  expect(requests.every((r) => !r.url.includes(CAP.token))).toBe(true)
  expect(localStorage.getItem(ACTIVITIES_KEY)).not.toContain(CAP.token)
  expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
})
it('retains draft UUID after a lost response and refresh; restores server data', async () => {
  const user = userEvent.setup(); putFailure = 'lost-response'
  const app = mount(); await ready(); await saveNew(user)
  await screen.findByText('Network response lost.')
  const id = puts()[0].url.split('/').at(-1)
  expect(JSON.parse(localStorage.getItem(DRAFT_KEY)).id).toBe(id)
  app.unmount(); mount(); await ready(); await screen.findByRole('heading', { name: 'Basketball', exact: true })
  await open(user); expect(input().value).toBe('Basketball'); await save(user)
  await screen.findByText('Activity and reminder saved.')
  expect(puts()[1].url).toBe(puts()[0].url); expect(records.size).toBe(1)
})
it('reconciles stale cached activities and restores the location-local activity hour', async () => {
  records.set(ID, row())
  localStorage.setItem(ACTIVITIES_KEY, JSON.stringify({ '2030-01-02T14:00': { id: ID, name: 'Stale title',
    time: '2030-01-02T14:00', timezone: 'America/Los_Angeles', subscriptionId: CAP.id, reminderStatus: 'pending' } }))
  const user = userEvent.setup(); mount(); await ready(); await open(user)
  expect(input().value).toBe('Server basketball')
  expect(screen.getByLabelText('Reminder temperature preference').value).toBe('heat_sensitive')
  expect(screen.getByText('2030-01-02T14:00 (America/Los_Angeles)')).toBeTruthy(); expect(puts()).toHaveLength(0)
})
it('cancels with DELETE and retains cancelled history on reopening', async () => {
  records.set(ID, row()); const user = userEvent.setup(); const app = mount(); await ready()
  await user.click(screen.getByRole('button', { name: 'Cancel reminder for Server basketball' }))
  await screen.findByText('Reminder: Cancelled'); expect(records.get(ID).status).toBe('cancelled')
  app.unmount(); mount(); await ready(); await screen.findByText('Reminder: Cancelled'); expect(puts()).toHaveLength(0)
})
it('does not change saved activity or report success when cancellation fails', async () => {
  records.set(ID, row()); const user = userEvent.setup(); mount(); await ready(); await open(user)
  await user.clear(input()); await user.type(input(), 'Unsaved change'); await user.click(checkbox())
  deleteFailure = true; await save(user); await screen.findByText('Cancellation unavailable.')
  expect(records.get(ID).status).toBe('pending')
  expect(JSON.parse(localStorage.getItem(ACTIVITIES_KEY))['2030-01-02T14:00'].name).toBe('Server basketball')
  expect(screen.queryByText('Activity saved without a reminder.')).toBeNull()
})
it('shows validation errors and retains the same UUID for retry', async () => {
  putFailure = 'validation'; const user = userEvent.setup(); mount(); await ready(); await saveNew(user)
  await screen.findByText('Activity must start at least 30 minutes in the future.')
  const id = JSON.parse(localStorage.getItem(DRAFT_KEY)).id
  expect(Object.keys(JSON.parse(localStorage.getItem(ACTIVITIES_KEY)))).toHaveLength(0)
  putFailure = null; await save(user); await screen.findByText('Activity and reminder saved.')
  expect(puts()[1].url.split('/').at(-1)).toBe(id)
})
it('surfaces worker-state conflicts and preserves the server snapshot', async () => {
  records.set(ID, row()); const user = userEvent.setup(); mount(); await ready(); await open(user)
  records.set(ID, row({ status: 'sent' })); putFailure = 'conflict'
  await user.type(input(), ' unsaved'); await save(user)
  await screen.findByText('Only pending reminders can be updated.')
  await screen.findByText('Reminder: Sent (accepted by push service)')
  expect(records.get(ID).title).toBe('Server basketball'); expect(records.size).toBe(1)
})
it('creates a new UUID only after explicit opt-in following cancellation', async () => {
  records.set(ID, row({ status: 'cancelled' })); const user = userEvent.setup(); mount(); await ready(); await open(user)
  expect(checkbox().checked).toBe(false); await user.click(checkbox()); await save(user)
  await screen.findByText('Activity and reminder saved.')
  expect(puts()[0].url.split('/').at(-1)).not.toBe(ID)
  expect(records.get(ID).status).toBe('cancelled'); expect(records.size).toBe(2)
})
it('explains denied permission while still saving activities without reminders', async () => {
  permission = 'denied'; const user = userEvent.setup(); mount(); await ready(); await open(user)
  expect(checkbox().disabled).toBe(true); expect(screen.getByText(/To schedule a reminder, enable notifications/)).toBeTruthy()
  await user.type(input(), 'Indoor reading'); await save(user)
  await screen.findByText('Activity saved without a reminder.'); expect(puts()).toHaveLength(0)
})
it('does not allow scheduling if server restoration failed', async () => {
  getFailure = true; const user = userEvent.setup(); mount(); await screen.findByText(/Could not restore reminders/)
  await open(user); expect(checkbox().disabled).toBe(true); expect(puts()).toHaveLength(0)
})
it('refreshes sent/error outcomes on focus without PUT', async () => {
  records.set(ID, row()); mount(); await ready(); records.set(ID, row({ status: 'uncertain' }))
  await act(async () => window.dispatchEvent(new Event('focus')))
  await screen.findByText('Reminder: Delivery uncertain — no automatic retry'); expect(puts()).toHaveLength(0)
})
it('preserves weather units, Daily Plan, comfort and manual test notifications', async () => {
  const user = userEvent.setup(); mount(); await ready(); await saveNew(user, false)
  await screen.findByText('Activity saved without a reminder.')
  await user.click(screen.getByRole('button', { name: 'Switch to °F' }))
  await user.selectOptions(screen.getByLabelText('Temperature preference'), 'heat_sensitive')
  await user.click(screen.getByRole('button', { name: 'Generate My Daily Plan' })); await screen.findByText('Seek shade outdoors.')
  expect(requests.find((r) => r.url.endsWith('/api/daily-plan')).body.preference).toBe('heat_sensitive')
  await user.click(screen.getByRole('button', { name: 'Send Test Notification' })); await screen.findByText(/Test accepted by the push service/)
  expect(puts()).toHaveLength(0)
})
it('clears removed subscription state without migrating reminders to a new subscription', async () => {
  records.set(ID, row()); const user = userEvent.setup(); mount(); await ready()
  await user.click(screen.getByRole('button', { name: 'Disable Notifications' })); await screen.findByText('Notifications disabled on this device.')
  expect(screen.queryByText('Reminder: Pending')).toBeNull()
  await waitFor(() => expect(JSON.parse(localStorage.getItem(ACTIVITIES_KEY))['2030-01-02T14:00'].reminderStatus).toBe('removed'))
  await user.click(screen.getByRole('button', { name: 'Enable Notifications', exact: true }))
  await screen.findByText(/Notifications enabled. Tap Send Test Notification/); await screen.findByText('No saved reminders for this subscription.')
  expect(JSON.parse(localStorage.getItem(ACTIVITIES_KEY))['2030-01-02T14:00'].reminderStatus).toBe('removed')
  expect(puts()).toHaveLength(0)
})
it('explains missing subscriptions without scheduling silently', async () => {
  localStorage.removeItem(CAPABILITY_STORAGE_KEY)
  const user = userEvent.setup(); mount(); await screen.findByRole('button', { name: /2:00 PM/ }); await open(user)
  expect(checkbox().disabled).toBe(true)
  expect(screen.getByText('Enable Notifications to restore or manage reminders for this device.')).toBeTruthy()
  expect(requests.filter((r) => r.url.includes('/reminders'))).toHaveLength(0)
})
it('explains unsupported browsers and never prompts for permission', async () => {
  delete window.PushManager
  const user = userEvent.setup(); mount(); await ready(); await open(user)
  expect(checkbox().disabled).toBe(true)
  expect(screen.getByText(/This browser does not support Web Push here/)).toBeTruthy()
  expect(Notification.requestPermission).not.toHaveBeenCalled()
})
it('unchecks and cancels before saving local edits, which survive refresh', async () => {
  records.set(ID, row()); const user = userEvent.setup(); const app = mount(); await ready(); await open(user)
  await user.clear(input()); await user.type(input(), 'Local walk'); await user.click(checkbox()); await save(user)
  await screen.findByText('Activity saved without a reminder.')
  expect(records.get(ID).status).toBe('cancelled'); expect(records.get(ID).title).toBe('Server basketball')
  app.unmount(); mount(); await ready(); await open(user)
  expect(input().value).toBe('Local walk'); expect(checkbox().checked).toBe(false)
  expect(puts()).toHaveLength(0)
})
it('requires explicit cancellation before editing an already processing reminder', async () => {
  records.set(ID, row({ status: 'processing' })); const user = userEvent.setup(); mount(); await ready(); await open(user)
  await user.type(input(), ' edited'); await save(user)
  await screen.findByText(/This reminder is already being processed/)
  expect(puts()).toHaveLength(0); expect(records.get(ID).title).toBe('Server basketball')
})
it('prevents sends if device storage cannot retain the draft UUID', async () => {
  const user = userEvent.setup(); mount(); await ready(); await open(user)
  await user.type(input(), 'Basketball'); await user.click(checkbox())
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
  await save(user)
  await screen.findByText(/Device storage is unavailable/)
  expect(puts()).toHaveLength(0)
  storage.mockRestore()
})
it('ignores an old GET response after notifications are disabled', async () => {
  records.set(ID, row()); const user = userEvent.setup(); mount(); await ready()
  const original = fetch
  let deliver
  vi.stubGlobal('fetch', vi.fn((url, options) => url.endsWith('/reminders')
    ? new Promise((resolve) => { deliver = resolve }) : original(url, options)))
  await act(async () => window.dispatchEvent(new Event('focus')))
  await screen.findByText('Restoring reminders…')
  await user.click(screen.getByRole('button', { name: 'Disable Notifications' }))
  await screen.findByText('Notifications disabled on this device.')
  await act(async () => deliver(reply({ reminders: [row()] })))
  expect(screen.queryByText('Reminder: Pending')).toBeNull()
})
it('keeps another location timezone out of the Los Angeles activity editor', async () => {
  records.set(ID, row({ timezone: 'Asia/Taipei', starts_at: '2030-01-02T06:00:00Z' }))
  const user = userEvent.setup(); mount(); await ready()
  await screen.findByText('2030-01-02T14:00 (Asia/Taipei)')
  await open(user)
  expect(input().value).toBe(''); expect(checkbox().checked).toBe(false)
  expect(puts()).toHaveLength(0)
})
it('writes an ordinary activity and restores its UUID and values after a StrictMode remount', async () => {
  localStorage.removeItem(CAPABILITY_STORAGE_KEY)
  const user = userEvent.setup(); const app = mount()
  await screen.findByRole('button', { name: /2:00 PM/ })
  await saveNew(user, false)
  await screen.findByText('Activity saved without a reminder.')
  const saved = JSON.parse(localStorage.getItem(ACTIVITIES_KEY))['2030-01-02T14:00']
  expect(saved.name).toBe('Basketball')
  expect(saved.id).toMatch(/^[0-9a-f-]{36}$/)
  app.unmount(); mount()
  await screen.findByRole('button', { name: /2:00 PM.*Basketball/ })
  await open(user)
  expect(input().value).toBe('Basketball')
  expect(checkbox().checked).toBe(false)
  expect(JSON.parse(localStorage.getItem(ACTIVITIES_KEY))['2030-01-02T14:00']).toEqual(saved)
  expect(puts()).toHaveLength(0)
})
it('does not erase an ordinary saved activity when an empty reminder list restores on refresh', async () => {
  const user = userEvent.setup(); const app = mount(); await ready(); await saveNew(user, false)
  await screen.findByText('Activity saved without a reminder.')
  const saved = JSON.parse(localStorage.getItem(ACTIVITIES_KEY))['2030-01-02T14:00']
  app.unmount(); mount(); await ready()
  await open(user)
  expect(input().value).toBe('Basketball')
  expect(JSON.parse(localStorage.getItem(ACTIVITIES_KEY))['2030-01-02T14:00']).toEqual(saved)
  expect(puts()).toHaveLength(0)
})
