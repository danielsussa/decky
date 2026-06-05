import { createContext } from 'react'

// Three orthogonal axes decide if a WebContentsView should be visible. Lives in its own
// file (no JSX, no components) so the providers in ./web-visibility.tsx can stay
// fast-refresh friendly (a file may not export both components and non-components).
//
// Defaults are "visible" so a card rendered outside any provider just shows.
export const PaneVisibleContext = createContext<boolean>(true)
export const SessionVisibleContext = createContext<boolean>(true)
export const OverlayActiveContext = createContext<boolean>(false)
