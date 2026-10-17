import { useEffect, useState } from 'react'

function localParts(now, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now))
}

// Forecast timestamps are location wall-clock strings, not device-local dates.
export default function useForecastHour(timezone) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!timezone) return undefined
    let timer
    function refresh() {
      clearTimeout(timer)
      const timestamp = Date.now()
      setNow(timestamp)
      const parts = localParts(timestamp, timezone)
      const get = (type) => Number(parts.find((part) => part.type === type).value)
      const elapsed = get('minute') * 60000 + get('second') * 1000 + timestamp % 1000
      timer = setTimeout(refresh, 3600000 - elapsed)
    }
    function resume() {
      if (document.visibilityState === 'visible') refresh()
    }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', resume)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [timezone])

  if (!timezone) return ''
  const parts = localParts(now, timezone)
  const get = (type) => parts.find((part) => part.type === type).value
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:00`
}
