/**
 * What a call app's window says about who is in the call and who is talking, read from its accessibility tree
 * (yogurt-mac call-watch copies it out on a Mac, yogurt-system on Linux; this reads either). Every rule fails towards
 * reading nothing, so a changed app means Them, never a wrong name. The signals each app gives, and how sure we are of
 * them, are in the comments.
 */

/** one element of the tree as the helper copies it: role, subrole, description, title, value, identifier, DOM classes, size */
export type AxNode = { r: string; s?: string; d?: string; t?: string; v?: string; i?: string; c?: string[]; w?: number; h?: number; k?: AxNode[] }
export type AxWindow = { title?: string; id?: string; tree: AxNode }
export type CallKind = 'zoom' | 'teams' | 'meet'
export type CallReading = { speaking: string[]; participants: string[]; me: string | null }

// A role has two names: macOS Accessibility says AXTabGroup, AXStaticText, AXRow, AXOutline; AT-SPI (Linux) says
// page tab, label/static/text, table row/list item, tree table/table/list. The rules below know both.
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
/** other things Zoom appends to a tile, which say nothing about who it is */
const OTHER_STATUS = /^(video (on|off)|no audio|telephone.*|screen sharing.*|pinned|spotlighted)$/i
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
  let talking = false, known = false
  while (fields.length > 1) {
    const f = low(fields.at(-1)!)
    if (ACTIVE.has(f)) talking = known = true
    else if (AUDIO.has(f)) known = true
    else if (!OTHER_STATUS.test(f)) break
    fields.pop()
  }
  if (!known) return null
  const name = cleanZoom(fields.join(', '))
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
      if (TAB_GROUP.has(n.r) && n.d) {
        const tile = zoomTile(n.d)
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

function meetName(text: string): string | null {
  const name = text.normalize('NFKC').replace(/\s*\((presenting|presentation|you)[^)]*\)\s*$/i, '').trim()
  return name.length >= 2 && name.length <= 60 && /\p{L}/u.test(name) && !NOT_A_NAME.test(name) ? name : null
}

function readMeet(windows: AxWindow[], o: { talkingClasses?: string[] }): CallReading {
  const marks = new Set(o.talkingClasses ?? MEET_TALKING_CLASSES)
  const groups = new Map<AxNode, string[]>()
  for (const w of windows) {
    if (w.title && !/\bMeet\b/.test(w.title)) continue
    const skip = new Set((w.title ?? '').split(/\s+[-–—]\s+/).map(low))
    walk(w.tree, (n, up) => {
      if (!STATIC_TEXT.has(n.r) || up.length < TILE_UP) return
      const text = n.v ?? n.t
      if (!text) return
      const name = meetName(text)
      if (!name || skip.has(low(name))) return
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
    // Meet labels the person's own tile "You"
    if (low(one[0]) === 'you') me = one[0]
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

const TEAMS_SPEAKING = [/^(.{2,60}?)(?:,\s*|\s+is\s+)(?:speaking|talking)\b/i, /\b(?:active speaker|now speaking|speaking now)[:,]?\s+(.{2,60})$/i]
/** the state Teams puts after a person in the roster; the role ("Organizer", "Presenter", ...) may sit between */
const TEAMS_STATUS = /^(?:muted|unmuted|mic(?:rophone)? (?:on|off)|video (?:is )?(?:on|off)|camera (?:is )?(?:on|off))$/i
/** the roles Teams puts between the name and the state */
const TEAMS_ROLE = /^(?:organizer|presenter|guest|external|co-?organizer|attendee|host|co-?host|interpreter)$/i
const TEAMS_SAYS = /^(?:speaking|talking|active speaker|now speaking)$/i
const TEAMS_ME = /^(.{2,60}?)\s*\((?:you|me)\)/i
const cleanTeams = (s: string) => s.replace(/\s*\((?:organizer|presenter|guest|external|you|me)\)/gi, '').replace(/[,.:;]+$/, '').trim()

/** the roles a roster row has: the People panel's tree, or a table/list in another build */
const TEAMS_ROW = new Set(['tree item', 'table row', 'list item', 'row', 'AXRow'])
/** a list that can hold the roster; its name says whether it does */
const TEAMS_LIST = new Set(['tree', 'tree table', 'table', 'list', 'list box', 'outline', 'AXOutline', 'AXTable'])
const TEAMS_LIST_NAME = /^(?:meeting )?(?:participants|attendees|people|in (?:this|the) meeting)\b/i

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

function readTeams(windows: AxWindow[]): CallReading {
  const speaking: string[] = [], participants: string[] = []
  let me: string | null = null
  for (const w of windows) {
    walk(w.tree, (n, up) => {
      const roster = inTeamsRoster(n, up)
      for (const label of texts(n)) {
        for (const re of TEAMS_SPEAKING) { const m = re.exec(label); if (m) { const name = cleanTeams(m[1]); if (name.length >= 2 && !/^(you|me)\b/i.test(name)) speaking.push(name) } }
        const persona = roster ? teamsPersona(label) : null
        if (persona) { participants.push(persona.name); if (persona.speaking) speaking.push(persona.name) }
        const mine = roster ? TEAMS_ME.exec(label) : null
        if (mine) { me = cleanTeams(mine[1]); participants.push(me) }
      }
    })
  }
  return { speaking: uniq(speaking), participants: uniq(participants.filter((p) => p.length >= 2)), me }
}

/** What the call app shows right now */
export function readCall(kind: CallKind, windows: AxWindow[], o: { talkingClasses?: string[] } = {}): CallReading {
  return kind === 'zoom' ? readZoom(windows) : kind === 'meet' ? readMeet(windows, o) : readTeams(windows)
}

/**
 * A short picture of a window's tree for the log, so a real call shows what its app gives: element counts by role,
 * and the first lines of text with their role (and DOM classes on Meet's tiles). Names stay on the Mac (the log does).
 */
export function summarize(windows: AxWindow[], max = 60): string {
  const roles = new Map<string, number>()
  const lines: string[] = []
  for (const w of windows) {
    lines.push(`window "${(w.title ?? '').slice(0, 60)}"${w.id ? ` id=${w.id}` : ''}`)
    walk(w.tree, (n, up) => {
      roles.set(n.r, (roles.get(n.r) ?? 0) + 1)
      const said = texts(n).map((x) => x.replace(/\s+/g, ' ').slice(0, 80))
      if ((said.length || n.i) && lines.length < max) lines.push(`${'  '.repeat(Math.min(up.length, 12))}${n.r}${n.i ? `#${n.i}` : ''} ${said.map((x) => JSON.stringify(x)).join(' ')}${n.c?.length ? ` .${n.c.slice(0, 6).join('.')}` : ''}`)
    })
  }
  return [`roles: ${[...roles].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}=${n}`).join(' ')}`, ...lines].join('\n')
}
