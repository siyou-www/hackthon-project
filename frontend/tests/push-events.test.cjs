const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')

function worker(windows = []) {
  const handlers = {}
  const shown = []
  const opened = []
  const self = {
    addEventListener: (name, callback) => { handlers[name] = callback },
    registration: { showNotification: async (title, options) => shown.push({ title, options }) },
    location: { origin: 'https://daycast.example' },
    clients: { matchAll: async () => windows, openWindow: async (url) => opened.push(url) },
  }
  vm.runInNewContext(readFileSync(new URL('../public/push-events.js', `file://${__filename}`), 'utf8'), { self, URL })
  return { handlers, shown, opened }
}

test('push displays title, body and icon without trusting a payload URL', async () => {
  const { handlers, shown } = worker()
  let pending
  handlers.push({ data: { json: () => ({ title: 'Test', body: 'Hello', url: 'https://evil.example' }) }, waitUntil: (promise) => { pending = promise } })
  await pending
  assert.equal(shown[0].title, 'Test')
  assert.equal(shown[0].options.body, 'Hello')
  assert.equal(shown[0].options.icon, '/pwa-192x192.png')
  assert.equal(shown[0].options.data.url, '/')
  assert.equal(shown[0].options.tag, 'daycast-test')
})

test('reminders use their unique supplied tags', async () => {
  const { handlers, shown } = worker()
  for (const id of ['first', 'second']) {
    let pending
    handlers.push({ data: { json: () => ({ tag: `daycast-reminder-${id}` }) }, waitUntil: (promise) => { pending = promise } })
    await pending
  }
  assert.equal(shown[0].options.tag, 'daycast-reminder-first')
  assert.equal(shown[1].options.tag, 'daycast-reminder-second')
})

test('missing and malformed payloads still show visible fallback notifications', async () => {
  for (const data of [null, { json: () => { throw new Error('invalid') } }]) {
    const { handlers, shown } = worker()
    let pending
    handlers.push({ data, waitUntil: (promise) => { pending = promise } })
    await pending
    assert.equal(shown[0].title, 'DayCast')
  }
})

test('notification click focuses an existing DayCast window', async () => {
  let focused = false
  let closed = false
  const { handlers, opened } = worker([{ url: 'https://daycast.example/', focus: async () => { focused = true } }])
  let pending
  handlers.notificationclick({ notification: { close: () => { closed = true } }, waitUntil: (promise) => { pending = promise } })
  await pending
  assert.ok(focused && closed)
  assert.equal(opened.length, 0)
})

test('notification click opens DayCast when no app window is open', async () => {
  const { handlers, opened } = worker([{ url: 'https://other.example/' }])
  let pending
  handlers.notificationclick({ notification: { close: () => {} }, waitUntil: (promise) => { pending = promise } })
  await pending
  assert.equal(opened[0], '/')
})
