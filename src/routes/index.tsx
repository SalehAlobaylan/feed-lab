import { createFileRoute } from '@tanstack/react-router'
import { Workspace } from '../features/workspace'
import { validID } from '../lib/feed'
export const Route = createFileRoute('/')({
  validateSearch: (search): { rerun?: string } => ({ rerun: validID(search.rerun) ? search.rerun : undefined }),
  component: () => <Workspace rerunId={Route.useSearch().rerun} />,
})
