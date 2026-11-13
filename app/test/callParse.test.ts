import { describe, expect, it } from 'vitest'
import { readCall, summarize, zoomLinuxTile, zoomTile, type AxNode, type AxWindow } from '../src/main/callNames/parse'

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

describe('summarize: a short picture of the tree for the log', () => {
  it('counts roles and shows the first texts, with ids and classes', () => {
    const s = summarize([zoomWindow(['Dana Smith, Computer audio unmuted, Active speaker'])], 4)
    expect(s.split('\n')[0]).toMatch(/^roles: AXWindow=1 .*AXTabGroup=1/)
    expect(s).toContain('AXTabGroup "Dana Smith, Computer audio unmuted, Active speaker"')
    expect(s.split('\n')).toHaveLength(5)
  })
})
