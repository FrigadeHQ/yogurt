/**
 * What a call app's window says about who is in the call and who is talking, read from its accessibility tree
 * (yogurt-mac call-watch copies it out on a Mac, yogurt-system on Linux; this reads either). Every rule fails towards
 * reading nothing, so a changed app means Them, never a wrong name. The signals each app gives, and how sure we are of
 * them, are in the comments.
 */

/** one element of the tree as the helper copies it: role, subrole, description, title, value, identifier, DOM classes, size */
export type AxNode = { r: string; s?: string; d?: string; t?: string; v?: string; i?: string; c?: string[]; w?: number; h?: number; k?: AxNode[] }
export type AxWindow = { title?: string; id?: string; tree: AxNode; minimized?: boolean }
export type CallKind = 'zoom' | 'teams' | 'meet' | 'webex'
/** byMute: `speaking` is only the one other person not muted (Teams meetings mark nobody), not a mark of the app */
export type CallReading = { speaking: string[]; participants: string[]; me: string | null; byMute?: boolean }

// A role has two names: macOS Accessibility says AXTabGroup, AXStaticText, AXRow, AXOutline; AT-SPI (Linux) says
// page tab, label/static/text, table row/list item, tree table/table/list. The rules below know both. Windows's helper
// gives UI Automation's control types the AT-SPI names (yogurt-system parse.rs uia_role), so it reads as Linux does.
const TAB_GROUP = new Set(['AXTabGroup', 'page tab'])
const STATIC_TEXT = new Set(['AXStaticText', 'static', 'label', 'text', 'paragraph', 'heading', 'caption'])
const ROW = new Set(['AXRow', 'table row', 'list item', 'row'])
const OUTLINE = new Set(['AXOutline', 'tree table', 'table', 'list', 'list box', 'outline', 'tree'])

const uniq = (xs: string[]) => [...new Map(xs.map((x) => [x.toLocaleLowerCase(), x])).values()]
const walk = (n: AxNode, fn: (n: AxNode, up: AxNode[]) => void, up: AxNode[] = []) => {
  fn(n, up)
  for (const k of n.k ?? []) walk(k, fn, [...up, n])
}
const texts = (n: AxNode) => [n.d, n.t, n.v].filter((x): x is string => !!x)

// ---- Zoom (desktop app, us.zoom.xos) ----
// From Zoom's own strings (Zoom 7.2, its Localizable.strings) and its accessibility tree (Zoom 7.1):
// each video tile is an AXTabGroup described "Name, Computer audio unmuted, Video off", with ", Active speaker"
// at the end on the person talking (Zoom marks someone only with three or more in the call). The participants panel,
// when open, is an AXOutline "Participants list" with rows "Name (me)", "Name (Host)". The small floating window says
// "Talking: Name".

/** Zoom's words, by language: audio on, audio off, the active-speaker mark, the talking label, the participants list, "(me)" */
const ZOOM = [
  ['Computer audio unmuted', 'Computer audio muted', 'Active speaker', 'Talking:', 'Participants list', '(me)'],
  ['Bei Computeraudio Stummschaltung deaktiviert', 'Bei Computeraudio Stummschaltung aktiviert', 'Aktiver Sprecher', 'Sprechen:', 'Teilnehmerliste', '(ich)'],
  ['Audio de la computadora no silenciado', 'Audio de la computadora silenciado', 'Orador activo', 'Hablando:', 'Lista de participantes', '(yo)'],
  ["Son de l'ordinateur rétabli", 'Ordinateur mis en sourdine', 'Intervenant actif', 'La parole est à :', 'Liste des participants', '(moi)'],
  ['Audio computer attivato', 'Audio computer disattivato', 'Oratore attivo', 'Conversazione in corso:', 'Elenco dei partecipanti', '(io)'],
  ['Áudio do computador ativado', 'Áudio do computador desativado', 'Orador ativo', 'Falando:', 'Lista de participantes', '(eu)'],
  ['Computeraudio ingeschakeld', 'Computeraudio gedempt', 'Actieve spreker', 'Aan het spreken:', 'Deelnemerslijst', '(ik)'],
  ['Datorljudet aktiverades', 'Datorljudet inaktiverades', 'Aktiv talare', 'Talar:', 'Deltagarlista', '(jag)'],
  ['ミュート解除されたコンピュータ オーディオ', 'ミュートされたコンピュータ オーディオ', 'アクティブ スピーカー', '発言中:', '参加者リスト', '（自分）'],
  ['电脑音频开启', '电脑音频静音', '当前演讲者', '正在发言：', '参会者列表', '（我）'],
] as const
const low = (s: string) => s.normalize('NFKC').toLocaleLowerCase().trim()
const AUDIO = new Set(ZOOM.flatMap((l) => [low(l[0]), low(l[1])]))
const ACTIVE = new Set(ZOOM.map((l) => low(l[2])))
const TALKING = ZOOM.map((l) => l[3].normalize('NFKC').replace(/\s*[:：]$/, ''))
const LISTS = new Set(ZOOM.map((l) => low(l[4])))
const SELF = new Set(ZOOM.map((l) => low(l[5]).replace(/[()]/g, '')))
/** other things Zoom appends to a tile, which say nothing about who it is; kept as Zoom's own words for the log */
const OTHER_STATUS = /^(video (on|off)|no audio.*|telephone.*|screen sharing.*|pinned|spotlighted)$/i
/**
 * The audio states Zoom writes where the language table has none: a person who never joined audio ("No audio
 * connected", 170 of 1744 tiles read on a real call, the rest computer audio muted or unmuted) and a dial-in. They
 * say the words are a tile as surely as the muted and unmuted words do, so that person is read instead of dropped.
 * English only as measured, like the Linux tile; another language falls back to the table above.
 */
