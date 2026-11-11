import { createServerFn } from '@tanstack/react-start'
import { setResponseHeader } from '@tanstack/react-start/server'

export const getLaunch = createServerFn({ method: 'GET' }).handler(async () => {
  const { runtime, services, quickSignInCredentials } = await import('./server/owner.server')
  setResponseHeader('cache-control', 'no-store')
  return { ...runtime(), services: [...services], quickSignIn: Boolean(quickSignInCredentials()) }
})
