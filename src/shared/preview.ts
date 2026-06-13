import type { CliKind } from './cli-spec'

export type FormFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'email'
  | 'cep'
  | 'cpf'
  | 'cnpj'
  | 'phone'
  | 'date'
  | 'select'
  | 'checkbox'

export type FormField = {
  key: string
  label: string
  type?: FormFieldType
  required?: boolean
  placeholder?: string
  default?: string | number | boolean
  options?: { value: string; label: string }[]
  help?: string
}

export type FormSpec = {
  formId: string
  title?: string
  description?: string
  submitLabel?: string
  fields: FormField[]
  status?: 'pending' | 'submitted' | 'cancelled'
}

export type PreviewSource =
  | { type: 'none' }
  | { type: 'me'; url?: string }
  | { type: 'markdown'; content: string; title?: string; path?: string }
  | { type: 'json'; value: unknown }
  | { type: 'web'; url: string; title?: string; favicon?: string | null }
  | { type: 'html'; path: string; title?: string; favicon?: string | null }
  | { type: 'diff'; content: string; title?: string; path?: string }
  | { type: 'editor'; content: string; path: string; title?: string }
  | { type: 'xlsx'; path: string; title?: string }
  | { type: 'form'; spec: FormSpec }

export type PreviewSourceWire =
  | { type: 'none' }
  | { type: 'me'; url?: string }
  | { type: 'markdown'; content?: string; path?: string; title?: string }
  | { type: 'json'; value: unknown }
  | { type: 'web'; url: string; title?: string; favicon?: string | null }
  | { type: 'html'; path: string; title?: string }
  | { type: 'diff'; content?: string; path?: string; title?: string }
  | { type: 'editor'; path: string; title?: string }
  | { type: 'xlsx'; path: string; title?: string }
  | { type: 'form'; spec: FormSpec }

// "Save for later" snapshot of a closed session — the session object is preserved
// whole so revive can spawn the same pty (claudeSessionId → claude resumes the
// transcript) and the cards rehydrate via the existing pinned/previews pipeline.
export type StashSessionMeta = {
  id: string
  label: string
  project?: string
  cwd: string
  kind: 'claude' | 'shell'
  cliKind?: CliKind
  claudeSessionId?: string
}

export type StashEntry = {
  id: string
  savedAt: number
  title: string
  session: StashSessionMeta
  focusedCardId?: string
  cards: Array<{ cardId: string; source: PreviewSourceWire }>
}
