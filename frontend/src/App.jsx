
import { useState, useEffect, useMemo, useCallback } from 'react'
import './App.css'
import { usePush } from './pushContext.js'
import { useReminders } from './useReminders.js'
import { ACTIVITIES_KEY, DRAFT_KEY, LOCATION, LIVE_STATES, readLocal, writeLocal, mergeReminders, reminderTime, statusLabel } from './activityStorage.js'

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || 'https://daycast-backend.onrender.com'

function App() {
  const [weather, setWeather] = useState([])
  const [loading, setLoading] = useState(true)
  const [weatherRetry, setWeatherRetry] = useState(0)
  const [showOutdoorRecommendation, setShowOutdoorRecommendation] = useState(false)
  const [recommendationNow, setRecommendationNow] = useState(() => Date.now())
  const [error, setError] = useState('')
  const [unit, setUnit] = useState('C')
  const [selectedHour, setSelectedHour] = useState(null)
  const [activityName, setActivityName] = useState('')
  const [isOutdoor, setIsOutdoor] = useState(false)
  const [localActivities, setLocalActivities] = useState(() => readLocal(ACTIVITIES_KEY, {}))
  const [dailyPlan, setDailyPlan] = useState(null)
  const [planInput, setPlanInput] = useState('')
  const [preference, setPreference] = useState('normal')
const [planLoading, setPlanLoading] = useState(false)
const [planError, setPlanError] = useState('')
  const push = usePush()
  const receiveReminders = useCallback((rows, owner, complete) => {
    setLocalActivities((old) => mergeReminders(old, rows, owner, complete))
  }, [])
  const reminders = useReminders(push.capability, receiveReminders)
  const [forecastTimezone, setForecastTimezone] = useState('')
  const [remind, setRemind] = useState(false)
  const [draftId, setDraftId] = useState('')
  const [draftPreference, setDraftPreference] = useState('normal')
  const [saving, setSaving] = useState(false)
  const [activityError, setActivityError] = useState('')
  const [activityMessage, setActivityMessage] = useState('')
  const [draft, setDraft] = useState(() => readLocal(DRAFT_KEY, null))
  const canRemind = push.available && push.permission === 'granted' && push.subscribed
    && push.capability && !push.checking && !push.busy && reminders.ready

  function commitActivities(next) {
    writeLocal(ACTIVITIES_KEY, next)
    setLocalActivities(next)
    setDailyPlan(null)
  }

  const activities = useMemo(() => {
    const restored = reminders.ready ? mergeReminders(localActivities, reminders.records, push.capability.id) : localActivities
    if (push.removedSubscriptionIds.length === 0) return restored
    return Object.fromEntries(Object.entries(restored).map(([time, activity]) => [time,
      push.removedSubscriptionIds.includes(activity.subscriptionId) ? { ...activity, reminderStatus: 'removed' } : activity]))
  }, [localActivities, reminders.ready, reminders.records, push.capability, push.removedSubscriptionIds])

  useEffect(() => {
    // React renders directly from the server snapshot; this effect only persists its device cache.
    try { writeLocal(ACTIVITIES_KEY, activities) }
    catch (error) { queueMicrotask(() => setActivityError(error.message)) }
  }, [activities])

  useEffect(() => {
    async function fetchWeather() {
      try {
        setLoading(true)
        setError('')

        const response = await fetch(
          `${API_BASE_URL}/api/weather?latitude=34.0522&longitude=-118.2437`
        )

        if (!response.ok) {
          throw new Error('Failed to load weather data')
        }

        const data = await response.json()

        if (!Array.isArray(data.hourly)) {
          throw new Error('Invalid weather data')
        }

        const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: data.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(new Date())

const todayWeather = data.hourly.filter((hour) =>
  hour.time.startsWith(today)
)

setWeather(todayWeather)
setForecastTimezone(data.timezone)
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }

    fetchWeather()
  }, [weatherRetry])

  function formatTime(time) {
    const hour = time.split('T')[1]?.slice(0, 5)

    if (!hour) return time

    const [hours, minutes] = hour.split(':').map(Number)
    const period = hours >= 12 ? 'PM' : 'AM'
    const displayHour = hours % 12 || 12

    return `${displayHour}:${String(minutes).padStart(2, '0')} ${period}`
  }

  function selectHour(hour) {
    if (saving || reminders.loading) return
    const snapshot = reminders.ready ? mergeReminders(activities, reminders.records, push.capability.id) : activities
    const existing = snapshot[hour.time]?.timezone === forecastTimezone ? snapshot[hour.time] : undefined
    const server = reminders.records.find((row) => row.activity_id === existing?.id)
    const terminal = server && !LIVE_STATES.includes(server.status)
    const savedDraft = draft?.time === hour.time && !terminal ? draft : null
    setSelectedHour(hour)
    setActivityName(savedDraft?.name ?? existing?.name ?? '')
    setIsOutdoor(savedDraft?.isOutdoor ?? existing?.isOutdoor ?? false)
    setDraftId(savedDraft?.id ?? (terminal ? crypto.randomUUID() : existing?.id) ?? crypto.randomUUID())
    setRemind(savedDraft?.remind ?? Boolean(server && LIVE_STATES.includes(server.status)))
    setDraftPreference(savedDraft?.preference ?? server?.preference ?? preference)
    setActivityError(''); setActivityMessage('')
  }

  async function saveActivity() {
    if (!selectedHour || !activityName.trim()) {
      setActivityError('Please enter an activity name.'); return
    }
    setSaving(true); setActivityError(''); setActivityMessage('')
    try {
      const existing = activities[selectedHour.time]?.timezone === forecastTimezone ? activities[selectedHour.time] : undefined
      const server = reminders.records.find((row) => row.activity_id === existing?.id)
      if (push.capability && !reminders.ready) {
        throw new Error('Restore saved reminders before saving this hour, so an existing reminder is not left active.')
      }
      if (remind && !canRemind) throw new Error('Enable Notifications and restore saved reminders before scheduling.')
      if (existing?.subscriptionId && LIVE_STATES.includes(existing.reminderStatus) && !reminders.ready) {
        throw new Error('Restore saved reminders before changing this activity. Its reminder may still be active.')
      }
      if (remind && server && ['retry', 'processing'].includes(server.status)) {
        throw new Error('This reminder is already being processed. Uncheck the reminder to cancel first; edits cannot reschedule it.')
      }
      if (remind && server && !LIVE_STATES.includes(server.status) && draftId === server.activity_id) {
        throw new Error('This reminder is no longer pending. Close and reopen the activity to explicitly schedule a new reminder.')
      }
      const pendingDraft = { id: draftId, time: selectedHour.time, name: activityName.trim(), isOutdoor,
        preference: draftPreference, remind, timezone: forecastTimezone }
      // Persist the UUID before PUT, including when the response is lost or the app closes.
      writeLocal(DRAFT_KEY, pendingDraft); setDraft(pendingDraft)
      let row = null
      if (remind) {
        row = await reminders.save(draftId, { time: selectedHour.time, timezone: forecastTimezone,
          title: activityName.trim(), outdoor: isOutdoor, preference: draftPreference, ...LOCATION })
      } else if (server && LIVE_STATES.includes(server.status)) {
        await reminders.cancel(server.activity_id)
      }
      const nextActivity = { ...pendingDraft,
        id: !remind && server ? crypto.randomUUID() : draftId,
        subscriptionId: row ? push.capability.id : null, reminderStatus: row?.status ?? null }
      commitActivities({ ...activities, [selectedHour.time]: nextActivity })
      localStorage.removeItem(DRAFT_KEY); setDraft(null)
      setSelectedHour(null)
      setActivityMessage(remind ? 'Activity and reminder saved.' : 'Activity saved without a reminder.')
    } catch (error) {
      setActivityError(error.message)
      if ([403, 404, 409].includes(error.status)) reminders.refresh()
    } finally { setSaving(false) }
  }

  async function cancelReminder(row) {
    setSaving(true); setActivityError(''); setActivityMessage('')
    try {
      await reminders.cancel(row.activity_id)
      setActivityMessage('Reminder cancelled.')
    } catch (error) {
      setActivityError(error.message)
      reminders.refresh()
    } finally { setSaving(false) }
  }

  const planActivities = Object.entries(activities).filter(([time, activity]) =>
    weather.some((hour) => hour.time === time) && activity.timezone === forecastTimezone
  ).map(([time, activity]) => ({ time, title: activity.name, outdoor: activity.isOutdoor }))
  const currentPlanInput = JSON.stringify({ preference, activities: planActivities })

async function generateDailyPlan() {
  const selectedActivities = planActivities

  if (selectedActivities.length === 0) {
    setPlanError('Please add an activity first.')
    return
  }

  setPlanInput(currentPlanInput)
  setPlanLoading(true)
  setPlanError('')
  setDailyPlan(null)

  try {
    const response = await fetch(`${API_BASE_URL}/api/daily-plan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        latitude: 34.0522,
        longitude: -118.2437,
        preference,
        activities: selectedActivities
      })
    })

    if (!response.ok) {
      throw new Error('Failed to generate daily plan')
    }

    const data = await response.json()
    setDailyPlan(data)
  } catch (err) {
    setPlanError(err.message)
  } finally {
    setPlanLoading(false)
  }
}

    const temperatures = weather
    .map((hour) =>
      Number(unit === 'C' ? hour.temperature_c : hour.temperature_f)
    )
    .filter(Number.isFinite)

  const highTemp = temperatures.length ? Math.max(...temperatures) : null
  const lowTemp = temperatures.length ? Math.min(...temperatures) : null
    const preferredTemperatureC =
    preference === 'cold_sensitive' ? 25 :
    preference === 'heat_sensitive' ? 19 : 22

  useEffect(() => {
    if (!showOutdoorRecommendation) return undefined
    const timer = setInterval(() => setRecommendationNow(Date.now()), 15000)
    return () => clearInterval(timer)
  }, [showOutdoorRecommendation])

  const outdoorCandidates = weather.filter((hour) => {
    // Weather hours are wall-clock strings in the forecast timezone, not UTC timestamps.
    const timezone = forecastTimezone || 'America/Los_Angeles'
    const now = new Date(recommendationNow)
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(now)
    const part = (name) => parts.find((item) => item.type === name)?.value || ''
    const localNow = `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`
    const hourOfDay = Number(hour.time.split('T')[1]?.slice(0, 2))
    return hour.time.slice(0, 16) > localNow && hourOfDay >= 8 && hourOfDay <= 18
  })
  const lowestRainChance = outdoorCandidates.length
    ? Math.min(
        ...outdoorCandidates.map((hour) =>
          Number(hour.precipitation_probability ?? 100)
        )
      )
    : null

  const driestCandidates = outdoorCandidates.filter(
    (hour) =>
      Number(hour.precipitation_probability ?? 100) === lowestRainChance
  )
  const recommendedOutdoorHour = [...outdoorCandidates].sort((a, b) => {
    const rainDifference =
      Number(a.precipitation_probability ?? 100) -
      Number(b.precipitation_probability ?? 100)

    if (rainDifference !== 0) return rainDifference

    return (
      Math.abs(Number(a.temperature_c) - preferredTemperatureC) -
      Math.abs(Number(b.temperature_c) - preferredTemperatureC)
    )
  })[0] ?? null
    const temperaturePreferenceLabel =
    preference === 'cold_sensitive'
      ? 'warmer temperatures'
      : preference === 'heat_sensitive'
        ? 'cooler temperatures'
        : 'moderate temperatures'

  // Refresh precisely when the displayed recommendation reaches its start time.
  // A periodic refresh alone can leave an expired hour visible for up to 15 seconds.
  useEffect(() => {
    if (!showOutdoorRecommendation || !recommendedOutdoorHour || !forecastTimezone) return undefined
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: forecastTimezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(recommendationNow))
    const part = (name) => parts.find((item) => item.type === name)?.value || '00'
    const localNow = `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`
    const target = `${recommendedOutdoorHour.time.slice(0, 16)}:00`
    const secondsUntil = (Date.parse(target + 'Z') - Date.parse(localNow + 'Z')) / 1000
    if (secondsUntil <= 0) {
      // Avoid an effect update loop; the periodic timer is a fallback.
      return undefined
    }
    const timer = setTimeout(() => setRecommendationNow(Date.now()), Math.max(1, Math.ceil(secondsUntil * 1000)))
    return () => clearTimeout(timer)
  }, [showOutdoorRecommendation, recommendedOutdoorHour?.time, forecastTimezone, recommendationNow])

  const recommendationReason =
    driestCandidates.length > 1
      ? `Rain chance is tied for the lowest. This hour is closest to your preference for ${temperaturePreferenceLabel}.`
      : 'This hour has the lowest rain probability among the upcoming daytime hours.'

  return (
    <main className="app-shell">
      <header className="topbar"><div className="brand-lockup"><svg aria-hidden="true" width="56" height="56" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="none" stroke="#24446C" strokeWidth="7"/><path d="M50 50 L72 27" stroke="#B8C2CC" strokeWidth="5" strokeLinecap="round"/><circle cx="50" cy="50" r="9" fill="#F6B84A"/></svg><div className="brand-copy"><h1>SkyCue</h1><p className="eyebrow">Know the weather. Plan your day.</p></div></div></header>
      <section className="weather-overview" aria-label="Weather overview"><p className="overview-location">⌖ Los Angeles, CA</p><h2>Today’s forecast</h2><p className="overview-range">{temperatures.length ? `High ${highTemp.toFixed(1)}°${unit} · Low ${lowTemp.toFixed(1)}°${unit}` : 'Weather loading…'}</p></section>
      <button className="outdoor-prompt" type="button" disabled={loading || !!error} onClick={() => { setRecommendationNow(Date.now()); setShowOutdoorRecommendation(true) }}>Help me pick the best time to go out →</button>

      <h2>Today's Hourly Weather — Los Angeles</h2>

      <button
        type="button"
        onClick={() => setUnit(unit === 'C' ? 'F' : 'C')}
      >
        Switch to °{unit === 'C' ? 'F' : 'C'}
      </button>

      {loading && <p>⏳ Loading weather...</p>}

      {error && <button type="button" onClick={() => setWeatherRetry((n) => n + 1)}>Retry weather</button>}
      {error && (
        <p style={{ color: 'red' }}>
          ⚠️ Weather unavailable: {error}
        </p>
      )}

      <p>Forecast timezone: {forecastTimezone || 'Loading…'}</p>
      {activityError && <p role="alert">{activityError}</p>}
      {activityMessage && <p role="status">{activityMessage}</p>}
      {saving && <p role="status">Saving activity or reminder changes…</p>}
      {draft && !selectedHour && <p>An unsaved activity draft is retained. Select its hour to retry.</p>}
      <div className="weather-timeline">
        {weather.map((hour) => (
          <div
            className="weather-card"
            key={hour.time}
            onClick={() => selectHour(hour)}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                selectHour(hour)
              }
            }}
            style={{
              cursor: 'pointer',
              border:
                selectedHour?.time === hour.time
                  ? '2px solid #3878d8'
                  : undefined
            }}
          >
            <p>{formatTime(hour.time)}</p>

            <p>
              {unit === 'C'
                ? `${hour.temperature_c}°C`
                : `${Number(hour.temperature_f).toFixed(1)}°F`}
            </p>

            <p>
              Precipitation: {hour.precipitation_probability}%
            </p>

            {activities[hour.time]?.timezone === forecastTimezone && (
              <p>
                📌 {activities[hour.time].name}
                {activities[hour.time].isOutdoor ? ' 🌳' : ' 🏠'}
              </p>
            )}

            {activities[hour.time]?.timezone !== forecastTimezone && (
              <p style={{ fontSize: '12px', opacity: 0.7 }}>
                + Add activity
              </p>
            )}
          </div>
        ))}
      </div>

      {selectedHour && (
        <div className="activity-panel">
          <h3>Add Activity — {formatTime(selectedHour.time)}</h3>

          <p>Date: {selectedHour.time.split('T')[0]}</p>

          <div>
            <input
              maxLength={200}
              disabled={saving}
              type="text"
              placeholder="Activity name (e.g. Basketball)"
              value={activityName}
              onChange={(event) =>
                setActivityName(event.target.value)
              }
            />
          </div>

          <div style={{ marginTop: '12px' }}>
            <label>
              <input
                type="checkbox"
                disabled={saving}
                checked={isOutdoor}
                onChange={(event) =>
                  setIsOutdoor(event.target.checked)
                }
              />
              Outdoor activity
            </label>
          </div>

          <div>
            <label>
              <input type="checkbox" checked={remind} disabled={saving || (!canRemind && !remind)}
                onChange={(event) => setRemind(event.target.checked)} />
              Remind me 30 minutes before
            </label>
            <p>Activity time: {selectedHour.time} ({forecastTimezone}). The backend validates the 30-minute lead and daylight-saving transitions.</p>
            {!canRemind && <p>To schedule a reminder, enable notifications on this device and restore your subscription. On iPhone, open the installed Home Screen PWA.</p>}
            <label>Reminder temperature preference{' '}
              <select value={draftPreference} disabled={saving} onChange={(event) => setDraftPreference(event.target.value)}>
                <option value="cold_sensitive">Gets cold easily</option><option value="normal">Normal</option><option value="heat_sensitive">Gets hot easily</option>
              </select>
            </label>
            <p>Previously sent or cancelled reminders stay in history. Opting in again creates a new reminder.</p>
          </div>
          <div style={{ marginTop: '12px' }}>
            <button type="button" disabled={saving} onClick={saveActivity}>
              Save Activity
            </button>

            <button
              type="button"
              disabled={saving}
              onClick={() => setSelectedHour(null)}
              style={{ marginLeft: '10px' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {Object.keys(activities).length > 0 && (
        <div style={{ marginTop: '30px' }}>
          <h2>Your Daily Activities</h2>
          <p>Daily Plan uses activities in today's displayed forecast. Other dates remain in your saved history.</p>

<label htmlFor="comfort-preference">Temperature preference </label>
<select
  id="comfort-preference"
  value={preference}
  disabled={planLoading || saving}
  onChange={(event) => {
    setPreference(event.target.value)
    setDailyPlan(null)
  }}
>
  <option value="cold_sensitive">Gets cold easily</option>
  <option value="normal">Normal</option>
  <option value="heat_sensitive">Gets hot easily</option>
</select>

<button
  type="button"
  onClick={generateDailyPlan}
  disabled={planLoading || saving}
>
  {planLoading ? 'Generating Plan...' : 'Generate My Daily Plan'}
</button>

{planError && (
  <p style={{ color: 'red' }}>
    ⚠️ {planError}
  </p>
)}


{dailyPlan && planInput === currentPlanInput && (
  <div className="daily-plan-results">
    <h2>🌤️ Your Personalized Weather Plan</h2>

    {dailyPlan.activities.map((item, index) => (
      <div className="plan-card" key={index}>
        <h3>{item.activity.title}</h3>
        <p>🕒 {formatTime(item.activity.time)}</p>

        <p>
          🌡️ {unit === 'C'
            ? `${item.weather.temperature_c}°C`
            : `${item.weather.temperature_f.toFixed(1)}°F`}
        </p>

        <p>
          💧 Rain: {item.weather.precipitation_probability}%
        </p>

        <p>Comfort: {item.comfort}</p>
        <p>{item.comfort_advice}</p>

        <h4>Weather Advice</h4>

        {item.advice.map((advice, adviceIndex) => (
          <p key={adviceIndex}>💡 {advice}</p>
        ))}
      </div>
    ))}
  </div>
)}


          {Object.entries(activities)
            .sort(([timeA], [timeB]) => timeA.localeCompare(timeB))
            .map(([time, activity]) => (
              <p key={time}>
                {time.split('T')[0]} {formatTime(time)} ({activity.timezone}) — {activity.name}
                {activity.isOutdoor ? ' (Outdoor)' : ' (Indoor)'}
              </p>
            ))}

          
        </div>
      )}
      <section className="section-block" aria-labelledby="reminders-title">
        <h2 id="reminders-title">Saved activity reminders</h2>
        {!push.capability && <p>Enable Notifications to restore or manage reminders for this device.</p>}
        {reminders.loading && <p role="status">Restoring reminders…</p>}
        {reminders.error && <p role="alert">Could not restore reminders: {reminders.error} Use Enable Notifications or Reset Browser Subscription if access expired.</p>}
        <button type="button" onClick={reminders.refresh} disabled={!push.capability || saving || reminders.loading}>Refresh reminder status</button>
        {!reminders.ready && reminders.records.length > 0 && <p>Showing cached reminder status; refresh before editing.</p>}
        {reminders.ready && reminders.records.length === 0 && <p>No saved reminders for this subscription.</p>}
        {reminders.records.map((row) => <article key={row.id} data-testid="reminder-row">
          <h3>{row.title}</h3>
          <p>{reminderTime(row)} ({row.timezone})</p>
          <p>Reminder: {statusLabel(row.status)}</p>
          <p>Temperature preference: {row.preference}</p>
          {LIVE_STATES.includes(row.status) && <button type="button" disabled={saving || !reminders.ready}
            onClick={() => cancelReminder(row)}>Cancel reminder for {row.title}</button>}
        </article>)}
      </section>
      {showOutdoorRecommendation && <div className="skycue-modal-backdrop" role="presentation" onClick={() => setShowOutdoorRecommendation(false)}><section className="skycue-modal" role="dialog" aria-modal="true" aria-label="Best time to go outdoors" onClick={(event) => event.stopPropagation()}><button type="button" onClick={() => setShowOutdoorRecommendation(false)}>Close ✕</button><h2>Best time to go outdoors</h2>{recommendedOutdoorHour ? <><h3>{formatTime(recommendedOutdoorHour.time)}</h3><p>{unit === 'C' ? `${recommendedOutdoorHour.temperature_c}°C` : `${Number(recommendedOutdoorHour.temperature_f).toFixed(1)}°F`} · Rain {recommendedOutdoorHour.precipitation_probability}%</p><p>{recommendationReason}</p></> : <p>No upcoming daytime hours available today.</p>}</section></div>}
    </main>
  )
}

export default App
