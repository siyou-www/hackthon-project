import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Notifications from './Notifications.jsx'
import { ONBOARDING_KEY } from './NotificationOnboarding.jsx'
import { CAPABILITY_STORAGE_KEY } from './pushApi.js'

let permission, subscription, registration, requestPermission, fetchMock
const capability = { id: 'test-id', token: 'test-device-capability' }
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const mount = () => render(<StrictMode><Notifications><p>Weather stays available</p></Notifications></StrictMode>)
const dialog = () => screen.findByRole('dialog')

beforeEach(() => {
  localStorage.clear()
  permission = 'default'; subscription = null
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Chrome' })
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: false })
  window.matchMedia = vi.fn(() => ({ matches: false }))
  Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} })
  requestPermission = vi.fn(async () => { permission = 'granted'; return permission })
  Object.defineProperty(window, 'Notification', { configurable: true, value: {
    get permission() { return permission }, requestPermission,
  } })
  registration = { pushManager: {
    getSubscription: vi.fn(async () => subscription),
    subscribe: vi.fn(async () => {
      subscription = { toJSON: () => ({ endpoint: 'https://push.example/test', keys: {} }),
        unsubscribe: vi.fn(async () => { subscription = null; return true }) }
      return subscription
    }),
  } }
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
    getRegistration: vi.fn(async () => registration), ready: Promise.resolve(registration),
  } })
  fetchMock = vi.fn(async (url) => url.endsWith('/public-key')
    ? reply({ public_key: btoa('x'.repeat(65)) }) : reply(capability))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function noPrompt() {
  await waitFor(() => expect(navigator.serviceWorker.getRegistration).toHaveBeenCalled())
  await act(async () => {})
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(requestPermission).not.toHaveBeenCalled()
}

it('offers the first eligible launch without requesting system permission', async () => {
  mount()
  const prompt = await dialog()
  expect(within(prompt).getByRole('button', { name: 'Enable Notifications' })).toBeTruthy()
  expect(within(prompt).getByRole('button', { name: 'Not Now' })).toBeTruthy()
  expect(document.activeElement).toBe(within(prompt).getByRole('button', { name: 'Not Now' }))
  expect(requestPermission).not.toHaveBeenCalled()
  expect(fetchMock).not.toHaveBeenCalled()
})

it('uses the shared click handler, registration, and capability storage to enable', async () => {
  const user = userEvent.setup(); mount()
  await user.click(within(await dialog()).getByRole('button', { name: 'Enable Notifications' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(requestPermission).toHaveBeenCalledTimes(1)
  expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1)
  expect(JSON.parse(localStorage.getItem(CAPABILITY_STORAGE_KEY))).toEqual(capability)
  expect(screen.getByText(/Subscription: enabled/)).toBeTruthy()
  expect(localStorage.getItem(ONBOARDING_KEY)).toBe('seen')
})

it('remembers Not Now across remounts without changing activity or capability data', async () => {
  localStorage.setItem('daycast.activities.v1', '{"saved":"activity"}')
  const user = userEvent.setup(); const app = mount()
  await user.click(within(await dialog()).getByRole('button', { name: 'Not Now' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  app.unmount(); mount(); await noPrompt()
  expect(localStorage.getItem('daycast.activities.v1')).toBe('{"saved":"activity"}')
  expect(localStorage.getItem(CAPABILITY_STORAGE_KEY)).toBeNull()
  // Manual enable remains available after declining onboarding.
  await user.click(screen.getByRole('button', { name: 'Enable Notifications' }))
  await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1))
  await screen.findByText(/Subscription: enabled/)
})

it('remembers Escape dismissal', async () => {
  mount(); fireEvent(await dialog(), new Event('cancel', { cancelable: true }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(localStorage.getItem(ONBOARDING_KEY)).toBe('seen')
})

it.each(['granted', 'denied'])('does not prompt with existing %s permission', async (value) => {
  permission = value; mount(); await noPrompt()
  if (value === 'denied') expect(screen.getByRole('button', { name: 'Enable Notifications' }).disabled).toBe(true)
})

it('waits for subscription inspection and never interrupts an existing subscriber', async () => {
  let resolve
  registration.pushManager.getSubscription.mockImplementation(() => new Promise((done) => { resolve = done }))
  localStorage.setItem(CAPABILITY_STORAGE_KEY, JSON.stringify(capability))
  mount(); await act(async () => {})
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => { resolve({ toJSON: () => ({}) }) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(requestPermission).not.toHaveBeenCalled()
})

it('does not prompt in an unsupported browser', async () => {
  delete window.PushManager
  mount(); await act(async () => {})
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(requestPermission).not.toHaveBeenCalled()
})

it('does not prompt while a browser subscription needs capability recovery', async () => {
  subscription = { toJSON: () => ({}) }
  mount(); await noPrompt()
})

it('does not prompt when subscription inspection fails', async () => {
  registration.pushManager.getSubscription.mockRejectedValue(new Error('unavailable'))
  mount(); await screen.findByText('Could not read notification subscription status.')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(requestPermission).not.toHaveBeenCalled()
})

it.each([false, true])('iPhone Home Screen mode %s controls eligibility', async (installed) => {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' })
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: installed })
  mount()
  if (installed) expect(await dialog()).toBeTruthy()
  else {
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText(/Safari → Share/)).toBeTruthy()
  }
  expect(requestPermission).not.toHaveBeenCalled()
})

it('shows denial feedback and remains dismissible without subscribing', async () => {
  requestPermission.mockImplementation(async () => { permission = 'denied'; return permission })
  const user = userEvent.setup(); mount(); const prompt = await dialog()
  await user.click(within(prompt).getByRole('button', { name: 'Enable Notifications' }))
  expect(await within(prompt).findByRole('alert')).toBeTruthy()
  expect(fetchMock).not.toHaveBeenCalled()
  await user.click(within(prompt).getByRole('button', { name: 'Not Now' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('handles registration failure, rolls back the subscription, and does not repeat on reload', async () => {
  fetchMock.mockImplementation(async (url) => url.endsWith('/public-key')
    ? reply({ public_key: btoa('x'.repeat(65)) }) : reply({ detail: 'Please try again later.' }, 503))
  const user = userEvent.setup(); const app = mount(); const prompt = await dialog()
  await user.click(within(prompt).getByRole('button', { name: 'Enable Notifications' }))
  expect((await within(prompt).findByRole('alert')).textContent).toContain('Please try again later.')
  expect(subscription).toBeNull()
  expect(localStorage.getItem(CAPABILITY_STORAGE_KEY)).toBeNull()
  app.unmount(); mount(); await noPromptAfterAttempt()
})

async function noPromptAfterAttempt() {
  await act(async () => {})
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(requestPermission).toHaveBeenCalledTimes(1)
}
