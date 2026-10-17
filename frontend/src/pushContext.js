import { createContext, useContext } from 'react'
export const PushContext = createContext(null)
export function usePush() { return useContext(PushContext) }
