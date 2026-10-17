import { useEffect, useState } from 'react'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000'
const STORAGE_KEY = 'daycast.push.capability.v1'

function readCapability() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY))
    return value?.id && value?.token ? value : null
  } catch {
    return null
  }
}

function publicKeyBytes(value) {
  const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4))
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0))
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}/api/push${path}`, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(typeof data.detail === 'string' ? data.detail : 'Notification request failed.')
    error.status = response.status
    throw error
  }
  return data
}

async function readyWorker() {
  // vite-plugin-pwa owns registration. Do not register another service worker.
  let timer
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Service worker is not ready. Reload the installed production app and try again.')), 10000) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export default function Notifications() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  const supported = window.isSecureContext && 'serviceWorker' in navigator
    && 'PushManager' in window && 'Notification' in window
  const available = supported && (!ios || standalone)
  const [permission, setPermission] = useState(supported ? Notification.permission : 'unsupported')
  const [subscribed, setSubscribed] = useState(false)
  const [capability, setCapability] = useState(readCapability)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!available) return
    let active = true
    function refresh() {
      setPermission(Notification.permission)
      navigator.serviceWorker.getRegistration('/').then(async (registration) => {
        const subscription = await registration?.pushManager.getSubscription()
        if (active) setSubscribed(Boolean(subscription))
      }).catch(() => { if (active) setError('Could not read notification subscription status.') })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => { active = false; window.removeEventListener('focus', refresh) }
  }, [available])

  async function enable() {
    setBusy('enable'); setError(''); setMessage('')
    let created = null
    try {
      // Must run directly in the click handler before network/worker awaits on iOS.
      const result = Notification.permission === 'default'
        ? await Notification.requestPermission() : Notification.permission
      setPermission(result)
      if (result !== 'granted') throw new Error('Permission was not granted. You can change it in browser or iPhone notification settings.')
      const registration = await readyWorker()
      const { public_key: key } = await api('/public-key')
      let subscription = await registration.pushManager.getSubscription()
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKeyBytes(key) })
        created = subscription
      }
      const saved = await api('/subscriptions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: subscription.toJSON(), token: capability?.token }),
      })
      // Keep the capability only on this device; never put it in URLs or logs.
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
      setCapability(saved); setSubscribed(true)
      setMessage('Notifications enabled. Tap Send Test Notification to send your first test.')
    } catch (failure) {
      if (created) await created.unsubscribe().catch(() => {})
      setError(failure.message)
    } finally {
      setBusy('')
    }
  }

  async function disable() {
    setBusy('disable'); setError(''); setMessage('')
    try {
      if (capability) {
        try {
          await api(`/subscriptions/${capability.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${capability.token}` } })
        } catch (failure) {
          // Expired/deleted server records should not block browser opt-out.
          if (![403, 410].includes(failure.status)) throw failure
        }
      }
      const registration = await readyWorker()
      const subscription = await registration.pushManager.getSubscription()
      if (subscription && !await subscription.unsubscribe()) throw new Error('Could not disable browser subscription. Please try again.')
      localStorage.removeItem(STORAGE_KEY)
      setCapability(null); setSubscribed(false)
      setMessage('Notifications disabled on this device.')
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy('')
    }
  }

  async function sendTest() {
    setBusy('test'); setError(''); setMessage('')
    try {
      await api(`/subscriptions/${capability.id}/test`, { method: 'POST', headers: { Authorization: `Bearer ${capability.token}` } })
      setMessage('Test accepted by the push service. Check system notifications; delivery may be delayed.')
    } catch (failure) {
      setError(failure.message)
      if ([403, 410].includes(failure.status)) {
        localStorage.removeItem(STORAGE_KEY); setCapability(null)
      }
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="notifications-panel" aria-labelledby="notifications-title">
      <h2 id="notifications-title">Notifications</h2>
      <p>Permission: {permission}. Subscription: {subscribed && capability ? 'enabled' : subscribed ? 'browser subscription needs recovery' : 'not enabled'}.</p>
      {ios && !standalone && <p>On iPhone or iPad, use Safari → Share → Add to Home Screen, then open DayCast from its Home Screen icon. Web Push requires iOS/iPadOS 16.4 or later.</p>}
      {!supported && <p>This browser does not support Web Push here. Use an HTTPS site and a supported browser. On iPhone, use the Home Screen app on iOS 16.4 or later.</p>}
      {permission === 'denied' && <p>Notifications are blocked. Enable permission in your browser or iPhone Settings → Notifications → DayCast, then reopen DayCast.</p>}
      <button type="button" disabled={!available || Boolean(busy) || permission === 'denied' || (subscribed && Boolean(capability))} onClick={enable}>
        {busy === 'enable' ? 'Enabling…' : 'Enable Notifications'}
      </button>
      <button type="button" disabled={!available || Boolean(busy) || !subscribed || !capability || permission !== 'granted'} onClick={sendTest}>
        {busy === 'test' ? 'Sending…' : 'Send Test Notification'}
      </button>
      {(subscribed || capability) && <button type="button" disabled={Boolean(busy)} onClick={disable}>
        {busy === 'disable' ? 'Disabling…' : capability ? 'Disable Notifications' : 'Reset Browser Subscription'}
      </button>}
      {busy && <p role="status">Working on notifications…</p>}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      <p>Test notifications are opt-in only. No automatic weather alerts are sent.</p>
    </section>
  )
}
