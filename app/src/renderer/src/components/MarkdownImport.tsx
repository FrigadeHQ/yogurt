import { useRef, useState } from 'react'
import { NOTES_MAX, TITLE_MAX } from '../../../shared/noteLimits'
import { t } from '../../../shared/i18n'
import { localDay, markdownPreview } from '../../../shared/markdownImport'

type Row = { file: File; title: string; date: string; error?: string }

export function MarkdownImport() {
  const picker = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ added: number; skipped: number }>()
  const choose = async (files: File[]) => {
    if (!files.length) return
    setBusy(true)
    setResult(undefined)
    try {
      const next: Row[] = []
      for (const file of files) {
        const row = { file, ...markdownPreview(file.name, '') }
        try {
          const head = await file.slice(0, 8192).text()
          next.push({ file, ...markdownPreview(file.name, head) })
        } catch { next.push({ ...row, error: t("Couldn't save your changes") }) }
      }
      setRows(next)
    } finally { setBusy(false) }
  }
  const update = (file: File, patch: Partial<Pick<Row, 'title' | 'date'>>) =>
    setRows(current => current.map(row => row.file === file ? { ...row, ...patch } : row))

  const save = async () => {
    setBusy(true)
    let added = 0, skipped = 0
    const failed: Row[] = []
    try {
      for (const row of rows) {
        try {
          // Four UTF-8 bytes per character bounds the read even if the file is malformed.
          const markdown = row.file.size <= NOTES_MAX * 4
            ? new TextDecoder('utf-8', { fatal: true }).decode(await row.file.arrayBuffer()) : undefined
          if (markdown === undefined || markdown.length > NOTES_MAX) {
            failed.push({ ...row, error: t('This note is too long to save. Shorten it and try again.') })
            continue
          }
          const imported = await window.yogurt.meetings.importMarkdown({ title: row.title, date: row.date, filename: row.file.name, markdown })
          if (imported) added++
          else skipped++
        } catch {
          failed.push({ ...row, error: t("Couldn't save your changes") })
        }
      }
      setRows(failed)
      setResult({ added, skipped })
    } finally { setBusy(false) }
  }

  return <>
    <h2 className="settings-section-heading">{t('Import notes')}</h2>
    <div data-testid="markdown-import" className="settings-group settings-backup">
      <input type="file" accept=".md" multiple hidden ref={picker} onChange={e => {
        const files = Array.from(e.currentTarget.files ?? [])
        e.currentTarget.value = ''
        void choose(files)
      }} />
      {!rows.length && <button className="ghost-btn" disabled={busy} onClick={() => picker.current?.click()}>{t('Import notes')} (.md)</button>}
      {rows.map((row, i) => <fieldset className="markdown-import-file" key={i} disabled={busy}>
        <legend>{row.file.name}</legend>
        <label>{t('Title')}<input maxLength={TITLE_MAX} required value={row.title} onChange={e => update(row.file, { title: e.target.value })} /></label>
        <label>{t('Date')}<input type="date" required value={row.date} onChange={e => update(row.file, { date: e.target.value })} /></label>
        <button className="ghost-btn" onClick={() => setRows(current => current.filter(r => r.file !== row.file))}>{t('Remove')}</button>
        {row.error && <p role="alert" className="text-danger">{row.error}</p>}
      </fieldset>)}
      {rows.length > 0 && <div className="settings-backup-actions">
        <button className="ghost-btn" disabled={busy || rows.some(r => !r.title.trim() || localDay(r.date) === undefined)} onClick={() => void save()}>
          {busy ? t('Importing…') : t('Import notes')}
        </button>
        <button className="ghost-btn" disabled={busy} onClick={() => { setRows([]); setResult(undefined) }}>{t('Cancel')}</button>
      </div>}
      {result && <p role="status">{t('Added {count} meetings.', { count: result.added })} {result.skipped > 0 && t('{count} were already here.', { count: result.skipped })}</p>}
    </div>
  </>
}
