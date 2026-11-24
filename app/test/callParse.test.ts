import { describe, expect, it } from 'vitest'
import { readCall, summarize, zoomLinuxTile, zoomTile, type AxNode, type AxWindow } from '../src/main/callNames/parse'
import { nameFor } from '../src/main/callNames/attribute'

const node = (r: string, o: Partial<AxNode> = {}, ...k: AxNode[]): AxNode => ({ r, ...o, ...(k.length ? { k } : {}) })
const win = (tree: AxNode, title?: string): AxWindow => ({ title, tree })

// ---- Zoom: shapes from Zoom 7.1's meeting window, as other projects measured it, with made-up names ----
const zoomTileNode = (d: string) => node('AXTabGroup', { d, w: 320, h: 180 })
const zoomRow = (text: string) => node('AXRow', {}, node('AXCell', {}, node('AXStaticText', { v: text }), node('AXImage', { d: 'Computer audio unmuted' })))
const zoomWindow = (tiles: string[], rows: string[] = [], extra: AxNode[] = []) => win(node('AXWindow', { i: 'zm.meeting.window.main' },
  node('AXGroup', {}, ...tiles.map(zoomTileNode)),
  ...(rows.length ? [node('AXScrollArea', {}, node('AXOutline', { d: 'Participants list' }, ...rows.map(zoomRow)))] : []),
  node('AXButton', { d: 'Mute my audio', i: 'audio' }), ...extra))

describe('Zoom', () => {
  it('reads a tile: the name, and whether it carries the active-speaker mark', () => {
    expect(zoomTile('Ana Ruiz, Computer audio unmuted, Video off, Active speaker')).toEqual({ name: 'Ana Ruiz', talking: true })
    expect(zoomTile('Ana Ruiz, Computer audio muted, Video on')).toEqual({ name: 'Ana Ruiz', talking: false })
    // a comma in a name stays; a role tag goes
    expect(zoomTile('Smith, Dana (Host), Computer audio unmuted')).toEqual({ name: 'Smith, Dana', talking: false })
    // another language Zoom speaks
    expect(zoomTile('Ana Ruiz, Audio de la computadora no silenciado, Orador activo')).toEqual({ name: 'Ana Ruiz', talking: true })
    // not a tile: buttons and anything without Zoom's status words
    expect(zoomTile('Mute my audio')).toBeNull()
    expect(zoomTile('Share screen, Alt+S')).toBeNull()
  })

  it('a call of three: the marked tile talks; "(me)" in the list is the person using Yogurt', () => {
    const r = readCall('zoom', [zoomWindow(
      ['Alex Morgan, Computer audio unmuted, Video on', 'Dana Smith, Computer audio unmuted, Video off, Active speaker', 'Ann Lee, Computer audio muted, Video off'],
      ['Alex Morgan (me)', 'Dana Smith (Host)', 'Ann Lee'],
    )])
    expect(r).toEqual({ speaking: ['Dana Smith'], participants: ['Alex Morgan', 'Dana Smith', 'Ann Lee'], me: 'Alex Morgan' })
  })

  it('the host using Yogurt: "(Host, me)" is one tag group, so the name is clean and known to be "me"', () => {
    const r = readCall('zoom', [zoomWindow(['Alex Morgan, Computer audio unmuted'], ['Alex Morgan (Host, me)', 'Ann Lee (Co-host)'])])
    expect(r).toEqual({ speaking: [], participants: ['Alex Morgan', 'Ann Lee'], me: 'Alex Morgan' })
  })

  it('with the list closed nobody is known to be "me"; with nobody marked nobody talks', () => {
    const r = readCall('zoom', [zoomWindow(['Alex Morgan, Computer audio unmuted', 'Dana Smith, Computer audio unmuted'])])
    expect(r).toEqual({ speaking: [], participants: ['Alex Morgan', 'Dana Smith'], me: null })
  })

  it('the small floating window says who is talking', () => {
    const r = readCall('zoom', [win(node('AXWindow', {}, node('AXStaticText', { v: 'Talking: Dana Smith' })))])
    expect(r.speaking).toEqual(['Dana Smith'])
  })

  it('a Zoom that changed its window reads as nothing, never a wrong name', () => {
    const r = readCall('zoom', [win(node('AXWindow', {}, node('AXGroup', { d: 'Dana Smith' }), node('AXTabGroup', { d: 'Chat' }), node('AXStaticText', { v: 'Dana Smith' })))])
    expect(r).toEqual({ speaking: [], participants: [], me: null })
  })

  it('reads the same signals from AT-SPI roles (Linux): page tab, label, table row, tree table', () => {
    const tree = node('frame', { t: 'Zoom Meeting' },
      node('page tab', { d: 'Ana Ruiz, Computer audio unmuted, Active speaker' }),
      node('label', { t: 'Talking: Ann Lee' }),
      node('tree table', { t: 'Participants list' }, node('table row', {}, node('label', { t: 'Alex Morgan (me)' }))))
    expect(readCall('zoom', [win(tree)])).toEqual({ speaking: ['Ana Ruiz', 'Ann Lee'], participants: ['Ana Ruiz', 'Alex Morgan'], me: 'Alex Morgan' })
  })

  it('reads a tile whose words are its name (UI Automation on Windows has no separate description)', () => {
    const tree = node('frame', { t: 'Zoom Meeting' },
      node('page tab', { t: 'Ana Ruiz, Computer audio unmuted, Active speaker' }),
      node('page tab', { t: 'Chat' }))
    expect(readCall('zoom', [win(tree)])).toEqual({ speaking: ['Ana Ruiz'], participants: ['Ana Ruiz'], me: null })
  })

  it('reads the Linux Zoom Workplace tile: a push button named "video item <name>"', () => {
    expect(zoomLinuxTile('video item Ana Ruiz Active Speaker')).toEqual({ name: 'Ana Ruiz', talking: true })
    expect(zoomLinuxTile('video item Ana Ruiz')).toEqual({ name: 'Ana Ruiz', talking: false })
    // a one-word name is a name
    expect(zoomLinuxTile('video item Madonna')).toEqual({ name: 'Madonna', talking: false })
    // not a tile
    expect(zoomLinuxTile('share content item')).toBeNull()
    expect(zoomLinuxTile('video item')).toBeNull()
  })

  it('the Linux window names the call from its tiles, and trusts the speaker mark only with three or more', () => {
    const tile = (name: string, active = false) => node('push button', { t: `video item ${name}${active ? ' Active Speaker' : ''}` })
    const meeting = (...tiles: AxNode[]) => win(node('frame', { t: 'Meeting' }, node('panel', {}, ...tiles)), 'Meeting')
    expect(readCall('zoom', [meeting(tile('Alex Morgan', true), tile('Dana Smith'), tile('Ann Lee'))]))
      .toEqual({ speaking: ['Alex Morgan'], participants: ['Alex Morgan', 'Dana Smith', 'Ann Lee'], me: null })
    // the only tile of a call of one always says Active Speaker; it must not read as someone talking
    expect(readCall('zoom', [meeting(tile('Alex Morgan', true))]))
      .toEqual({ speaking: [], participants: ['Alex Morgan'], me: null })
  })
})

