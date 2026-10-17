import { useEffect, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'

// The PWA update is opt-in so editing an activity is not interrupted.
export default function PwaUpdatePrompt() {
  const [needRefresh, setNeedRefresh] = useState(false)
  const [offlineReady, setOfflineReady] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [updateSW, setUpdateSW] = useState(null)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined
    const update = registerSW({
      immediate: true,
      onNeedRefresh() { setNeedRefresh(true) },
      onOfflineReady() { setOfflineReady(true) },
      onRegisterError(error) { console.warn('PWA registration failed', error) },
    })
    setUpdateSW(() => update)
    return undefined
  }, [])

  if (!needRefresh && !offlineReady) return null

  return <aside role="status" aria-live="polite" style={{
    position: 'fixed', bottom: 16, left: 16, right: 16, maxWidth: 440,
    margin: '0 auto', padding: 16, borderRadius: 14, zIndex: 9999,
    background: '#243b53', color: '#fff', boxShadow: '0 4px 20px #0004'
  }}>
    {needRefresh ? <>
      <strong>SkyCue update available</strong>
      <p>Save any activity you are editing before updating.</p>
      <button type="button" disabled={updating} onClick={async () => {
        if (!window.confirm('Have you saved your activity? Updating will reload SkyCue and discard unsaved changes.')) return
        setUpdating(true)
        try { await updateSW?.(true) } catch { setUpdating(false) }
      }}>{updating ? 'Updating…' : 'Update now'}</button>
      <button type="button" onClick={() => setNeedRefresh(false)} style={{ marginLeft: 12 }}>Later</button>
    </> : <>
      <span>SkyCue is ready for offline access.</span>
      <button type="button" onClick={() => setOfflineReady(false)} style={{ marginLeft: 12 }}>Dismiss</button>
    </>}
  </aside>
}
