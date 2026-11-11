import { createFileRoute } from '@tanstack/react-router'
import { dispatch } from '../lib/server/dispatch.server'

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      GET: ({ request }) => dispatch(request),
      POST: ({ request }) => dispatch(request),
      PATCH: ({ request }) => dispatch(request),
      DELETE: ({ request }) => dispatch(request),
    },
  },
})