// ---- Google Meet in a browser: names as text in each tile, the talking tile marked by a class ----
/** a tile: the name text seven levels down, the class marks on the tile's own elements */
const meetTile = (name: string, classes: string[] = []) => {
  let n = node('AXStaticText', { v: name })
  for (let i = 0; i < 6; i++) n = node('AXGroup', i === 3 ? { c: ['notranslate'] } : {}, n)
  return node('AXGroup', { c: ['oZRSLe', ...classes] }, node('AXGroup', { d: 'More options for ' + name }), n)
}
const meetWindow = (tiles: AxNode[], title = 'Meet - abc-defg-hij') => win(node('AXWindow', { t: title },
  node('AXGroup', {}, node('AXWebArea', { t: title }, node('AXGroup', {}, node('AXGroup', {}, ...tiles)),
    // the meeting code and the clock are text too, never people
    node('AXGroup', {}, node('AXGroup', {}, node('AXGroup', {}, node('AXGroup', {}, node('AXGroup', {}, node('AXGroup', {}, node('AXGroup', {}, node('AXStaticText', { v: 'abc-defg-hij' }), node('AXStaticText', { v: '10:42' }))))))))))), title)

describe('Google Meet', () => {
  // Eric, after a two-person Meet: reCAPTCHA, a chat message ("lightsage") and an Upgrade link were added as people
  it('page words (reCAPTCHA, Upgrade) and anything in the chat panel are never people', () => {
    const chatMessage = (text: string) => {
      let n = node('AXStaticText', { v: text })
      for (let i = 0; i < 7; i++) n = node('AXGroup', {}, n)
      return node('AXGroup', { d: 'In-call messages' }, node('AXList', { d: 'Chat messages' }, n))
    }
    const r = readCall('meet', [meetWindow([meetTile('You'), meetTile('May Wang', ['v5h6Xc']), meetTile('reCAPTCHA'), meetTile('Upgrade'), chatMessage('lightsage')])])
    expect(r).toEqual({ speaking: ['May Wang'], participants: ['You', 'May Wang'], me: 'You' })
  })
  it('a meeting named after a chat still reads its tiles', () => {
    expect(readCall('meet', [meetWindow([meetTile('Dana Smith', ['v5h6Xc'])], 'Meet - Weekly chat')]).participants).toEqual(['Dana Smith'])
  })

  it('reads each tile once, and the tile with the talking class', () => {
    const r = readCall('meet', [meetWindow([meetTile('You'), meetTile('Dana Smith', ['v5h6Xc']), meetTile('Ann Lee')])])
    expect(r).toEqual({ speaking: ['Dana Smith'], participants: ['You', 'Dana Smith', 'Ann Lee'], me: 'You' })
  })

  it('a renamed class marks nobody; a tile shown "(Presenting)" is still the person', () => {
    const r = readCall('meet', [meetWindow([meetTile('You', ['zz9']), meetTile('Dana Smith (Presenting)', ['Abc12'])])])
    expect(r).toEqual({ speaking: [], participants: ['You', 'Dana Smith'], me: 'You' })
    // a class found later can be given
    expect(readCall('meet', [meetWindow([meetTile('Dana Smith', ['Abc12'])])], { talkingClasses: ['Abc12'] }).speaking).toEqual(['Dana Smith'])
  })

  it("Meet's own words are never people: lobby, toasts, sharing, leaving and controls (#71)", () => {
    const ui = ['Ready to join?', 'In 2 mins', 'Looking for others in the call...', 'Mon, Nov 16', 'Your camera is on.', 'Background is now blurred',
      'Reducing noise', 'Continuous chat is turned off', 'Messages will not be saved', 'Presentation is starting...', 'Select a tab to share',
      'Share with tab audio', 'Quarterly plan - Google Docs', 'Alex Doe has left the meeting', 'No one else is in this meeting',
      'Returning to home screen in 60 seconds.', 'Meet', 'Reframe', 'Turn off camera (⌘ + e)', 'Learn more about Gemini in Meetings.', 'Chat / People panel is open']
    const r = readCall('meet', [meetWindow([meetTile('Dana Smith'), ...ui.map((u) => meetTile(u))])])
    expect(r.participants).toEqual(['Dana Smith'])
  })

  it('a name in a toast or status area is not a tile (#71)', () => {
    const toast = node('AXGroup', { s: 'AXApplicationStatus' }, meetTile('Ann Lee'))
    const alert = node('alert', {}, meetTile('Bo Park'))
    expect(readCall('meet', [meetWindow([meetTile('Dana Smith'), toast, alert])]).participants).toEqual(['Dana Smith'])
  })

  it('real names of every shape still count', () => {
    const names = ['Dana Smith', 'Ana María de la Cruz', 'Mary-Jane O\'Neil', 'J. R. Smith', 'Ludwig van Beethoven', '李雷', 'jiwon', 'Ann Lee (Presenting)']
    expect(readCall('meet', [meetWindow(names.map((n) => meetTile(n)))]).participants)
      .toEqual(['Dana Smith', 'Ana María de la Cruz', 'Mary-Jane O\'Neil', 'J. R. Smith', 'Ludwig van Beethoven', '李雷', 'jiwon', 'Ann Lee'])
  })

  it('only windows showing a Meet call are read', () => {
    expect(readCall('meet', [meetWindow([meetTile('Dana Smith', ['v5h6Xc'])], 'Inbox - Gmail')]).participants).toEqual([])
  })
})

