/** Heading over the phone's My notes when both sides changed them while apart; neither text is lost. */
export const FROM_IPHONE = '\n\n## From your iPhone\n\n'

/** What Settings → iPhone shows: the paired phone, an open pairing code, or why pairing closed or can't start */
export type CompanionStatus = {
  paired: null | { name: string; lastSeen: number | null }
  pairing: null | { code: string; expiresAt: number; attemptsLeft: number }
  /** why the last pairing closed without a phone: its two minutes ran out, or too many wrong codes (null otherwise) */
  pairingClosed: null | 'expired' | 'tooMany'
  /**
   * keychain: the system keychain wouldn't open this computer's key (off, the pairing kept, until a start where it opens);
   * listen: the server couldn't start listening, so pairing closed (the next start tries again);
   * network: the local network refused the advert (macOS Local Network permission, a firewall), so the phone can't find it
   */
  error: null | 'keychain' | 'listen' | 'network'
  connected: boolean
  syncing: boolean
}

export const phoneCompanionOn = (env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): boolean =>
  platform === 'darwin' || env.YOGURT_PHONE === '1'
