const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://daycast-backend.onrender.com'
export const CAPABILITY_STORAGE_KEY = 'daycast.push.capability.v1'

export function readCapability() {
  try {
    const value = JSON.parse(localStorage.getItem(CAPABILITY_STORAGE_KEY))
    return value?.id && value?.token ? value : null
  } catch {
    return null
  }
}

export async function pushApi(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}/api/push${path}`, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = typeof data.detail === 'string' ? data.detail
      : Array.isArray(data.detail) ? data.detail.map((item) => item.msg).join('; ') : 'Notification request failed.'
    const error = new Error(detail)
    error.status = response.status
    throw error
  }
  return data
}