// ---- Teams: the People panel roster (measured on Linux), and the words other builds show ----
describe('Microsoft Teams', () => {
  it('reads "Name, speaking", roster rows with a mic or video state, and "(You)"', () => {
    const tree = node('AXWindow', {},
      node('AXGroup', { d: 'Dana Smith, speaking' }),
      node('AXOutline', { d: 'Participants' },
        node('AXRow', { d: 'Dana Smith, unmuted, video on' }, node('AXStaticText', { v: 'Dana Smith' })),
        node('AXRow', { d: 'Ann Lee, muted' }),
        node('AXRow', { d: 'Alex Morgan (You)' })),
      node('AXButton', { d: 'Leave' }))
    expect(readCall('teams', [win(tree, 'Weekly sync | Microsoft Teams')])).toEqual({ speaking: ['Dana Smith'], participants: ['Dana Smith', 'Ann Lee', 'Alex Morgan'], me: 'Alex Morgan' })
  })

  it('never takes "You" or the app\'s own words for a person', () => {
    const tree = node('AXWindow', {}, node('AXStaticText', { v: 'You are speaking' }), node('AXButton', { d: 'Mic on' }))
    expect(readCall('teams', [win(tree)])).toEqual({ speaking: [], participants: [], me: null })
  })

  it('reads AT-SPI names as well as descriptions (Linux)', () => {
    const tree = node('frame', {},
      node('section', { t: 'Dana Smith, speaking' }),
      node('tree', { t: 'Participants' },
        node('tree item', {}, node('section', { t: 'Ann Lee, muted' }))))
    expect(readCall('teams', [win(tree)])).toEqual({ speaking: ['Dana Smith'], participants: ['Ann Lee'], me: null })
  })

  it('never takes a chat or calendar line for a person, even when it reads like a roster row', () => {
    const tree = node('frame', {},
      node('list', { t: 'Chat' }, node('list item', { t: 'Dana Smith, muted' }), node('list item', { t: 'Dana Smith (you)' })),
      node('section', { t: 'Ann Lee, Organizer, Unmuted' }))
    expect(readCall('teams', [win(tree)])).toEqual({ speaking: [], participants: [], me: null })
  })

  it('reads the People panel roster (Teams for Linux): "Name, Role, Muted|Unmuted"', () => {
    const tree = node('frame', { t: 'Meeting | Microsoft Teams' },
      node('landmark', { t: 'Participants' },
        node('tree', { t: 'Attendees' },
          node('tree item', { t: 'Dana Smith, Organizer, Unmuted' },
            node('section', { t: 'Dana Smith, Organizer, Unmuted' },
              node('section', { t: 'Dana Smith' },
                node('static', { t: 'Dana Smith' }),
                node('static', { t: 'Organizer' }),
                node('image', { t: 'Unmuted' })))))))
    expect(readCall('teams', [win(tree)])).toEqual({ speaking: [], participants: ['Dana Smith'], me: null })
  })

  it('reads every roster row, with a role between the name and the state, and never the group header', () => {
    const tree = node('frame', {},
      node('tree', { t: 'Attendees' },
        node('tree item', { t: 'Dana Smith, Organizer, Unmuted' }),
        node('tree item', { t: 'Alex Morgan, Presenter, Muted' }),
        node('tree item', { t: 'Sam Lee, Guest, Unmuted' }),
        node('tree item', { t: 'In this meeting, 3 total' })))
    expect(readCall('teams', [win(tree)])).toEqual({ speaking: [], participants: ['Dana Smith', 'Alex Morgan', 'Sam Lee'], me: null })
  })

  it('keeps a comma in a roster name', () => {
    const tree = node('frame', {},
      node('tree', { t: 'Attendees' },
        node('tree item', { t: 'Smith, Dana, Organizer, Unmuted' })))
    expect(readCall('teams', [win(tree)])).toEqual({ speaking: [], participants: ['Smith, Dana'], me: null })
  })

  it('a roster row marked (You) is the person using Yogurt', () => {
    const tree = node('frame', {},
      node('tree', { t: 'Attendees' },
        node('tree item', { t: 'Dana Smith (You), Organizer, Unmuted' }),
        node('tree item', { t: 'Alex Morgan, Presenter, Unmuted' })))
    expect(readCall('teams', [win(tree)])).toEqual({ speaking: [], participants: ['Dana Smith', 'Alex Morgan'], me: 'Dana Smith' })
  })
})

