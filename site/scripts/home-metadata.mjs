import faq from '../content/faq.json' with { type: 'json' }
import { platforms, release } from '../public/marketing/downloads.mjs'

function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

export function faqCards() {
  return faq.map(({ id, question, answer }) => `<details name="yogurt-faq" id="${escapeHtml(id)}">
      <summary>${escapeHtml(question)}<span class="tour-plus" aria-hidden="true"></span></summary>
      <div class="faq-answer"><p>${escapeHtml(answer)}</p></div>
    </details>`).join('\n    ')
}

export function homeStructuredData(description, version) {
  const organization = { '@type': 'Organization', '@id': 'https://frigade.com/#organization', name: 'Frigade', url: 'https://frigade.com/' }
  const maker = { '@id': organization['@id'] }
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication', name: 'Yogurt', description, url: 'https://yogurt.so/',
        operatingSystem: ['macOS', 'Windows', 'Linux'], applicationCategory: 'BusinessApplication',
        offers: { '@type': 'Offer', price: 0, priceCurrency: 'USD' },
        downloadUrl: Object.values(platforms).map(platform => release + platform.file),
        softwareVersion: version,
        license: { '@type': 'CreativeWork', name: 'MIT License', url: 'https://github.com/FrigadeHQ/yogurt/blob/main/LICENSE' },
        author: maker, publisher: maker,
      },
      {
        '@type': 'FAQPage', '@id': 'https://yogurt.so/#questions',
        mainEntity: faq.map(({ question, answer }) => ({
          '@type': 'Question', name: question,
          acceptedAnswer: { '@type': 'Answer', text: answer },
        })),
      },
      organization,
    ],
  }
  return '<script type="application/ld+json">' + JSON.stringify(data).replaceAll('<', '\\u003c') + '</script>'
}