const AUDIO_ELSE = /^(no audio.*|telephone.*)$/i
/** Zoom's own tags after a name, alone or together ("(Host, me)"): never part of it */
const TAG = 'me|host|co-host|guest|interpreter|participant id: [^),]*|ich|yo|moi|io|eu|ik|jag|自分|我'
const ZOOM_TAGS = new RegExp(`\\s*[(（]\\s*(?:${TAG})(?:\\s*[,，、]\\s*(?:${TAG}))*\\s*[)）]\\s*$`, 'i')
/** "Ana Ruiz (Host, me)" → host, me */
const tagsOf = (raw: string): string[] => {
  const out: string[] = []
  let name = raw.normalize('NFKC').trim(), m: RegExpMatchArray | null
  while ((m = name.match(ZOOM_TAGS))) { out.push(...m[0].replace(/^\s*\(|\)\s*$/g, '').split(/[,、]/).map(low)); name = name.slice(0, m.index) }
  return out
}

const cleanZoom = (raw: string): string | null => {
  let name = raw.normalize('NFKC').trim()
  while (ZOOM_TAGS.test(name)) name = name.replace(ZOOM_TAGS, '')
  return name && !/^participants \(/i.test(name) ? name : null
}

/** "Ana Ruiz, Computer audio unmuted, Video off, Active speaker" → Ana Ruiz, talking; null when it isn't a tile */
export function zoomTile(description: string): { name: string; talking: boolean } | null {
  const fields = description.normalize('NFKC').split(/,\s*|、/)
  // Zoom writes the audio state straight after the name and the rest of the status after that, so the name is what
  // comes before that word and everything from it on is status, whatever it says. Keeping only the status words it
  // knew, popped from the end, lost the whole person as soon as Zoom appended a new one: the tile "<name>, Computer
  // audio unmuted, Video on, Reaction: Raise hand" (Zoom 7.2.5) stopped at the reaction and never reached the audio
  // state, so a real call of six read as five — and the person missing was the one with their hand up.
  const state = fields.findIndex((f, i) => i > 0 && (AUDIO.has(low(f)) || AUDIO_ELSE.test(low(f)) || ACTIVE.has(low(f))))
  if (state < 1) return null
  const talking = fields.slice(state).some((f) => ACTIVE.has(low(f)))
  const name = cleanZoom(fields.slice(0, state).join(', '))
  return name ? { name, talking } : null
}

// Linux's Zoom Workplace draws each video tile as a push button named "video item <name>", with " Active Speaker"
// appended on the active-speaker view (Zoom 7.2.1: the only tile carries it even in a call of one). The words are
// English only as measured; another language reads as nothing rather than a wrong name.
const LINUX_TILE = /^video item\s+(.+)$/i
const LINUX_ACTIVE = /\s+active speaker$/i

/** "video item Ana Ruiz Active Speaker" → Ana Ruiz, talking; null when it isn't a tile */
export function zoomLinuxTile(name: string): { name: string; talking: boolean } | null {
  const m = LINUX_TILE.exec(name.normalize('NFKC').trim())
  if (!m) return null
  const talking = LINUX_ACTIVE.test(m[1])
  const person = cleanZoom(m[1].replace(LINUX_ACTIVE, ''))
  return person && person.length <= 60 ? { name: person, talking } : null
}

function readZoom(windows: AxWindow[]): CallReading {
  const speaking: string[] = [], participants: string[] = []
  const linuxTiles: Array<{ name: string; talking: boolean }> = []
  let me: string | null = null
  for (const w of windows) {
    walk(w.tree, (n, up) => {
      // the words are the description on a Mac and Linux, the name under UI Automation (Windows)
      const tileWords = n.d ?? n.t
      if (TAB_GROUP.has(n.r) && tileWords) {
        const tile = zoomTile(tileWords)
        if (tile) { participants.push(tile.name); if (tile.talking) speaking.push(tile.name) }
      }
      // the Linux Zoom Workplace tile is a push button named "video item <name> [Active Speaker]"
      if (n.r === 'push button' || n.r === 'toggle button') {
        for (const raw of [n.t, n.d]) {
          const tile = raw ? zoomLinuxTile(raw) : null
          if (tile) { participants.push(tile.name); linuxTiles.push(tile) }
        }
      }
      // the floating window's "Talking: Name"; AT-SPI labels carry it as their name
      if (STATIC_TEXT.has(n.r)) {
        for (const raw of [n.v, n.t]) {
          if (!raw) continue
          const v = raw.normalize('NFKC')
          for (const key of TALKING) if (v.startsWith(key)) { const name = cleanZoom(v.slice(key.length).replace(/^\s*[:：]\s*/, '')); if (name) speaking.push(name) }
        }
      }
      // a row of the participants list: its first text is the name, "(me)" on the person using Yogurt
      if (ROW.has(n.r) && up.some((a) => OUTLINE.has(a.r) && LISTS.has(low(a.d ?? a.t ?? '')))) {
        let text: string | undefined
        walk(n, (x) => { if (!text && STATIC_TEXT.has(x.r)) text = x.v ?? x.t })
        if (!text) return
        const name = cleanZoom(text)
        if (!name) return
        participants.push(name)
        if (tagsOf(text).some((tag) => SELF.has(tag))) me = name
      }
    })
  }
  // The Linux view always says "Active Speaker" on the tile it is showing, even with one person in the call, so the
  // mark is trusted only with three or more tiles (the same threshold the Mac mark has).
  if (uniq(linuxTiles.map((t) => t.name)).length >= 3) for (const t of linuxTiles) if (t.talking) speaking.push(t.name)
  return { speaking: uniq(speaking), participants: uniq(participants), me }
}

// ---- Google Meet (in Chrome, Arc, Brave, Edge; Safari and Firefox too where they show the same tree) ----
// Meet marks nobody as talking in words. Each tile shows the person's name as text, and the talking tile gets a CSS
// class, which the browser's tree carries (AXDOMClassList). That class is a build name Google changes between
// releases: as of October 2026 it is "v5h6Xc" (it sits on exactly
// one tile and moves to whoever talks). When it is gone, nobody is marked, and only a call of two can be named.
// A tile is the element seven levels above a name's text, holding just that one name (as measured on Meet's tree).

export const MEET_TALKING_CLASSES = ['v5h6Xc']
const TILE_UP = 7
/** text in Meet's window that is never a person: times, the meeting code, chat */
const NOT_A_NAME = /^\d{1,2}[:.]\d{2}(\s?[AP]M)?$|^[a-z]{3}-[a-z]{4}-[a-z]{3}$|says in chat|^(AM|PM)$|^\d+$/i

/** Meet's own words that stand alone like a name */
const MEET_WORDS = new Set(['meet', 'reframe', 'captions', 'chat', 'people', 'activities', 'host controls', 'present', 'raise hand', 'reactions', 'recaptcha', 'upgrade'])
/** the chat panel: its messages stand alone like names (a one-word message, "lightsage", was taken for a person) */
const MEET_CHAT = /\b(chat|messages?)\b/i
/** the window and the page carry the meeting's name ("Weekly chat"): only what's inside them is checked for the chat panel */
const MEET_PAGE = new Set(['AXWindow', 'AXWebArea', 'frame', 'document web', 'window'])
/** lowercase words that sit inside real names: Ana María de la Cruz, Ludwig van Beethoven */
const PARTICLES = new Set(['de', 'del', 'della', 'der', 'den', 'di', 'da', 'das', 'do', 'dos', 'du', 'la', 'le', 'van', 'von', 'ter', 'ten', 'y', 'e', 'bin', 'binti', 'al', 'el', 'ibn', 'zu'])

/**
 * A tile's name, or null for anything else Meet writes in a box of its own (#71): sentences from toasts and the lobby
 * ("Your camera is on.", "Reducing noise"), times and dates, a shared tab's title ("Plan - Google Docs") and control
 * labels. A name has no digits, no sentence ending, at most five words, and in a name of several words every word
 * starts with a capital letter (or is a particle like "de", or comes from a script without capitals). Getting a person
 * wrong means Them for their lines, never another name.
 */
function meetName(text: string): string | null {
  const name = text.normalize('NFKC').replace(/\s*\((presenting|presentation|you)[^)]*\)\s*$/i, '').trim()
  if (name.length < 2 || name.length > 60 || !/\p{L}/u.test(name) || NOT_A_NAME.test(name)) return null
  if (/\d|[?!…:/⌘]|\.\.|\s[-–—|]\s/.test(name) || MEET_WORDS.has(low(name))) return null
  const words = name.split(/\s+/)
  // "Jr." and initials end with a period; a sentence does
  if (/\.$/.test(name) && words.at(-1)!.replace(/\.$/, '').length > 2) return null
  if (words.length > 5) return null
  if (words.length > 1 && words.some((w) => /^\p{Ll}/u.test(w) && !PARTICLES.has(w))) return null
  return name
}