// ---- Teams on Windows (#83): the call window's tree from a German Teams call (0.3.66), names made up ----
// Each video tile is a menu item labelled "Name, <state>, Kontextmenü ist verfügbar" holding a label with just the
// name; one tile reads its name and that hint run together. Menus that open sit in Fluent's layer host.
const germanTeams = (extra: AxNode[] = []) => win(node('frame', { t: 'Anna Becker, Jonas Weber, Lena Hoffmann | Microsoft Teams' },
  node('document web', { i: 'RootWebArea' },
    node('panel', { i: 'app' },
      node('push button', { i: 'microphone-button', t: 'Stummschalten (Strg+Umschalt+M)' }),
      node('push button', { i: 'roster-button', t: 'Personen' }),
      node('push button', { i: 'hangup-button', t: 'Verlassen' }),
      node('panel', { t: 'Besprechungsansicht, 4 Personen' },
        node('menu item', { t: 'Sabine KrügerKontextmenü ist verfügbar' }, node('label', { t: 'Sabine Krüger' }), node('unknown', { t: 'Kontextmenü ist verfügbar' })),
        node('menu item', { t: 'Anna Becker, Video ist aus, Kontextmenü ist verfügbar' }, node('label', { t: 'Anna Becker' })),
        node('menu item', { t: 'Jonas Weber, Video ist aus, Kontextmenü ist verfügbar' }, node('label', { t: 'Jonas Weber' })),
        node('menu item', { t: 'Lena Hoffmann, Video ist aus, Kontextmenü ist verfügbar' }, node('label', { t: 'Lena Hoffmann' })),
        node('image', { i: 'menurkgn', t: 'Jonas Weber, Bildschirmfreigabe, Kontextmenü ist verfügbar, Vollbild' })),
      ...extra),
    node('panel', { i: 'fluent-default-layer-host' },
      node('menu', {}, node('menu item', { t: 'Einstellungen, Strg+Komma' }, node('label', { t: 'Einstellungen' })),
        node('menu item', { t: 'Kamera einschaltenStrg+Umschalt+O' }, node('label', { t: 'Kamera einschalten' }), node('label', { t: 'Strg+Umschalt+O' })))))))

describe('Microsoft Teams on Windows, in any language (#83)', () => {
  it("reads each video tile's name from the label inside it, whatever language the tile's words are in", () => {
    expect(readCall('teams', [germanTeams()]).participants).toEqual(['Sabine Krüger', 'Anna Becker', 'Jonas Weber', 'Lena Hoffmann'])
  })
  it('never takes a menu that opened (settings, a shortcut) or a shared screen for a person', () => {
    const r = readCall('teams', [germanTeams()])
    for (const not of ['Einstellungen', 'Kamera einschalten', 'Bildschirmfreigabe']) expect(r.participants).not.toContain(not)
    // a menu item whose label is all of it is a tile only in the call window, outside toolbars and opened menus
    const plain = win(node('frame', {}, node('menu item', { t: 'Bericht' }, node('label', { t: 'Bericht' }))))
    expect(readCall('teams', [plain]).participants).toEqual([])
    const menus = germanTeams([node('tool bar', { i: 'horizontalMiddleEnd' }, node('menu item', { t: 'Bericht' }, node('label', { t: 'Bericht' })))])
    expect(readCall('teams', [menus]).participants).not.toContain('Bericht')
    const popup = win(node('frame', {}, node('push button', { i: 'hangup-button', t: 'Verlassen' }),
      node('panel', { i: 'fluent-default-layer-host' }, node('menu', {}, node('menu item', { t: 'Bericht' }, node('label', { t: 'Bericht' }))))))
    expect(readCall('teams', [popup]).participants).toEqual([])
  })
  it('a call of two: the tiles give both people, so the other one is named', () => {
    const two = win(node('frame', {}, node('push button', { i: 'hangup-button', t: 'Verlassen' }),
      node('menu item', { t: 'Alex Morgan (Sie), Kontextmenü ist verfügbar' }, node('label', { t: 'Alex Morgan (Sie)' })),
      node('menu item', { t: 'Anna Becker, Kontextmenü ist verfügbar' }, node('label', { t: 'Anna Becker' }))))
    expect(readCall('teams', [two])).toEqual({ speaking: [], participants: ['Alex Morgan', 'Anna Becker'], me: 'Alex Morgan' })
  })
  it('reads the German words: "spricht", and roster rows "Name, Organisator, Stummgeschaltet" in the Teilnehmer list', () => {
    const tree = node('frame', {},
      node('menu item', { t: 'Anna Becker, spricht, Kontextmenü ist verfügbar' }, node('label', { t: 'Anna Becker' })),
      node('tree', { t: 'Teilnehmer' },
        node('tree item', { t: 'Jonas Weber, Organisator, Stummgeschaltet' }),
        node('tree item', { t: 'Lena Hoffmann, Referent, Stummschaltung aufgehoben' }),
        node('tree item', { t: 'Alex Morgan (Sie), Stummgeschaltet' })))
    expect(readCall('teams', [win(tree)])).toEqual({ speaking: ['Anna Becker'], participants: ['Anna Becker', 'Jonas Weber', 'Lena Hoffmann', 'Alex Morgan'], me: 'Alex Morgan' })
  })
})

