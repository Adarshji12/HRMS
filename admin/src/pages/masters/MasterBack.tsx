import { Link } from 'react-router-dom'
import '../../styles/masterhub.css'
import { IconArrowLeft } from '../../components/Icons'

/** The arrow back to the Master menu, on every screen one of its cards opens.
 *  A link rather than history.back(): these pages are bookmarked and shared,
 *  and "back" from a fresh tab would leave the app. */
export default function MasterBack({ to = '/masters' }: { to?: string }) {
  return (
    <Link to={to} className="master-back" aria-label="Back to Master" title="Back to Master">
      <IconArrowLeft size={18} />
    </Link>
  )
}

/** Formerly the "Back to Master" button above every screen a Master card
 *  opens. The way back is now the "Master" crumb in the top bar
 *  (Master › Geography › State), so this draws nothing. Kept, with its old
 *  props, so the screens that render it need not change. */
export function MasterTrail(_props: {
  crumbs?: Array<{ label: string; to?: string }>
  back?: string
}) {
  return null
}
