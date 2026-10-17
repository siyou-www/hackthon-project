import { useEffect, useRef, useState } from 'react'
import './NotificationOnboarding.css'

export const ONBOARDING_KEY = 'skycue.notifications.onboarding.v1'

function wasSeen() {
  try { return localStorage.getItem(ONBOARDING_KEY) === 'seen' }
  catch { return true } // Keep the optional prompt quiet if preferences cannot be read.
}

export default function NotificationOnboarding({ eligible, enable, busy, error }) {
  const dialog = useRef(null)
  const dismissButton = useRef(null)
  const [seen, setSeen] = useState(wasSeen)
  const [openAfterClick, setOpenAfterClick] = useState(false)
  const open = openAfterClick || (eligible && !seen)

  useEffect(() => {
    const element = dialog.current
    if (open) {
      element.showModal()
      dismissButton.current.focus()
    }
    else element.close()
    return () => element.close()
  }, [open])

  function remember() {
    setSeen(true)
    try { localStorage.setItem(ONBOARDING_KEY, 'seen') } catch { /* Manual enable stays available. */ }
  }

  function dismiss() {
    remember()
    setOpenAfterClick(false)
  }

  async function activate() {
    remember()
    setOpenAfterClick(true)
    // Invoke the shared enable handler directly within this user gesture.
    if (await enable()) setOpenAfterClick(false)
  }

  return (
    <dialog ref={dialog} className="notification-onboarding"
      aria-labelledby="notification-onboarding-title" aria-describedby="notification-onboarding-description"
      onCancel={(event) => { event.preventDefault(); dismiss() }}>
      <h2 id="notification-onboarding-title">A little heads-up from SkyCue</h2>
      <p id="notification-onboarding-description">
        Enable notifications to receive weather-aware reminders before activities
        you choose. Reminders are always opt-in, and you can turn notifications off anytime.
      </p>
      {busy && <p role="status">Enabling notifications…</p>}
      {error && <p role="alert">{error} You can try again later in Notifications.</p>}
      <div className="notification-onboarding-actions">
        <button type="button" className="notification-onboarding-enable" disabled={Boolean(busy)} onClick={activate}>
          {busy ? 'Enabling…' : 'Enable Notifications'}
        </button>
        <button ref={dismissButton} type="button" onClick={dismiss}>Not Now</button>
      </div>
    </dialog>
  )
}
