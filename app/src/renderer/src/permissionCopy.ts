import { AudioLines, Bell, CalendarDays, Mic, Users, type LucideIcon } from 'lucide-react'
import type { PermissionKind } from '../../shared/types'
import { osWords } from './keys'
import { t } from '../../shared/i18n'

/**
 * What each permission gives the person: reason is the explanation Settings shows. pane and where
 * say where System Settings keeps it, for the guide. The first run's own words are in screenCopy.
 */
export const permissionCopy = (k: PermissionKind): { icon: LucideIcon; name: string; reason: string; pane: string; where: string } => {
  switch (k) {
    case 'mic': return {
      icon: Mic, name: t('Microphone'), reason: t('Yogurt transcribes your voice.'),
      pane: t('Microphone'), where: t('In Microphone, find Yogurt and turn it on.'),
    }
    case 'systemAudio': return {
      icon: AudioLines, name: t('Call audio'), reason: t('Yogurt transcribes the call audio without joining the call.'),
      pane: t('Screen & System Audio Recording'), where: t('In Screen & System Audio Recording, under System Audio Recording Only, turn on Yogurt.'),
    }
    case 'calendar': return {
      icon: CalendarDays, name: t('Calendar'), reason: t("You can use calendar events to add meeting titles and attendees to your notes."),
      pane: t('Calendars'), where: t('In Calendars, find Yogurt and turn it on.'),
    }
    case 'notifications': return {
      icon: Bell, name: t('Notifications'), reason: t('You can get a reminder when Yogurt detects a call.'),
      pane: t('Notifications'), where: t('In Notifications, click Yogurt, then turn on Allow notifications.'),
    }
    case 'accessibility': return {
      icon: Users, name: t('Names from your calls'), reason: osWords({
        mac: t('With Accessibility access, Yogurt reads speaker names from supported call windows and adds them to the transcript.'),
        other: t('Yogurt reads speaker names from supported call windows and adds them to the transcript.'),
      }),
      pane: t('Accessibility'), where: t('In Accessibility, find Yogurt and turn it on.'),
    }
  }
}

/** Always-visible explanations for Finish setup; Settings keeps the fuller explanations. */
export function finishSetupReason(k: PermissionKind): string {
  switch (k) {
    case 'mic': return t('Captures your voice.')
    case 'systemAudio': return t('Captures the other speakers.')
    case 'notifications': return t('Asks you to record when a call starts.')
    case 'accessibility': return t('Names speakers in your transcript.')
    case 'calendar': return permissionCopy(k).reason
  }
}

/** The first run's screens: a short headline and one sentence on why it matters */
export const screenCopy = (id: 'welcome' | PermissionKind | 'ready'): { title: string; text: string } => {
  switch (id) {
    case 'welcome': return { title: t('Take note.'), text: t('Yogurt records calls without joining them and writes summaries on your computer afterward.') }
    case 'mic': return { title: t('Microphone'), text: t('Allow microphone access to transcribe your voice.') }
    case 'systemAudio': return { title: t('Call audio'), text: t('The permission may mention your screen. Only sound is recorded to transcribe the other speakers.') }
    case 'calendar': return { title: t('Your calendar'), text: t("You can use calendar events to add meeting titles and attendees to your notes.") }
    case 'notifications': return { title: t('Recording reminders'), text: t('You can get a reminder when Yogurt detects a call.') }
    case 'accessibility': return { title: t('See who said what'), text: permissionCopy('accessibility').reason }
    case 'ready': return { title: t('Almost ready'), text: t('Yogurt is setting up transcription on your computer.') }
  }
}
