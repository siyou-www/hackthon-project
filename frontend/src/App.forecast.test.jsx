import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react'
import App from './App.jsx'
import { ACTIVITIES_KEY } from './activityStorage.js'

vi.mock('./pushContext.js', () => ({ usePush: () => ({ capability: null, removedSubscriptionIds: [], available: false }) }))
vi.mock('./useReminders.js', () => ({ useReminders: () => ({ ready: false, records: [], loading: false }) }))
const hour = (time) => ({ time, temperature_c: 20, temperature_f: 68, precipitation_probability: 10 })
let timezone, hours
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T17:11:00Z'))
  localStorage.clear(); timezone = 'America/Los_Angeles'
  hours = ['09', '10', '11', '23'].map((h) => hour(`2026-10-17T${h}:00`))
  hours.push(hour('2026-10-18T00:00'), hour('2026-10-18T01:00'))
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ timezone, hourly: hours }) })))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function mount() { await act(async () => { render(<App />) }) }
const cards = () => [...document.querySelectorAll('.weather-card')].map((card) => card.querySelector('p').textContent)

it('starts at 10:00 at 10:11 in the forecast timezone, retaining the current hour', async () => {
  await mount(); expect(cards()).toEqual(['10:00 AM', '11:00 AM', '11:00 PM'])
})
it('advances exactly at the hour, with no weather refetch or interaction', async () => {
  vi.setSystemTime(new Date('2026-10-17T17:59:59.500Z')); await mount()
  act(() => vi.advanceTimersByTime(499)); expect(cards()[0]).toBe('10:00 AM')
  act(() => vi.advanceTimersByTime(1)); expect(cards()[0]).toBe('11:00 AM')
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('updates the forecast date at local midnight using retained forecast hours', async () => {
  vi.setSystemTime(new Date('2026-10-18T06:59:59.999Z')); await mount(); expect(cards()).toEqual(['11:00 PM'])
  act(() => vi.advanceTimersByTime(1)); expect(cards()).toEqual(['12:00 AM', '1:00 AM'])
})
it('uses the API timezone for a half-hour offset location', async () => {
  timezone = 'Asia/Kolkata'; vi.setSystemTime(new Date('2026-10-17T04:59:59.999Z'))
  await mount(); expect(cards()[0]).toBe('10:00 AM')
  act(() => vi.advanceTimersByTime(1800001)); expect(cards()[0]).toBe('11:00 AM')
})
it('refreshes after resume and cleans up its clock on unmount', async () => {
  await mount(); vi.setSystemTime(new Date('2026-10-17T18:11:00Z'))
  fireEvent.focus(window); expect(cards()[0]).toBe('11:00 AM')
  cleanup(); expect(vi.getTimerCount()).toBe(0)
})
it('hiding a past card preserves its activity and daily-plan membership', async () => {
  const saved = { id: 'qa-stable-id', name: 'Earlier walk', time: '2026-10-17T09:00', timezone, isOutdoor: true }
  localStorage.setItem(ACTIVITIES_KEY, JSON.stringify({ [saved.time]: saved }))
  await mount(); expect(cards()).not.toContain('9:00 AM')
  expect(JSON.parse(localStorage.getItem(ACTIVITIES_KEY))[saved.time]).toEqual(saved)
  expect(screen.getByRole('button', { name: 'Generate My Daily Plan' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Help me pick/ }))
  expect(screen.getByRole('dialog').textContent).toContain('11:00 AM')
})
it('handles spring-forward and fall-back in the forecast timezone', async () => {
  hours = ['00', '01', '02', '03', '04'].map((h) => hour(`2026-03-08T${h}:00`))
  vi.setSystemTime(new Date('2026-03-08T09:59:59.999Z')); await mount(); expect(cards()[0]).toBe('1:00 AM')
  act(() => vi.advanceTimersByTime(1)); expect(cards()[0]).toBe('3:00 AM')
  cleanup()
  hours = ['00', '01', '02', '03'].map((h) => hour(`2026-11-01T${h}:00`))
  vi.setSystemTime(new Date('2026-11-01T08:59:59.999Z')); await mount(); expect(cards()[0]).toBe('1:00 AM')
  act(() => vi.advanceTimersByTime(1)); expect(cards()[0]).toBe('1:00 AM')
  act(() => vi.advanceTimersByTime(3600000)); expect(cards()[0]).toBe('2:00 AM')
})