// ---- a 1:1 Teams call on Windows (#83, 0.3.68): hold, transfer and dial pad, one tile whose text is just the name ----
const oneToOne = (title: string | undefined, tiles: string[]) => win(node('frame', { t: title },
  node('document web', { i: 'RootWebArea' },
    node('panel', { i: 'app' },
      node('tool bar', { i: 'horizontalMiddleEnd' },
        node('push button', { i: 'microphone-button', t: 'Stummschalten (Strg+Umschalt+M)' }),
        node('push button', { i: 'dialpad-button', t: 'Wähltastatur' }),
        node('push button', { i: 'hold-button', t: 'Halten' }),
        node('push button', { i: 'transfer-button', t: 'Weiterleiten' })),
      node('panel', { i: 'horizontalEnd' }, node('push button', { i: 'hangup-button', t: 'Auflegen' })),
      node('panel', { t: 'Besprechungsansicht' },
        node('image', { i: 'menurp0g', c: ['fui-Primitive', 'vdi-dynamic-occlusion'], t: 'Profilbild anzeigen, Kamera ist deaktiviert, Stummschaltung aufgehoben, Videokachel' }),
        ...tiles.map((t) => node('menu item', { t }, node('label', { t }))))))), title)

describe('a 1:1 Teams call (#83)', () => {
  it("the only other person's tile names the call's sound, with nobody marked as talking and no name of mine known", () => {
    expect(readCall('teams', [oneToOne('Anna Becker | Microsoft Teams', ['Anna Becker'])])).toEqual({ speaking: ['Anna Becker'], participants: ['Anna Becker'], me: null })
  })
  it('the window title names the other person when no tile is read, and picks them when I have a tile too', () => {
    expect(readCall('teams', [oneToOne('Anna Becker | Microsoft Teams', [])])).toEqual({ speaking: ['Anna Becker'], participants: ['Anna Becker'], me: null })
    expect(readCall('teams', [oneToOne('Anna Becker | Microsoft Teams', ['Alex Morgan', 'Anna Becker'])]).speaking).toEqual(['Anna Becker'])
    // one tile and no usable title: that tile
    expect(readCall('teams', [oneToOne(undefined, ['Anna Becker'])]).speaking).toEqual(['Anna Becker'])
  })
  it('a tile and a title that disagree, a title that is no name, or a group call: nobody is taken as talking', () => {
    expect(readCall('teams', [oneToOne('Anna Becker | Microsoft Teams', ['Jonas Weber'])]).speaking).toEqual([])
    expect(readCall('teams', [oneToOne('Chat | Anna Becker | Microsoft Teams', [])]).speaking).toEqual([])
    expect(readCall('teams', [oneToOne('Planung Q3 2027 | Microsoft Teams', [])]).speaking).toEqual([])
    expect(readCall('teams', [oneToOne(undefined, ['Anna Becker', 'Jonas Weber'])]).speaking).toEqual([])
    // the same tile in a meeting (no hold or transfer) is someone there, not the one talking
    expect(readCall('teams', [germanTeams()]).speaking).toEqual([])
  })
})

// ---- a German Teams meeting on Windows (#83): "Name, <meeting title>, stummgeschaltet, Kontextmenü ist verfügbar" ----
// Teams marks nobody as talking here; only who is muted. My own tile's label is "Name, Ich". Names made up.
const TITLE = 'Abstimmung Projekt Nordlicht mit Partnern'
const meetingTile = (name: string, label: string, muted: boolean) =>
  node('menu item', { t: `${name}, ${TITLE}, ${muted ? 'stummgeschaltet, ' : ''}Kontextmenü ist verfügbar` }, node('label', { t: label }))
const meeting = (tiles: AxNode[]) => win(node('frame', { t: `${TITLE} | Microsoft Teams` },
  node('panel', { i: 'app' },
    node('push button', { i: 'microphone-button', t: 'Stummschalten (Strg+Umschalt+M)' }),
    node('panel', { i: 'horizontalEnd' }, node('push button', { i: 'hangup-button', t: 'Verlassen' })),
    node('menu item', { t: `Christa, Kamera ist deaktiviert, ${TITLE}, Kontextmenü ist verfügbar` }, node('label', { t: 'Christa, Ich' })),
    ...tiles)), `${TITLE} | Microsoft Teams`)

