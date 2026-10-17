/* Loaded by the existing Workbox service worker, not a second registration. */
self.addEventListener('push', (event) => {
  let message = {}
  try {
    message = event.data?.json() || {}
  } catch {
    // Always show a visible notification, even if an upstream payload is malformed.
  }
  const title = typeof message.title === 'string' ? message.title.slice(0, 100) : 'DayCast'
  const body = typeof message.body === 'string' ? message.body.slice(0, 500) : 'You have a new DayCast notification.'
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag: 'daycast-test',
    data: { url: '/' },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin)
    if (existing) return existing.focus()
    return self.clients.openWindow('/')
  })())
})
