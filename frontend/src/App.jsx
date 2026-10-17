
import { useState, useEffect } from 'react'
import './App.css'

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
  const [activities, setActivities] = useState({})
  const [dailyPlan, setDailyPlan] = useState(null)
const [planLoading, setPlanLoading] = useState(false)
const [planError, setPlanError] = useState('')

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
    setSelectedHour(hour)

    const existingActivity = activities[hour.time]

    setActivityName(existingActivity?.name || '')
    setIsOutdoor(existingActivity?.isOutdoor || false)
  }

  function saveActivity() {
    if (!selectedHour || !activityName.trim()) {
      alert('Please enter an activity name.')
      return
    }

    setActivities((previous) => ({
      ...previous,
      [selectedHour.time]: {
        name: activityName.trim(),
        isOutdoor: isOutdoor
      }
    }))

    setActivityName('')
    setIsOutdoor(false)
    setSelectedHour(null)
  }


async function generateDailyPlan() {
  const selectedActivities = Object.entries(activities).map(
    ([time, activity]) => ({
      time: time,
      title: activity.name,
      outdoor: activity.isOutdoor
    })
  )

  if (selectedActivities.length === 0) {
    setPlanError('Please add an activity first.')
    return
  }

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

            {activities[hour.time] && (
              <p>
                📌 {activities[hour.time].name}
                {activities[hour.time].isOutdoor ? ' 🌳' : ' 🏠'}
              </p>
            )}

            {!activities[hour.time] && (
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
                checked={isOutdoor}
                onChange={(event) =>
                  setIsOutdoor(event.target.checked)
                }
              />
              Outdoor activity
            </label>
          </div>

          <div style={{ marginTop: '12px' }}>
            <button type="button" onClick={saveActivity}>
              Save Activity
            </button>

            <button
              type="button"
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

<button
  type="button"
  onClick={generateDailyPlan}
  disabled={planLoading}
>
  {planLoading ? 'Generating Plan...' : 'Generate My Daily Plan'}
</button>

{planError && (
  <p style={{ color: 'red' }}>
    ⚠️ {planError}
  </p>
)}


{dailyPlan && (
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
                {formatTime(time)} — {activity.name}
                {activity.isOutdoor ? ' (Outdoor)' : ' (Indoor)'}
              </p>
            ))}

          
        </div>
      )}
    </div>
  )
}

export default App
