import type { Access, PermissionKind } from '../../../shared/types'
import { settingsPage } from '../../../shared/platform'
import { t } from '../../../shared/i18n'
import { osWords } from '../keys'
import { permissionCopy } from '../permissionCopy'
import { ExternalLink } from './Icons'

export function PermissionRow({ kind, status, onAsk }: { kind: PermissionKind; status?: Access; onAsk(): void }) {
  const c = permissionCopy(kind)
  const Icon = c.icon
  const ask = status === 'unknown' && kind !== 'accessibility'
  const turnOn = ask || status === 'denied' && kind !== 'accessibility' && kind !== 'notifications'
  const granted = status === 'granted'
  return (
    <li data-testid="permission-row" data-kind={kind} data-status={status ?? ''} className="settings-row">
      <span className="settings-permission-icon"><Icon size={17} aria-hidden="true" /></span>
      <div className="settings-row-copy">
        <p className="settings-permission-label">
          <span className="settings-label">{kind === 'calendar' ? t('Calendar access') : kind === 'mic' ? t('Microphone access') : c.name}</span>
          {status && !(status === 'unknown' && turnOn) && <span data-testid="permission-status" className="settings-permission-status">
            {status === 'granted' ? t('On') : status === 'denied' ? t('Off') : status === 'unknown' ? t('Not set up')
              : status === 'asked' ? t('Check in Settings') : t('Managed by your organization')}
          </span>}
        </p>
        <p className="settings-description">{c.reason}</p>
      </div>
      {status !== 'restricted' && (ask || settingsPage(globalThis.window?.yogurt?.os ?? 'darwin', kind)) ? (
        <button data-testid={ask ? 'permission-ask' : 'permission-open'} onClick={ask ? onAsk : () => void window.yogurt.permissions.open(kind)}
          className={`workspace-button settings-action${granted ? '' : ' primary'}`}>
          <span>{!status || granted ? t('Manage') : turnOn ? t('Turn on') : osWords({ mac: t('Open System Settings'), other: t('Open Settings') })}</span>
          {!ask && <ExternalLink size={13} aria-hidden="true" className="shrink-0 rtl:-scale-x-100" />}
        </button>
      ) : null}
    </li>
  )
}