/** a toast, banner or other live area: Meet's messages, never a tile (a role on Linux and Windows, a subrole on a Mac) */
const LIVE = new Set(['alert', 'notification', 'status bar', 'status', 'log', 'marquee', 'timer', 'AXApplicationAlert', 'AXApplicationStatus', 'AXApplicationLog', 'AXApplicationTimer', 'AXApplicationMarquee'])
const isLive = (n: AxNode) => LIVE.has(n.r) || (!!n.s && LIVE.has(n.s))

function readMeet(windows: AxWindow[], o: { talkingClasses?: string[] }): CallReading {
  const marks = new Set(o.talkingClasses ?? MEET_TALKING_CLASSES)
  const groups = new Map<AxNode, string[]>()
  /** names Meet wrote with "(You)" after them: the person's own tile or People row (#112) */
  const mine = new Set<string>()
  for (const w of windows) {
    if (w.title && !/\bMeet\b/.test(w.title)) continue
    const skip = new Set((w.title ?? '').split(/\s+[-–—]\s+/).map(low))
    walk(w.tree, (n, up) => {
      if (!STATIC_TEXT.has(n.r) || up.length < TILE_UP || up.some(isLive) || up.some((a) => !MEET_PAGE.has(a.r) && MEET_CHAT.test(a.d ?? a.t ?? ''))) return
      const text = n.v ?? n.t
      if (!text) return
      const name = meetName(text)
      if (!name || skip.has(low(name))) return
      if (/\(you\)\s*$/i.test(text)) mine.add(low(name))
      const root = up[up.length - TILE_UP]
      groups.set(root, [...(groups.get(root) ?? []), name])
    })
  }
  const speaking: string[] = [], participants: string[] = []
  let me: string | null = null
  for (const [root, names] of groups) {
    const one = uniq(names)
    if (one.length !== 1) continue
    participants.push(one[0])
    // Meet labels the person's own tile "You", or their name with "(You)" after it
    if (low(one[0]) === 'you' || mine.has(low(one[0]))) me = one[0]
    let talking = false
    walk(root, (x) => { if (x.c?.some((c) => marks.has(c))) talking = true })
    if (talking) speaking.push(one[0])
  }
  return { speaking: uniq(speaking), participants: uniq(participants), me }
}

