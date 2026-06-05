import { useContext, useMemo } from 'react'
import {
  OverlayActiveContext,
  PaneVisibleContext,
  SessionVisibleContext
} from '../web-visibility-context'

// Combined "should this WebContentsView paint right now" answer. WebPreview observes this
// and either streams bounds (true) or calls hide (false). See ../web-visibility for the
// three orthogonal axes that compose this.
export function useWebViewVisible(): boolean {
  const pane = useContext(PaneVisibleContext)
  const session = useContext(SessionVisibleContext)
  const overlay = useContext(OverlayActiveContext)
  return useMemo(() => pane && session && !overlay, [pane, session, overlay])
}
