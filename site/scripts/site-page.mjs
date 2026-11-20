import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const content = name => readFileSync(join(process.cwd(), 'content', name), 'utf8')

export function sitePage({ path, title, description, body, modules }) {
  const home = path === '/'
  const fields = {
    Path: path, Home: home ? '' : '/', Title: title, Description: description, Content: body,
    Hero: home ? 'data-hero-entry="pending"' : '',
    Body: home ? 'data-background="ribbon" data-demo="transcript" data-letter="plain" data-motion="flow" data-source="sample"' : '',
    Styles: home ? '' : '<link rel="stylesheet" href="/marketing/updates.css"/>',
    Modules: modules.map(name => `<script type="module" src="/marketing/${name}.mjs"></script>`).join('\n'),
  }
  return content('shell.html').replace(/\{\{page(\w+)\}\}/g, (_, key) => fields[key])
}

export function homePage() {
  return sitePage({
    path: '/',
    title: 'Yogurt · AI meeting notes that stay on your computer',
    description: 'Yogurt takes meeting notes with AI that runs locally on Mac, Windows and Linux. No bot joins the call. Free and open source.',
    body: content('home.html'),
    modules: ['demo-video', 'hero-entry', 'hero-transcript', 'ribbons', 'walkthrough', 'reserve', 'features', 'activity'],
  })
}