describe('a Teams meeting where nobody is marked as talking (#83)', () => {
  const anna = meetingTile('Anna Becker', 'Anna Becker', true)
  const jonas = meetingTile('Jonas Weber (Contoso GmbH)', 'Jonas Weber', true)
  const lena = meetingTile('Lena Hoffmann (Extern)', 'Lena Hoffmann', false)
  it("the only other person not muted is the one talking; my tile (\"Name, Ich\") is me, and the meeting's title is no one", () => {
    expect(readCall('teams', [meeting([anna, jonas, lena])])).toEqual({ speaking: ['Lena Hoffmann'], participants: ['Christa', 'Anna Becker', 'Jonas Weber', 'Lena Hoffmann'], me: 'Christa', byMute: true })
  })
  it('names nobody with two others not muted, with everyone muted, with only one other shown, or with a tile it could not read', () => {
    const tom = meetingTile('Tom Krause', 'Tom Krause', false)
    expect(readCall('teams', [meeting([anna, lena, tom])]).speaking).toEqual([])
    expect(readCall('teams', [meeting([anna, jonas])]).speaking).toEqual([])
    expect(readCall('teams', [meeting([lena])]).speaking).toEqual([])
    const odd = node('menu item', { t: `Paul Klein Contoso, ${TITLE}, stummgeschaltet, Kontextmenü ist verfügbar` }, node('label', { t: 'Paul Klein' }))
    expect(readCall('teams', [meeting([anna, lena, odd])]).speaking).toEqual([])
  })
})

// ---- new Teams in English on Windows (#83, 0.3.69): tiles with no label inside, the mute word on the video image ----
// menu item "Name, video is on, <meeting title>, Context menu is available"; beside it an image whose words carry
// "Unmuted" or "Muted" and end with the person's name. Names made up.
const EN_TITLE = 'Quarterly planning with Contoso'
const enTile = (name: string, video = 'video is on', extra = '') => node('menu item', { t: `${name}, ${video}, ${EN_TITLE}, ${extra}Context menu is available` })
const enVideo = (name: string, mic: 'Unmuted' | 'Muted') => node('image', { i: `menu${name.length}x`, c: ['fui-Primitive', 'vdi-dynamic-occlusion'], t: `Video, of, call, ${EN_TITLE}, ${mic}, video is on, Pinned off, ${name}` })
const enMeeting = (stage: AxNode[]) => win(node('frame', { t: `${EN_TITLE} | Microsoft Teams` },
  node('panel', { i: 'app' },
    node('push button', { i: 'organizer-control-button', t: 'Meeting options' }),
    node('push button', { i: 'start-breakout-room-button', t: 'Rooms' }),
    node('panel', { i: 'horizontalEnd' }, node('push button', { i: 'hangup-button', t: 'Leave' })),
    ...stage)), `${EN_TITLE} | Microsoft Teams`)

describe('new Teams in English on Windows (#83)', () => {
  it('reads a tile with no label inside: the name before "video is on" (or off), never the meeting title or the hint', () => {
    const r = readCall('teams', [enMeeting([enTile('Dana Smith'), enTile('Ann Lee', 'Video is off'), enTile('Bo Park', 'video is off')])])
    expect(r.participants).toEqual(['Dana Smith', 'Ann Lee', 'Bo Park'])
  })
  it('takes the mute word from the video image that names the person, so the one other person unmuted is the one talking', () => {
    const stage = [enVideo('Dana Smith', 'Unmuted'), enTile('Dana Smith'), enVideo('Ann Lee', 'Muted'), enTile('Ann Lee'), enTile('Bo Park', 'video is off', 'Muted, ')]
    expect(readCall('teams', [enMeeting(stage)])).toEqual({ speaking: ['Dana Smith'], participants: ['Dana Smith', 'Ann Lee', 'Bo Park'], me: null, byMute: true })
    // an image naming nobody shown says nothing about anyone
    const stray = [enVideo('Cy Young', 'Unmuted'), enTile('Ann Lee', 'video is on', 'Muted, '), enTile('Bo Park', 'video is on', 'Muted, ')]
    expect(readCall('teams', [enMeeting(stray)]).speaking).toEqual([])
  })
  it("my own tile (\"Name (You)\") is me, so with one other person the reading is a call of two", () => {
    const r = readCall('teams', [enMeeting([enTile('Alex Morgan (You)'), enVideo('Dana Smith', 'Unmuted'), enTile('Dana Smith')])])
    expect(r).toEqual({ speaking: [], participants: ['Alex Morgan', 'Dana Smith'], me: 'Alex Morgan' })
  })
  it('reads a tile whose label inside is not the name: "(You)" there is my own tile, anything else is just the name before it (#83, 18:30)', () => {
    const mine = node('menu item', { t: `Alex Morgan, video is on, ${EN_TITLE}, Context menu is available` }, node('label', { t: '(You)' }))
    const dana = node('menu item', { t: `Dana Smith, video is off, ${EN_TITLE}, Context menu is available` }, node('label', { t: 'DS' }))
    expect(readCall('teams', [enMeeting([mine, dana])])).toEqual({ speaking: [], participants: ['Alex Morgan', 'Dana Smith'], me: 'Alex Morgan' })
    // a label that starts the tile's words but runs on into something else is still no name
    const odd = node('menu item', { t: `Dana Smith Contoso, video is on, ${EN_TITLE}, Context menu is available` }, node('label', { t: 'Dana Smith' }))
    expect(readCall('teams', [enMeeting([odd])]).participants).toEqual([])
  })
  it('one other tile alone in a meeting names nobody: a bigger meeting with the chat open shows one tile too (#83, 15:30)', () => {
    expect(readCall('teams', [enMeeting([enVideo('Dana Smith', 'Unmuted'), enTile('Dana Smith')])]).speaking).toEqual([])
  })
})

