import { useEffect, useState } from 'react'
import './App.css'

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000'

  const ACTIVITIES_STORAGE_KEY = 'SkyCue.activities.v1'

function App() {
  const [weather, setWeather] = useState([])
  const [loading, setLoading] = useState(true)
  const [weatherRetry, setWeatherRetry] = useState(0)
  const [error, setError] = useState('')
  const [unit, setUnit] = useState('C')
  const [selectedHour, setSelectedHour] = useState(null)
  const [activityName, setActivityName] = useState('')
  const [isOutdoor, setIsOutdoor] = useState(false)
  const [activities, setActivities] = useState(() => {
  try {
    return JSON.parse(localStorage.getItem(ACTIVITIES_STORAGE_KEY)) || {}
  } catch {
    return {}
  }
})
  const [dailyPlan, setDailyPlan] = useState(null)
  const [preference, setPreference] = useState('normal')
  const [planLoading, setPlanLoading] = useState(false)
  const [planError, setPlanError] = useState('')
  const [showOutdoorRecommendation, setShowOutdoorRecommendation] = useState(false)

  useEffect(() => {
    async function fetchWeather() {
      try {
        setLoading(true)
        setError('')

        const response = await fetch(
          `${API_BASE_URL}/api/weather?latitude=34.0522&longitude=-118.2437`
        )

        if (!response.ok) throw new Error('Failed to load weather data')

        const data = await response.json()
        if (!Array.isArray(data.hourly)) {
          throw new Error('Invalid weather data')
        }

        const today = new Intl.DateTimeFormat('en-CA', {
          timeZone: data.timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date())

        setWeather(data.hourly.filter((hour) => hour.time.startsWith(today)))
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }

    fetchWeather()
  }, [weatherRetry])

    useEffect(() => {
    localStorage.setItem(
      ACTIVITIES_STORAGE_KEY,
      JSON.stringify(activities)
    )
  }, [activities])

  function formatTime(time) {
    const hour = time.split('T')[1]?.slice(0, 5)
    if (!hour) return time

    const [hours, minutes] = hour.split(':').map(Number)
    const period = hours >= 12 ? 'PM' : 'AM'
    return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${period}`
  }

  function selectHour(hour) {
    setSelectedHour(hour)
    const existing = activities[hour.time]
    setActivityName(existing?.name || '')
    setIsOutdoor(existing?.isOutdoor || false)
  }

  function saveActivity() {
    if (!selectedHour || !activityName.trim()) return

    setActivities((previous) => ({
      ...previous,
      [selectedHour.time]: {
        name: activityName.trim(),
        isOutdoor,
      },
    }))
    setActivityName('')
    setIsOutdoor(false)
    setSelectedHour(null)
    setDailyPlan(null)
  }

  function deleteActivity(time) {
    setActivities((previous) => {
      const updated = { ...previous }
      delete updated[time]
      return updated
    })
    setDailyPlan(null)
  }

  function clearActivities() {
    setActivities({})
    setDailyPlan(null)
    setSelectedHour(null)
  }

  async function generateDailyPlan() {
    const selectedActivities = Object.entries(activities).map(
      ([time, activity]) => ({
        time,
        title: activity.name,
        outdoor: activity.isOutdoor,
      })
    )

    if (selectedActivities.length === 0) {
      setPlanError('Add an activity first to create your daily plan.')
      return
    }

    setPlanLoading(true)
    setPlanError('')
    setDailyPlan(null)

    try {
      const response = await fetch(`${API_BASE_URL}/api/daily-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          latitude: 34.0522,
          longitude: -118.2437,
          preference,
          activities: selectedActivities,
        }),
      })

      if (!response.ok) throw new Error('Failed to generate daily plan')

      setDailyPlan(await response.json())
    } catch (err) {
      setPlanError(err.message)
    } finally {
      setPlanLoading(false)
    }
  }

  const sortedActivities = Object.entries(activities).sort(([a], [b]) =>
    a.localeCompare(b)
  )
  const nextHour =
    weather.find((hour) => new Date(hour.time) >= new Date()) || weather[0]

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

  const outdoorCandidates = weather.filter((hour) => {
    const forecastTime = new Date(hour.time)
    const hourOfDay = Number(hour.time.split('T')[1]?.slice(0, 2))

    return forecastTime >= new Date() && hourOfDay >= 8 && hourOfDay <= 18
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

  const recommendationReason =
    driestCandidates.length > 1
      ? `Rain chance is tied for the lowest. This hour is closest to your preference for ${temperaturePreferenceLabel}.`
      : 'This hour has the lowest rain probability among the upcoming daytime hours.'
  function temperature(hour) {
    if (!hour) return '—'
    return unit === 'C'
      ? `${hour.temperature_c}°C`
      : `${Number(hour.temperature_f).toFixed(1)}°F`
  }

  return (
    <main className="app-shell">
      <header className="topbar">
  <div className="brand-lockup">
    <svg
      aria-hidden="true"
      width="56"
      height="56"
      viewBox="12 18 128 128"
    >
      <circle
        cx="76"
        cy="82"
        r="58"
        fill="none"
        stroke="#C7D5E2"
        strokeWidth="7"
      />
      <circle
        cx="76"
        cy="82"
        r="58"
        fill="none"
        stroke="#24446C"
        strokeWidth="9"
        strokeLinecap="round"
        strokeDasharray="242 122"
        transform="rotate(135 76 82)"
      />
      <path
        d="M76 82 L96 59"
        fill="none"
        stroke="#B8C2CC"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <circle cx="76" cy="82" r="10" fill="#F6B84A" />
      <circle cx="76" cy="82" r="5" fill="#FFD477" opacity="0.72" />
    </svg>

    <div className="brand-copy">
      <h1>SkyCue</h1>
      <p className="eyebrow">Know the weather. Plan your day.</p>
    </div>
  </div>

  <button
    className="unit-toggle"
    type="button"
    onClick={() => setUnit(unit === 'C' ? 'F' : 'C')}
    aria-label={`Switch to degrees ${unit === 'C' ? 'Fahrenheit' : 'Celsius'}`}
  >
    °{unit} <span>/</span> °{unit === 'C' ? 'F' : 'C'}
  </button>
</header>

      <section className="weather-overview" aria-label="Weather overview">
        <div className="overview-location">
          <span>⌖</span> Los Angeles, CA
        </div>
        {loading ? (
          <p className="overview-message">Loading today’s weather…</p>
        ) : error ? (
          <p className="overview-message">Weather is unavailable right now.</p>
        ) : nextHour ? (
          <div className="overview-main">
            <p className="overview-label">Next available hour · {formatTime(nextHour.time)}</p>
            <p className="overview-temperature">{temperature(nextHour)}</p>
            <p className="overview-rain">
              Rain probability: {nextHour.precipitation_probability}%
            </p>
                   

        {highTemp !== null && lowTemp !== null && (
          <p className="overview-range">
            High {highTemp.toFixed(1)}°{unit} · Low {lowTemp.toFixed(1)}°{unit}
          </p>
        )}
          </div>
        ) : (
          <p className="overview-message">No hourly weather is available today.</p>
        )}
      </section>

      <button
  className="outdoor-prompt"
  type="button"
  onClick={() => setShowOutdoorRecommendation(true)}
  disabled={loading}
>
  Help me pick the best time to go out <span aria-hidden="true">→</span>
</button>
      <section className="section-block">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Plan around the forecast</p>
            <h2>Hourly Weather</h2>
          </div>
          <span className="section-note">Today · swipe to explore</span>
        </div>

        {loading && <p className="status-message">Loading hourly weather…</p>}
        {error && (
  <>
    <p className="error-message">Weather unavailable: {error}</p>
    <button
      className="retry-button"
      type="button"
      onClick={() => setWeatherRetry((count) => count + 1)}
      disabled={loading}
    >
      {loading ? 'Retrying…' : 'Retry weather'}
    </button>
  </>
)}
        {!loading && !error && weather.length === 0 && (
          <p className="status-message">No hourly forecast is available today.</p>
        )}

        <div className="weather-timeline">
          {weather.map((hour) => (
            <button
              className={`weather-card ${
                selectedHour?.time === hour.time ? 'is-selected' : ''
              }`}
              key={hour.time}
              type="button"
              onClick={() => selectHour(hour)}
              aria-pressed={selectedHour?.time === hour.time}
            >
              <span className="weather-time">{formatTime(hour.time)}</span>
              <span className="weather-temperature">{temperature(hour)}</span>
              <span className="weather-rain">
                💧 {hour.precipitation_probability}%
              </span>
              <span className="weather-add">
                {activities[hour.time]
                  ? `📌 ${activities[hour.time].name}`
                  : '+ Add activity'}
              </span>
            </button>
          ))}
        </div>
      </section>

      {selectedHour && (
        <section className="activity-editor">
          <div>
            <p className="eyebrow">Selected time · {formatTime(selectedHour.time)}</p>
            <h2>{activities[selectedHour.time] ? 'Edit activity' : 'Add an activity'}</h2>
          </div>
          <p className="selected-weather">
  Forecast: {temperature(selectedHour)} · Rain probability:{' '}
  {selectedHour.precipitation_probability ?? '—'}%
</p>
          <label className="field-label" htmlFor="activity-name">Activity name</label>
          <input
            id="activity-name"
            className="activity-input"
            type="text"
            placeholder="For example, basketball"
            value={activityName}
            onChange={(event) => setActivityName(event.target.value)}
          />
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={isOutdoor}
              onChange={(event) => setIsOutdoor(event.target.checked)}
            />
            This is an outdoor activity
          </label>
          <div className="editor-actions">
            <button className="primary-button compact" type="button" onClick={saveActivity}>
              Save activity
            </button>
            <button className="text-button" type="button" onClick={() => setSelectedHour(null)}>
              Cancel
            </button>
          </div>
        </section>
      )}

      <section className="section-block activities-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Make room for what matters</p>
            <h2>My Activities</h2>
          </div>
          {sortedActivities.length > 0 && (
            <button className="text-button" type="button" onClick={clearActivities}>
              Clear all
            </button>
          )}
        </div>

        {sortedActivities.length === 0 ? (
          <div className="empty-state">
            <span aria-hidden="true">＋</span>
            <p>No activities yet. Tap an hourly forecast card to add one.</p>
          </div>
        ) : (
          <div className="activity-list">
            {sortedActivities.map(([time, activity]) => (
              <article className="activity-row" key={time}>
                <div className="activity-icon" aria-hidden="true">
                  {activity.isOutdoor ? '🌿' : '⌂'}
                </div>
                <button
                  className="activity-details"
                  type="button"
                  onClick={() => selectHour(weather.find((hour) => hour.time === time) || { time })}
                >
                  <strong>{activity.name}</strong>
                  <span>{formatTime(time)} · {activity.isOutdoor ? 'Outdoor' : 'Indoor'}</span>
                </button>
                <button
                  className="delete-button"
                  type="button"
                  onClick={() => deleteActivity(time)}
                  aria-label={`Delete ${activity.name}`}
                >
                  Delete
                </button>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="plan-section">
        <div className="plan-intro">
          <p className="eyebrow">Personalized for your day</p>
          <h2>Ready to make a plan?</h2>
          <p>Get weather advice for each activity on your schedule.</p>
        </div>

        <label className="preference-label" htmlFor="comfort-preference">
          Temperature preference
        </label>
        <select
          id="comfort-preference"
          className="preference-select"
          value={preference}
          disabled={planLoading}
          onChange={(event) => {
            setPreference(event.target.value)
            setDailyPlan(null)
          }}
        >
          <option value="cold_sensitive">I get cold easily</option>
          <option value="normal">Neither too hot nor too cold</option>
          <option value="heat_sensitive">I get hot easily</option>
        </select>

        <button
          className="primary-button generate-button"
          type="button"
          onClick={generateDailyPlan}
          disabled={planLoading || sortedActivities.length === 0}
        >
          {planLoading ? 'Generating your plan…' : '✨ Generate My Daily Plan'}
        </button>

        {sortedActivities.length === 0 && (
  <p className="plan-hint">
    Add an activity above to generate your daily plan.
  </p>
)}

        {planError && (
  <>
    <p className="error-message">{planError}</p>
    <button
      className="retry-button"
      type="button"
      onClick={generateDailyPlan}
      disabled={planLoading}
    >
      {planLoading ? 'Retrying…' : 'Retry plan'}
    </button>
  </>
)}
      </section>

      {dailyPlan && (
        <section className="section-block advice-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Your forecast, made useful</p>
              <h2>Personalized Advice</h2>
            </div>
          </div>
          <div className="advice-list">
            {dailyPlan.activities.map((item, index) => (
              <article className="advice-card" key={`${item.activity.time}-${index}`}>
                <div className="advice-card-heading">
                  <div>
                    <h3>{item.activity.title}</h3>
                    <p>{formatTime(item.activity.time)}</p>
                  </div>
                  <span className="advice-temperature">
                    {unit === 'C'
                      ? `${item.weather.temperature_c}°C`
                      : `${Number(item.weather.temperature_f).toFixed(1)}°F`}
                  </span>
                </div>
                <p className="advice-rain">
                  💧 Rain probability: {item.weather.precipitation_probability}%
                </p>
                <p className="comfort-text">{item.comfort_advice}</p>
                {item.advice.map((advice, adviceIndex) => (
                  <p className="advice-tip" key={adviceIndex}>💡 {advice}</p>
                ))}
              </article>
            ))}
          </div>
        </section>
      )}

      <footer className="app-footer">SkyCue · Know the weather. Plan your day.</footer>
      {showOutdoorRecommendation && (
  <div
    className="recommendation-backdrop"
    onClick={() => setShowOutdoorRecommendation(false)}
  >
    <section
      className="recommendation-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recommendation-title"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        className="recommendation-close"
        type="button"
        aria-label="Close recommendation"
        onClick={() => setShowOutdoorRecommendation(false)}
      >
        ×
      </button>

      <p className="eyebrow">Outdoor recommendation</p>
      <h2 id="recommendation-title">Best time to go outside</h2>

      {recommendedOutdoorHour ? (
        <>
          <p className="recommendation-time">
            {formatTime(recommendedOutdoorHour.time)}
          </p>
          <p className="outdoor-pick-detail">
            {temperature(recommendedOutdoorHour)} · Rain probability:{' '}
            {recommendedOutdoorHour.precipitation_probability}%
          </p>
          <div className="recommendation-reason">
            <strong>Why this time?</strong>
            <p>{recommendationReason}</p>
          </div>
        </>
      ) : (
        <p className="outdoor-pick-detail">
          No upcoming daytime forecast is available.
        </p>
      )}
    </section>
  </div>
)}
    </main>
  )
}

export default App