export type PreviewSource =
  | { type: 'none' }
  | { type: 'me'; url?: string }
  | { type: 'markdown'; content: string; title?: string; path?: string }
  | { type: 'json'; value: unknown }
  | { type: 'web'; url: string; title?: string }

export type PreviewSourceWire =
  | { type: 'none' }
  | { type: 'me'; url?: string }
  | { type: 'markdown'; content?: string; path?: string; title?: string }
  | { type: 'json'; value: unknown }
  | { type: 'web'; url: string; title?: string }
