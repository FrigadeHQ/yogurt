export const notificationEvents = ['meeting-detected', 'call-ended', 'notes-ready', 'updates'] as const
export type NotificationEvent = typeof notificationEvents[number]
export type Delivery = { system: boolean; sound: boolean }
export type NotificationChoices = Partial<Record<NotificationEvent, Partial<Delivery>>>

export function deliveryFor(choices: NotificationChoices | undefined, event: NotificationEvent): Delivery {
  const choice = choices?.[event]
  return {
    system: typeof choice?.system === 'boolean' ? choice.system : event !== 'notes-ready',
    sound: typeof choice?.sound === 'boolean' ? choice.sound : event === 'updates',
  }
}

export function isNotificationEvent(event: unknown): event is NotificationEvent {
  return notificationEvents.some(id => id === event)
}
