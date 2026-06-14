import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormField, FormSpec } from '@decky/shared'
import { t } from '../lib/i18n'

interface FormPreviewProps {
  spec: FormSpec
}

const BASE = 'http://127.0.0.1:6790'

type Values = Record<string, string | boolean>

function applyMask(type: FormField['type'], raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (type === 'cep') {
    return digits
      .slice(0, 8)
      .replace(/^(\d{5})(\d{1,3}).*/, '$1-$2')
      .replace(/^(\d{5})$/, '$1')
  }
  if (type === 'cpf') {
    const d = digits.slice(0, 11)
    return d
      .replace(/^(\d{3})(\d)/, '$1.$2')
      .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2')
  }
  if (type === 'cnpj') {
    const d = digits.slice(0, 14)
    return d
      .replace(/^(\d{2})(\d)/, '$1.$2')
      .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d)/, '.$1/$2')
      .replace(/(\d{4})(\d{1,2})$/, '$1-$2')
  }
  if (type === 'phone') {
    const d = digits.slice(0, 11)
    if (d.length <= 10) {
      return d.replace(/^(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d{1,4})$/, '$1-$2')
    }
    return d.replace(/^(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d{1,4})$/, '$1-$2')
  }
  return raw
}

function validate(field: FormField, value: string | boolean): string | null {
  const isEmpty =
    (typeof value === 'string' && value.trim().length === 0) ||
    (typeof value === 'boolean' && !value && field.required)
  if (field.required && isEmpty) return 'obrigatório'
  if (typeof value !== 'string' || value.length === 0) return null
  if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'email inválido'
  if (field.type === 'cep' && value.replace(/\D/g, '').length !== 8) return 'CEP deve ter 8 dígitos'
  if (field.type === 'cpf' && value.replace(/\D/g, '').length !== 11)
    return 'CPF deve ter 11 dígitos'
  if (field.type === 'cnpj' && value.replace(/\D/g, '').length !== 14)
    return 'CNPJ deve ter 14 dígitos'
  if (field.type === 'number' && !/^-?\d+(\.\d+)?$/.test(value)) return 'precisa ser número'
  return null
}

export default function FormPreview({ spec }: FormPreviewProps): React.JSX.Element {
  const initial = useMemo<Values>(() => {
    const v: Values = {}
    for (const f of spec.fields) {
      if (f.type === 'checkbox') v[f.key] = Boolean(f.default ?? false)
      else v[f.key] = String(f.default ?? '')
    }
    return v
  }, [spec.formId])

  const [values, setValues] = useState<Values>(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<'pending' | 'sending' | 'submitted' | 'cancelled' | 'error'>(
    spec.status === 'submitted'
      ? 'submitted'
      : spec.status === 'cancelled'
        ? 'cancelled'
        : 'pending'
  )
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const firstInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  // Autofocus first writable field.
  useEffect(() => {
    if (status === 'pending') firstInputRef.current?.focus()
  }, [status])

  const setValue = (key: string, val: string | boolean): void => {
    setValues((prev) => ({ ...prev, [key]: val }))
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: '' }))
  }

  const submit = async (): Promise<void> => {
    const nextErrors: Record<string, string> = {}
    for (const f of spec.fields) {
      const err = validate(f, values[f.key] ?? '')
      if (err) nextErrors[f.key] = err
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors)
      return
    }
    setStatus('sending')
    setErrMsg(null)
    try {
      const res = await fetch(`${BASE}/form/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ formId: spec.formId, values })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setStatus('submitted')
    } catch (err) {
      setStatus('error')
      setErrMsg((err as Error).message || t('form.sendFailed'))
    }
  }

  const cancel = async (): Promise<void> => {
    setStatus('sending')
    try {
      await fetch(`${BASE}/form/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ formId: spec.formId })
      })
      setStatus('cancelled')
    } catch {
      setStatus('cancelled')
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void submit()
    }
  }

  const locked = status !== 'pending' && status !== 'error'

  return (
    <div className="form-preview" onKeyDown={onKeyDown}>
      <div className="form-bar">
        <span className="form-title">{spec.title ?? t('form.untitled')}</span>
        <span className="form-status">
          {status === 'submitted' && <span className="form-sent">{t('form.sent')}</span>}
          {status === 'cancelled' && <span className="form-cancelled">{t('form.cancelled')}</span>}
          {status === 'sending' && <span className="form-sending">{t('form.sending')}</span>}
          {status === 'error' && <span className="form-err">{errMsg ?? t('common.error')}</span>}
        </span>
      </div>

      {spec.description && <div className="form-description">{spec.description}</div>}

      <div className="form-body">
        {spec.fields.map((f, idx) => {
          const value = values[f.key]
          const err = errors[f.key]
          const refProp =
            idx === 0
              ? {
                  ref: (el: HTMLInputElement | HTMLTextAreaElement | null) => {
                    firstInputRef.current = el
                  }
                }
              : {}
          const common = {
            id: `f-${spec.formId}-${f.key}`,
            disabled: locked,
            placeholder: f.placeholder,
            className: 'form-input' + (err ? ' has-error' : '')
          }
          return (
            <div key={f.key} className="form-field">
              <label htmlFor={common.id} className="form-label">
                {f.label}
                {f.required && <span className="form-required"> *</span>}
              </label>
              {f.type === 'textarea' ? (
                <textarea
                  {...common}
                  {...(refProp as object)}
                  value={String(value ?? '')}
                  onChange={(e) => setValue(f.key, e.target.value)}
                  rows={4}
                />
              ) : f.type === 'select' ? (
                <select
                  id={common.id}
                  disabled={locked}
                  className={common.className}
                  value={String(value ?? '')}
                  onChange={(e) => setValue(f.key, e.target.value)}
                >
                  <option value="">{t('form.selectPlaceholder')}</option>
                  {(f.options ?? []).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.type === 'checkbox' ? (
                <label className="form-checkbox">
                  <input
                    type="checkbox"
                    id={common.id}
                    disabled={locked}
                    checked={Boolean(value)}
                    onChange={(e) => setValue(f.key, e.target.checked)}
                  />
                  <span>{f.help ?? f.label}</span>
                </label>
              ) : (
                <input
                  {...common}
                  {...(refProp as object)}
                  type={
                    f.type === 'email'
                      ? 'email'
                      : f.type === 'number'
                        ? 'text'
                        : f.type === 'date'
                          ? 'date'
                          : 'text'
                  }
                  inputMode={
                    f.type === 'cep' ||
                    f.type === 'cpf' ||
                    f.type === 'cnpj' ||
                    f.type === 'phone' ||
                    f.type === 'number'
                      ? 'numeric'
                      : undefined
                  }
                  value={String(value ?? '')}
                  onChange={(e) => setValue(f.key, applyMask(f.type, e.target.value))}
                />
              )}
              {f.help && f.type !== 'checkbox' && <div className="form-help">{f.help}</div>}
              {err && <div className="form-error">{err}</div>}
            </div>
          )
        })}
      </div>

      <div className="form-actions">
        <button
          type="button"
          className="form-cancel"
          onClick={() => void cancel()}
          disabled={locked}
        >
          {t('common.cancel')}
        </button>
        <button type="button" className="form-send" onClick={() => void submit()} disabled={locked}>
          {spec.submitLabel ?? 'SEND'}
          <span className="form-kbd">{navigator.platform.includes('Mac') ? '⌘↵' : 'Ctrl+↵'}</span>
        </button>
      </div>
    </div>
  )
}