// ---- Microsoft Teams (new Teams, com.microsoft.teams2, and classic) ----
// Measured on Teams for Linux 2.28.0 (AT-SPI, Plasma Wayland): the People panel's "Attendees" tree has rows
// "Name, Role, Muted|Unmuted" ("Dana Smith, Organizer, Unmuted"), and the row's section repeats it. Teams marks the
// active speaker only with a ring: no word and no class in the tree. What is read is words only: those roster rows
// (inside a tree or table named Participants/Attendees/People, so a chat or calendar line that happens to read like
// one is never a person), an element labelled "Name, speaking" / "Name is speaking" / "Active speaker: Name" (other
// builds), and "(You)" after the person's own name. When the roster is closed and nobody is marked, only a call of two
// can be named (attribute.ts).

// Teams' words by language: English, then German (#83). The German ones are Teams' usual wording, not yet seen in a
// real tree; a word that's off reads as nothing, never as a wrong name. Video tiles need no words at all (teamsTile).
const TEAMS_SPEAKING = [
  /^(.{2,60}?)(?:,\s*|\s+is\s+)(?:speaking|talking)\b/i, /\b(?:active speaker|now speaking|speaking now)[:,]?\s+(.{2,60})$/i,
  /^(.{2,60}?),\s*spricht(?:\s+gerade)?(?:,|$)/i, /\b(?:aktive[rs]? sprecher(?:in)?|spricht gerade)[:,]?\s+(.{2,60})$/i,
]
/** the state Teams puts after a person in the roster; the role ("Organizer", "Presenter", ...) may sit between */
const TEAMS_STATUS = /^(?:muted|unmuted|mic(?:rophone)? (?:on|off)|video (?:is )?(?:on|off)|camera (?:is )?(?:on|off)|stummgeschaltet|nicht stummgeschaltet|stummschaltung aufgehoben|mikrofon (?:ist )?(?:an|aus|ein)|(?:kamera|video) (?:ist )?(?:an|aus|ein))$/i
/** the roles Teams puts between the name and the state */
const TEAMS_ROLE = /^(?:organizer|presenter|guest|external|co-?organizer|attendee|host|co-?host|interpreter|(?:mit)?organisator(?:in)?|referent(?:in)?|gast|extern|teilnehmer(?:in)?|moderator(?:in)?|dolmetscher(?:in)?)$/i
const TEAMS_SAYS = /^(?:speaking|talking|active speaker|now speaking|spricht(?: gerade)?)$/i
/** "(You)" after the person's own name: Sie and Du in German */
const SELF_TAG = 'you|me|sie|du|ich'
/** my own tile's label when it holds only that: "(You)" */
const SELF_LABEL = new RegExp(`^\\((?:${SELF_TAG})\\)$`, 'i')
const TEAMS_ME = new RegExp(`^(.{2,60}?)\\s*\\((?:${SELF_TAG})\\)`, 'i')
const cleanTeams = (s: string) => s.replace(new RegExp(`\\s*\\((?:organizer|presenter|guest|external|organisator(?:in)?|referent(?:in)?|gast|extern|${SELF_TAG})\\)`, 'gi'), '').replace(/[,.:;]+$/, '').trim()