// ---- Teams' talking mark on Windows (#83, measured by a reporter in an 8-person English meeting): the tile's last
// child carries the class vdi-frame-occlusion while that person talks; other classes when they stop; a muted tile has
// no such child. Shapes copied from three tiles of one call-watch reading, names made up.
const nameBox = (name: string): AxNode => node('panel', { c: ['fui-Primitive', '___y6qvlo0'] },
  node('panel', { c: ['fui-Flex', 'vdi-occlusion', '___1d0k7eo'] },
    node('panel', { c: ['fui-Flex', '___ylrf500'] },
      node('panel', { c: ['___nq9nxu0', 'lpcCommonWeb-hoverTarget', 'lpc-hover-target-container'] }, node('label', { t: name })))))
const PRODUCTION = 'Has control of production tools'
const talkingTile = (name: string, talking: boolean) => node('menu item', { t: `${name}, video is on, ${PRODUCTION}, Context menu is available`, c: ['fui-Flex', '___s8lnzv0'] },
  node('panel', { c: ['fui-Primitive', '___19sw0rl'] }), nameBox(name),
  node('panel', { c: talking ? ['fui-Flex', 'vdi-frame-occlusion', '___1vvhwjq'] : ['fui-Flex', '___dv8x4j0', 'f22iagw'] }))
const mutedTile = (name: string) => node('menu item', { t: `${name}, ${PRODUCTION}, muted, Context menu is available`, c: ['fui-Flex', '___1ntexr1'] },
  node('panel', { c: ['fui-Primitive', 'bkg_ZmZkYTdk', '___1eev0rn'] }), node('panel', { c: ['fui-Primitive', '___19sw0rl'] }), nameBox(name))
const stage = (tiles: AxNode[], title = 'Weekly review | Microsoft Teams') => win(node('frame', { t: title },
  node('panel', { i: 'app' }, node('panel', { i: 'horizontalEnd' }, node('push button', { i: 'hangup-button', t: 'Leave' })), ...tiles)), title)

describe("Teams' talking mark: the tile's last child has vdi-frame-occlusion (#83)", () => {
  it('marks the person talking, not someone unmuted and quiet, and never a muted tile', () => {
    const r = readCall('teams', [stage([talkingTile('Dana Smith', true), talkingTile('Ann Lee', false), mutedTile('Bo Park')])])
    expect(r).toEqual({ speaking: ['Dana Smith'], participants: ['Dana Smith', 'Ann Lee', 'Bo Park'], me: null })
  })
  it('reads the name from the first field or the label, whatever Teams puts before the hint', () => {
    expect(readCall('teams', [stage([talkingTile('Dana Smith', false)])]).participants).toEqual(['Dana Smith'])
  })
  it('is a real mark: it wins over who is muted, and with 3 or 4 mics open it follows the one talking around an 8-person stage', () => {
    const people = ['Dana Smith', 'Ann Lee', 'Bo Park', 'Cy Young', 'Eve Adams', 'Finn Moss', 'Gus Hale', 'Ivy Chen']
    const open = new Set(['Dana Smith', 'Ann Lee', 'Cy Young', 'Ivy Chen'])
    for (const talker of ['Ann Lee', 'Ivy Chen', 'Dana Smith']) {
      const tiles = people.map((p) => (open.has(p) ? talkingTile(p, p === talker) : mutedTile(p)))
      const r = readCall('teams', [stage(tiles)])
      expect(r.speaking).toEqual([talker])
      expect(r.byMute).toBeUndefined()
      expect(r.participants).toHaveLength(8)
    }
    // nobody talking with several mics open: nobody marked
    expect(readCall('teams', [stage(people.map((p) => (open.has(p) ? talkingTile(p, false) : mutedTile(p))))]).speaking).toEqual([])
  })
  it('the class only counts on the last child of a tile, not anywhere else in the window', () => {
    const elsewhere = node('panel', { c: ['fui-Flex', 'vdi-frame-occlusion'] }, node('label', { t: 'Weekly review' }))
    expect(readCall('teams', [stage([elsewhere, talkingTile('Ann Lee', false), talkingTile('Bo Park', false)])]).speaking).toEqual([])
  })
})

// ---- Teams' talking mark on a Mac (#138, from a reporter's 3-person call in new Teams on macOS): the same tiles as on
// Windows, as AXMenuItems described "Name, ..., Context menu is available", the classes from AXDOMClassList, and while
// someone talks an empty AXGroup with vdi-frame-occlusion as the tile's last child. My own tile reads "Myself video,
// Name, ..., Unmuted, Has context menu". A small "Window" dialog (window sharing) comes first. Names made up.
const macTile = (name: string, talking: boolean): AxNode => node('AXMenuItem', { d: `${name}, ${PRODUCTION}, Context menu is available`, c: ['fui-Flex', '___s8lnzv0'] },
  node('AXGroup', { c: ['fui-Primitive', 'bkg_ZmZkYTdk'] }), node('AXGroup', { c: ['fui-Primitive', '___19sw0rl'] }), node('AXGroup', { c: ['fui-Primitive', '___jl63on0'] }),
  node('AXGroup', { c: ['fui-Flex', 'vdi-occlusion', '___1d0k7eo'] }), node('AXGroup', { c: ['fui-Flex', '___ylrf500'] }),
  node('AXStaticText', { v: name }),
  ...(talking ? [node('AXGroup', { c: ['fui-Flex', 'vdi-frame-occlusion', '___1vvhwjq'] })] : []))
