
import { useState, useEffect, useMemo, useCallback } from 'react'
import './App.css'
import { usePush } from './pushContext.js'
import { useReminders } from './useReminders.js'
import { ACTIVITIES_KEY, DRAFT_KEY, LOCATION, LIVE_STATES, readLocal, writeLocal, mergeReminders, reminderTime, statusLabel } from './activityStorage.js'

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000'

function App() {
  const [weather, setWeather] = useState([])
  const [loading, setLoading] = useState(true)
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
  }, [])

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

  return (
    <div>
      <h1>🌤️ DayCast</h1>
      <p>Know the weather. Plan your day.</p>

      <h2>Today's Hourly Weather — Los Angeles</h2>

      <button
        type="button"
        onClick={() => setUnit(unit === 'C' ? 'F' : 'C')}
      >
        Switch to °{unit === 'C' ? 'F' : 'C'}
      </button>

      {loading && <p>⏳ Loading weather...</p>}

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
      <section aria-labelledby="reminders-title">
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
    </div>
  )
}

export default App
