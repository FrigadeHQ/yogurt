import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { faqCards, homeStructuredData } from './home-metadata.mjs'
import releases from '../content/updates.json' with { type: 'json' }

const content = name => readFileSync(join(process.cwd(), 'content', name), 'utf8')

export function sitePage({ path, title, description, body, modules, structuredData = '' }) {
  const home = path === '/'
  const fields = {
    Path: path, Home: home ? '' : '/', Title: title, Description: description, Content: body,
    StructuredData: structuredData,
    Hero: home ? 'data-hero-entry="pending"' : '',
    Body: home ? 'data-background="ribbon" data-demo="transcript" data-letter="plain" data-motion="flow" data-source="sample"' : 'class="reading-shell"',
    Styles: home ? '' : `<link rel="preload" as="font" type="font/ttf" href="/marketing/assets/bricolage-grotesque.ttf" crossorigin/><link rel="stylesheet" href="/marketing${path}.css"/>`,
    Modules: modules.map(name => `<script type="module" src="/marketing/${name}.mjs"></script>`).join('\n'),
  }
  return content('shell.html').replace(/\{\{page(\w+)\}\}/g, (_, key) => fields[key])
}

export function pageHeader(title) {
  return `<header class="page-header"><h1>${title}</h1></header>`
}

export function homePage() {
  const description = 'Yogurt takes meeting notes with AI that runs locally on Mac, Windows and Linux. No bot joins the call. Free and open source.'
  return sitePage({
    path: '/',
    title: 'Yogurt · AI meeting notes that stay on your computer',
    description,
    structuredData: homeStructuredData(description, releases[0].version),
    body: content('home.html').replace('{{homeFaq}}', faqCards),
    modules: ['demo-video', 'hero-entry', 'hero-transcript', 'ribbons', 'walkthrough', 'reserve', 'features', 'activity'],
  })
}