/** the roles a roster row has: the People panel's tree, or a table/list in another build */
const TEAMS_ROW = new Set(['tree item', 'table row', 'list item', 'row', 'AXRow'])
/** a list that can hold the roster; its name says whether it does */
const TEAMS_LIST = new Set(['tree', 'tree table', 'table', 'list', 'list box', 'outline', 'AXOutline', 'AXTable'])
const TEAMS_LIST_NAME = /^(?:meeting )?(?:participants|attendees|people|in (?:this|the) meeting|teilnehm(?:er|ende)|personen|in dieser besprechung)(?![\p{L}])/iu

/** whether an element sits in the People panel: a row, inside a list named Participants/Attendees/People */
function inTeamsRoster(n: AxNode, up: AxNode[]): boolean {
  if (!TEAMS_ROW.has(n.r) && !up.some((a) => TEAMS_ROW.has(a.r))) return false
  return up.some((a) => TEAMS_LIST.has(a.r) && TEAMS_LIST_NAME.test((a.d ?? a.t ?? '').trim()))
}

/** "Dana Smith, Organizer, Unmuted" → Dana Smith; "Smith, Dana, Organizer, Unmuted" → Smith, Dana */
function teamsPersona(label: string): { name: string; speaking: boolean } | null {
  const fields = label.normalize('NFKC').split(/\s*,\s*/)
  const state = fields.findIndex((f) => TEAMS_STATUS.test(f))
  if (state < 1) return null
  const before = fields.slice(0, state)
  while (before.length > 1 && TEAMS_ROLE.test(before.at(-1)!)) before.pop()
  const name = cleanTeams(before.join(', '))
  if (name.length < 2 || name.length > 60) return null
  return { name, speaking: fields.some((f) => TEAMS_SAYS.test(f)) }
}

// The call window's video tiles (new Teams on Windows, #83: a German call): each tile is a menu item whose label starts
// with the person's name, then Teams' words ("Name, Video ist aus, Kontextmenü ist verfügbar"), and it holds a label
// with just the name. That shape is the same in every language, so the name comes from it and not from words. A menu
// that opens (settings, a person's card) is drawn in Fluent's layer host and never read. In a 1:1 call (0.3.68) the tile's
// text is the name alone; such a tile counts only in the call window (it has the hang-up button) and outside toolbars,
// where a menu item that is just its label is a command.
const TEAMS_TILE = new Set(['menu item', 'AXMenuItem'])
/** Teams' talking mark (#83, found by a reporter in an 8-person English meeting on Windows): while someone talks, the
 * last child of their tile carries this class, and it moves with the purple speaker ring (34 of 35 readings). When they
 * stop it has other classes; a muted tile has no such child. The Mac's tree carries the page's classes too. */
export const TEAMS_TALKING_CLASS = 'vdi-frame-occlusion'
const talkingMark = (tile: AxNode) => !!tile.k?.at(-1)?.c?.includes(TEAMS_TALKING_CLASS)
const TEAMS_POPUPS = 'fluent-default-layer-host'
const TEAMS_BARS = new Set(['tool bar', 'menu bar', 'title bar', 'AXToolbar', 'AXMenuBar'])
/** only a 1:1 call has hold and transfer (a meeting or group call has neither), so it has exactly one other person */
const TEAMS_ONE_TO_ONE = new Set(['hold-button', 'transfer-button', 'consultative-transfer-button'])
/** "Anna Becker | Microsoft Teams": a 1:1 call's window is titled with the other person's name */
const TEAMS_TITLE = /^([^|]+?)\s*\|\s*Microsoft Teams(?:\s+[-–—].*)?$/
const titleName = (title: string | undefined): string | null => {
  const m = TEAMS_TITLE.exec((title ?? '').normalize('NFKC').trim())
  const name = m ? cleanTeams(m[1]) : ''
  return name.length >= 2 && name.length <= 60 && /\p{L}/u.test(name) && !/[\d+:/@]/.test(name) && name.split(/\s+/).length <= 5 ? name : null
}

