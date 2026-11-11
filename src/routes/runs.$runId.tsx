import { createFileRoute } from '@tanstack/react-router'
import { History } from '../features/history'
export const Route = createFileRoute('/runs/$runId')({ component: () => <History id={Route.useParams().runId} /> })
