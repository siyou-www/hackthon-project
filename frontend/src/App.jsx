
import './App.css'

const mockWeather = [
  {
    time: "08:00",
    temperature_c: 12,
    temperature_f: 53.6,
    precipitation_probability: 10
  },
  {
    time: "12:00",
    temperature_c: 26,
    temperature_f: 78.8,
    precipitation_probability: 5
  },
  {
    time: "16:00",
    temperature_c: 23,
    temperature_f: 73.4,
    precipitation_probability: 30
  },
  {
    time: "20:00",
    temperature_c: 15,
    temperature_f: 59,
    precipitation_probability: 65
  }
]


function App() {
  return (
    <div>
      <h1>🌤️ DayCast</h1>
      <p>Know the weather. Plan your day.</p>
      <h2>Today's Hourly Weather</h2>
      <div className="weather-timeline">
        {mockWeather.map((hour, index) => (
          <div className="weather-card" key={hour.time}>
            <p>{hour.time}</p>
            <p>{hour.temperature_c}°C / {hour.temperature_f}°F</p>
            <p>Precipitation: {hour.precipitation_probability}%</p>
          </div>
        ))}
      </div>
    </div>
  )
}

export default App
