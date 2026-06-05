import type { ReactNode } from 'react'
import {
  OverlayActiveContext,
  PaneVisibleContext,
  SessionVisibleContext
} from './web-visibility-context'

// Providers for the three axes that decide whether a WebContentsView paints. The contexts
// themselves live in ./web-visibility-context (non-component exports); the hook that combines
// them lives in ./hooks/useWebViewVisible. WebPreview reads the hook; App/DeckTabs render
// the providers — any false → hide, all true → setBounds(rect).

export function PaneVisibleProvider({
  visible,
  children
}: {
  visible: boolean
  children: ReactNode
}): React.JSX.Element {
  return <PaneVisibleContext.Provider value={visible}>{children}</PaneVisibleContext.Provider>
}

export function SessionVisibleProvider({
  visible,
  children
}: {
  visible: boolean
  children: ReactNode
}): React.JSX.Element {
  return <SessionVisibleContext.Provider value={visible}>{children}</SessionVisibleContext.Provider>
}

export function OverlayActiveProvider({
  active,
  children
}: {
  active: boolean
  children: ReactNode
}): React.JSX.Element {
  return <OverlayActiveContext.Provider value={active}>{children}</OverlayActiveContext.Provider>
}
