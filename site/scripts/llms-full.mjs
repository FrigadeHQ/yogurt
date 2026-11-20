import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import faq from '../content/faq.json' with { type: 'json' }
import releases from '../content/updates.json' with { type: 'json' }

export function fullGuide() {
  const shortGuide = readFileSync(join(process.cwd(), 'public/llms.txt'), 'utf8')
  let overview = shortGuide.split('\n## Website\n')[0].trimEnd()
  // A site-only checkout still contains the README facts in the short guide.
  try {
    const readme = readFileSync(join(process.cwd(), '../README.md'), 'utf8')
    const features = readme.split('\n## What it does\n')[1]?.split('\n## ')[0].trim()
    if (features) overview = overview.replace(/^What it does: .+$/m, () =>
      '## Features\n\n' + features.replaceAll('**', ''))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const questions = faq.map(({ question, answer }) => question + '\n' + answer)
  const updates = releases.slice(0, 5).map(({ version, published, headline, changes }) =>
    [`${version} · ${published.slice(0, 10)} · ${headline}`, ...changes.map(line => '- ' + line),
      'https://yogurt.so/updates#' + version].join('\n'))
  return [overview, '## Frequently asked questions', ...questions, '## Latest releases', ...updates].join('\n\n')
    .replaceAll('\u00a0', ' ') + '\n'
}