/** the mute word a meeting tile carries (#83: "Name, <meeting title>, stummgeschaltet, Kontextmenü ist verfügbar") */
const TEAMS_MUTED = /^(?:muted|stummgeschaltet|mic(?:rophone)? (?:is )?off|mikrofon (?:ist )?aus)$/i
const TEAMS_UNMUTED = /^(?:unmuted|stummschaltung aufgehoben|nicht stummgeschaltet|mic(?:rophone)? (?:is )?on|mikrofon (?:ist )?(?:an|ein))$/i
/** the last words of every tile: a tile with no label inside (English Teams on Windows, 0.3.69) is "Name, ..., <this>" */
const TEAMS_HINT = /^(?:context menu is available|has context menu|kontextmenü ist verfügbar)$/i
/** my own tile on a Mac starts with these words: "Myself video, Name, ..., Unmuted, Has context menu" (#138) */
const TEAMS_MYSELF = /^myself video,\s*/i
/** my own tile's label adds a short word after the name: "Christa, Ich" */
const OWN_LABEL = /^(.+?),\s*(\p{L}{1,5})$/u

/** a video tile's person, or null when the menu item isn't one. muted: null when the tile says nothing either way */
function teamsTile(n: AxNode, alone: boolean): { name: string; speaking: boolean; me: boolean; muted: boolean | null } | null {
  const full = (n.t ?? n.d ?? '').normalize('NFKC').trim()
  const myself = TEAMS_MYSELF.test(full)
  const label = full.replace(TEAMS_MYSELF, '')
  const inner: string[] = [], heads: string[] = []
  walk(n, (x) => {
    if (x === n) return
    const said = texts(x).map((t) => t.normalize('NFKC').trim())
    inner.push(...said)
    if (STATIC_TEXT.has(x.r)) heads.push(...said)
  })
  for (const raw of heads) {
    // my own tile: its label is "Name, Ich" and the tile reads "Name, ..."
    const own = OWN_LABEL.exec(raw)
    const head = own && !label.startsWith(raw) && label.startsWith(`${own[1]},`) ? own[1] : raw
    if (!head || !label.startsWith(head) || (head === label && !alone)) continue
    // what Teams puts after a name in brackets ("Jonas Weber (Contoso GmbH), ...") is not part of the label
    let rest = label.slice(head.length)
    rest = rest.replace(/^\s*\([^()]*\)(?=\s*,)/, '')
    // the rest is Teams' words after a comma, or another text of the tile run together with the name, or nothing
    if (rest && !/^\s*,/.test(rest) && !inner.includes(rest.trim())) continue
    const name = cleanTeams(head)
    if (name.length < 2 || name.length > 60 || !/\p{L}/u.test(name) || /[+\d]/.test(name)) continue
    const fields = rest.split(/\s*,\s*/).filter(Boolean)
    return { name, speaking: fields.some((f) => TEAMS_SAYS.test(f)), me: myself || head !== raw || TEAMS_ME.test(head), muted: fields.length ? fields.some((f) => TEAMS_MUTED.test(f)) : null }
  }
  // no label with the name inside (none, or "(You)" on my own tile, #83 18:30): the name is the first of the tile's words
  // when they end with Teams' context-menu hint. A label that starts the words but runs on is no name.
  const fields = label.split(/\s*,\s*/)
  if (heads.some((h) => h && label.startsWith(h)) || fields.length < 3 || !TEAMS_HINT.test(fields.at(-1)!)) return null
  const name = cleanTeams(fields[0])
  if (name.length < 2 || name.length > 60 || !/\p{L}/u.test(name) || /[+\d]/.test(name)) return null
  const rest = fields.slice(1)
  const mine = myself || TEAMS_ME.test(fields[0]) || heads.some((h) => SELF_LABEL.test(h))
  return { name, speaking: rest.some((f) => TEAMS_SAYS.test(f)), me: mine, muted: rest.some((f) => TEAMS_MUTED.test(f)) }
}

/** what a tile's video image says about mute, by the names among its words: "..., Unmuted, video is on, ..., Dana Smith" */
function imageMutes(n: AxNode, into: Map<string, boolean>) {
  const fields = (n.t ?? n.d ?? '').normalize('NFKC').split(/\s*,\s*/).filter(Boolean)
  const muted = fields.some((f) => TEAMS_MUTED.test(f)), unmuted = fields.some((f) => TEAMS_UNMUTED.test(f))
  if (muted === unmuted) return
  for (const f of fields) into.set(low(f), muted)
}