const macOwnTile = (name: string, talking = false): AxNode => node('AXMenuItem', { d: `Myself video, ${name}, ${PRODUCTION}, Unmuted, Has context menu` },
  node('AXGroup', { c: ['fui-Primitive', '___19sw0rl'] }), node('AXStaticText', { v: name }),
  ...(talking ? [node('AXGroup', { c: ['fui-Flex', 'vdi-frame-occlusion', '___1vvhwjq'] })] : []))
const macSharing = win(node('AXWindow', { s: 'AXDialog', t: 'Window' }, node('AXButton', { i: 'WindowSharingSessionButton' })), 'Window')
const macStage = (tiles: AxNode[]) => win(node('AXWindow', { t: 'Weekly review | Microsoft Teams' },
  node('AXGroup', { c: ['BrowserRootView'] }, node('AXWebArea', { t: 'Weekly review | Microsoft Teams' },
    node('AXToolbar', {}, node('AXButton', { i: 'roster-button', d: 'People' }), node('AXButton', { i: 'hangup-button', d: 'Leave' })),
    node('AXGroup', {}, ...tiles)))), 'Weekly review | Microsoft Teams')

describe("Teams' talking mark on a Mac (#138)", () => {
  it('reads the empty frame group from AXDOMClassList as talking, and knows my own "Myself video" tile', () => {
    const r = readCall('teams', [macSharing, macStage([macOwnTile('Alex Morgan'), macTile('Dana Smith', true), macTile('Ann Lee', false)])])
    expect(r).toEqual({ speaking: ['Dana Smith'], participants: ['Alex Morgan', 'Dana Smith', 'Ann Lee'], me: 'Alex Morgan' })
  })
  it('the window-sharing dialog listed first gives nobody and never hides the call window', () => {
    expect(readCall('teams', [macSharing])).toEqual({ speaking: [], participants: [], me: null })
    expect(readCall('teams', [macSharing, macStage([macTile('Ann Lee', true)])]).speaking).toEqual(['Ann Lee'])
  })
  it('with several tiles marked at once (background noise), the line goes to nobody', () => {
    const samples = [0, 500, 1000, 1500].map((ms) => ({ ms, ...readCall('teams', [macStage([macOwnTile('Alex Morgan'), macTile('Dana Smith', true), macTile('Ann Lee', true)])]) }))
    expect(nameFor({ startMs: 0, endMs: 2000 }, samples)).toBeNull()
  })
  it('my own tile lit while I talk names nobody on the other side', () => {
    const samples = [0, 500, 1000, 1500].map((ms) => ({ ms, ...readCall('teams', [macStage([macOwnTile('Alex Morgan', true), macTile('Dana Smith', false), macTile('Ann Lee', false)])]) }))
    expect(nameFor({ startMs: 0, endMs: 2000 }, samples)).toBeNull()
  })
  it('one other person lit names their line', () => {
    const samples = [0, 500, 1000, 1500].map((ms) => ({ ms, ...readCall('teams', [macStage([macOwnTile('Alex Morgan'), macTile('Dana Smith', ms < 1500), macTile('Ann Lee', false)])]) }))
    expect(nameFor({ startMs: 0, endMs: 2000 }, samples)).toBe('Dana Smith')
  })
})

describe('summarize: a short picture of the tree for the log', () => {
  it("counts roles and shows ids, classes and the app's own words, never a name or anything said", () => {
    const captions = node('AXGroup', { i: 'captions' }, node('AXStaticText', { v: 'we can sign the renewal with Acme on Friday' }))
    const s = summarize([zoomWindow(['Dana Smith, Computer audio unmuted, Active speaker'], ['Alex Morgan (me)'], [captions])], 40)
    expect(s.split('\n')[0]).toMatch(/^roles: .*AXWindow=1 .*AXTabGroup=1/)
    expect(s).toContain('AXTabGroup "‹10›, Computer audio unmuted, Active speaker"')
    expect(s).toContain('AXButton#audio')
    expect(s).toContain('AXOutline "Participants list"')
    expect(s).toContain('AXGroup#captions')
    for (const secret of ['Dana', 'Alex', 'renewal', 'Acme', 'Friday']) expect(s).not.toContain(secret)
  })
  it('keeps at most max lines, and a window title only as words the app owns', () => {
    const s = summarize([win(node('AXWindow', {}, node('AXButton', { d: 'Leave' }), node('AXStaticText', { v: 'Budget review' })), 'Meet - abc-defg-hij')], 2)
    expect(s.split('\n')).toHaveLength(3)
    expect(s).toContain('window "Meet - ‹12›"')
    expect(s).not.toContain('abc-defg-hij')
  })
  it('says which windows are minimised, so a call hidden in one shows in the log (#138)', () => {
    const s = summarize([{ ...win(node('AXWindow', {}), 'Microsoft Teams'), minimized: true }, win(node('AXWindow', {}), 'Microsoft Teams')])
    expect(s).toContain('window "Microsoft Teams" minimized')
    expect(s.split('\n').filter((l) => l.startsWith('window ') && !l.includes('minimized'))).toHaveLength(1)
  })
})