function readTeams(windows: AxWindow[]): CallReading {
  const speaking: string[] = [], participants: string[] = []
  let me: string | null = null, byMute = false
  for (const w of windows) {
    let call = false, oneToOne = false, unread = false
    const states: Array<{ name: string; muted: boolean | null; me: boolean }> = []
    const mutes = new Map<string, boolean>()
    walk(w.tree, (n) => { if (n.i === 'hangup-button') call = true; if (n.i && TEAMS_ONE_TO_ONE.has(n.i)) oneToOne = true })
    const tiles: string[] = []
    walk(w.tree, (n, up) => {
      if (n.i === TEAMS_POPUPS || up.some((a) => a.i === TEAMS_POPUPS)) return
      const inStage = call && !up.some((a) => TEAMS_BARS.has(a.r))
      if (inStage && (n.r === 'image' || n.r === 'AXImage')) imageMutes(n, mutes)
      const tile = TEAMS_TILE.has(n.r) ? teamsTile(n, inStage) : null
      if (tile && talkingMark(n)) tile.speaking = true
      if (tile) { participants.push(tile.name); tiles.push(tile.name); states.push(tile); if (tile.speaking) speaking.push(tile.name); if (tile.me) me = tile.name }
      // a tile-shaped menu item ("..., ..., ...") whose person couldn't be read: who is muted can't be told
      else if (inStage && TEAMS_TILE.has(n.r) && (n.t ?? '').split(',').length >= 3) unread = true
      const roster = inTeamsRoster(n, up)
      for (const label of texts(n)) {
        for (const re of TEAMS_SPEAKING) { const m = re.exec(label); if (m) { const name = cleanTeams(m[1]); if (name.length >= 2 && !/^(you|me|sie|du|ich)\b/i.test(name)) speaking.push(name) } }
        const persona = roster ? teamsPersona(label) : null
        if (persona) { participants.push(persona.name); if (persona.speaking) speaking.push(persona.name) }
        const mine = roster ? TEAMS_ME.exec(label) : null
        if (mine) { me = cleanTeams(mine[1]); participants.push(me) }
      }
    })
    // A 1:1 call has one other person, so the call's sound is theirs, marked or not. The title says who; a tile alone
    // does when the title can't. A tile and a title that disagree name nobody.
    if (call && oneToOne && !speaking.length) {
      const others = uniq(tiles).filter((t) => !me || low(t) !== low(me))
      const titled = titleName(w.title)
      const other = titled ? (!others.length || others.some((t) => low(t) === low(titled)) ? titled : null) : others.length === 1 ? others[0] : null
      if (other) { speaking.push(other); participants.push(other) }
    }
    // A meeting marks nobody as talking, only who is muted (#83). A muted person can't be heard, so with exactly one other
    // person not muted, and at least one other muted, the sound is theirs. My own tile never counts; two or more not
    // muted, a tile that couldn't be read, or a tile that says nothing either way name nobody.
    if (call && !oneToOne && !speaking.length && !unread) {
      // the video image's word wins over a tile that says nothing
      for (const t of states) { const m = mutes.get(low(t.name)); if (m !== undefined) t.muted = m }
      const others = states.filter((t) => !t.me && (!me || low(t.name) !== low(me)))
      const open = others.filter((t) => t.muted === false)
      if (others.length >= 2 && others.every((t) => t.muted !== null) && open.length === 1) { speaking.push(open[0].name); byMute = true }
    }
  }
  return { speaking: uniq(speaking), participants: uniq(participants.filter((p) => p.length >= 2)), me, ...(byMute ? { byMute } : {}) }
}

// ---- Webex desktop app ----
// The meeting's Participants outline contains participant rows. Older Webex builds expose AXCell rows backed by
// GenericParticipantListCellView; current builds expose AXRow descriptions. Each describes a name and, when present,
// "speaking" / "me". With that panel closed, the floating video tile still marks its person as speaking in a fixed
// English shape; it is safe to use only that explicit mark.
const WEBEX_SPEAKING_TILE = /^(.+?),\s*,\s*,\s*speaking,\s*Video (?:on|off),?$/i
const WEBEX_ROSTER = /^participants(?:\s|$)/i
const WEBEX_PERSON_MARK = /^(?:host|presenter|me|muted|unmuted|speaking|using phone|unverified)$/i
const webexRowName = (description: string): string | undefined => {
  const fields = description.normalize('NFKC').split(/\s*[,،]\s*/).filter(Boolean)
  const status = fields.findIndex((field, i) => i > 0 && WEBEX_PERSON_MARK.test(field))
  const name = status > 0 ? fields.slice(0, status).join(', ') : undefined
  return name && !WEBEX_PERSON_MARK.test(name) ? name : undefined
}
function readWebex(windows: AxWindow[]): CallReading {
  const speaking: string[] = [], participants: string[] = []
  let me: string | null = null
  for (const w of windows) {
    walk(w.tree, (n, up) => {
      if (n.r === 'AXGroup' && n.t) {
        const tile = WEBEX_SPEAKING_TILE.exec(n.t.normalize('NFKC').trim())
        if (tile && tile[1].trim().length >= 2 && tile[1].trim().length <= 60) speaking.push(tile[1].trim())
      }
      if (!up.some((a) => a.r === 'AXOutline' && WEBEX_ROSTER.test((a.d ?? a.t ?? '').trim()))) return
      const rowName = n.r === 'AXRow' && n.d ? webexRowName(n.d) : undefined
      let personRow = !!rowName, name = rowName
      const labels: string[] = []
      walk(n, (x) => {
        if (n.r === 'AXCell' && x.i === 'GenericParticipantListCellView') personRow = true
        labels.push(...texts(x))
        if (!name && STATIC_TEXT.has(x.r)) name = x.v ?? x.t
      })
      if (!personRow || !name) return
      name = name.normalize('NFKC').trim()
      if (name.length < 2 || name.length > 60) return
      const label = labels.join(', ').normalize('NFKC')
      participants.push(name)
      if (/(?:^|[,،]\s*)speaking(?:\s*[,،]|$)/i.test(label)) speaking.push(name)
      if (/(?:^|[,،]\s*)me(?:\s*[,،]|$)/i.test(label)) me = name
    })
  }
  return { speaking: uniq(speaking), participants: uniq(participants), me }
}

/** What the call app shows right now */
export function readCall(kind: CallKind, windows: AxWindow[], o: { talkingClasses?: string[] } = {}): CallReading {
  return kind === 'zoom' ? readZoom(windows) : kind === 'meet' ? readMeet(windows, o) : kind === 'webex' ? readWebex(windows) : readTeams(windows)
}

/**
 * A short picture of a window's tree for the log, so a real call shows what its app gives: element counts by role,
 * and the first lines of text with their role (and DOM classes on Meet's tiles). Names stay on the Mac (the log does).
 */
/** words the call apps write themselves: their status, roles, lists and controls. Anything else may be a name, a caption
 * or a document title, and stays out of the log */
const APP_WORDS = new Set([...ZOOM.flat().map(low), ...TALKING.map(low), 'zoom meeting', 'zoom webinar', 'meeting', 'meet', 'microsoft teams',
  'you', 'context menu is available', 'kontextmenü ist verfügbar', 'leave', 'leave call', 'hang up', 'end call', 'mute mic', 'unmute mic', 'mute my audio', 'unmute my audio', 'participants', 'attendees', 'people'])
const appWord = (x: string) => APP_WORDS.has(low(x)) || OTHER_STATUS.test(x) || TEAMS_STATUS.test(x) || TEAMS_ROLE.test(x) || TEAMS_SAYS.test(x)

/** Text for the log: the app's own words kept, every other piece shown only by its length ("‹10›, Active speaker") */
export function redact(text: string): string {
  return text.replace(/\s+/g, ' ').trim().split(/(\s*,\s*|\s+[-–—|]\s+)/).map((part, i) => (i % 2 || !part || appWord(part) ? part : `‹${part.length}›`)).join('').slice(0, 120)
}

/**
 * A short picture of the call window for main.log: role counts, then each element's role, id, classes and words.
 * main.log is pasted into public issues, so names, captions and titles never go in: only the app's own words do.
 */
const MARKS = new Set([...MEET_TALKING_CLASSES, TEAMS_TALKING_CLASS])
export function summarize(windows: AxWindow[], max = 60): string {
  const roles = new Map<string, number>()
  const lines: string[] = []
  for (const w of windows) {
    lines.push(`window "${redact(w.title ?? '')}"${w.id ? ` id=${w.id}` : ''}${w.minimized ? ' minimized' : ''}`)
    walk(w.tree, (n, up) => {
      roles.set(n.r, (roles.get(n.r) ?? 0) + 1)
      const said = texts(n).map(redact)
      // an element carrying a talking mark shows too, words or not, so the log says where the marks sit (#112)
      const mark = n.c?.some((c) => MARKS.has(c))
      // past the indent cap the depth is written out, since a Meet tile is told from the page by how deep its name is
      const indent = `${'  '.repeat(Math.min(up.length, 12))}${up.length > 12 ? `@${up.length} ` : ''}`
      if ((said.length || n.i || mark) && lines.length < max) lines.push(`${indent}${n.r}${n.i ? `#${n.i}` : ''}${said.map((x) => ` ${JSON.stringify(x)}`).join('')}${n.c?.length ? ` .${n.c.slice(0, 6).join('.')}` : ''}`)
    })
  }
  return [`roles: ${[...roles].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}=${n}`).join(' ')}`, ...lines].join('\n')
}
