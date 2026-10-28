// The JSON-LD in each page's head: who makes yokoten, what it is, and what this page is, so a search
// engine or an agent reads the facts without scraping. The version, Node.js range and licence come
// from the package (version.json); the home page adds its questions as an FAQ.
import { LINKS, version } from '../content/facts';
import { LANG_INFO, type Lang, type Page } from '../i18n';

const SITE = 'https://yokoten.app';
// The project's one public place to ask for help is its GitHub issues: no email, phone or address.
const ORG = { '@id': 'https://github.com/yokoten-labs#org' };
const APP = { '@id': `${SITE}/#app` };

/** Copy without its inline Markdown: code ticks, bold and links. */
const plain = (text: string) => text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|`/g, '');

export interface Question { q: string; a: string }

export function structuredData(o: { page: Page | '404'; lang: Lang; url: string; title: string; description: string; homeUrl: string; questions?: Question[] }): string {
  const inLanguage = LANG_INFO[o.lang].html;
  const graph: object[] = [
    {
      '@type': 'Organization',
      ...ORG,
      name: 'yokoten-labs',
      url: 'https://github.com/yokoten-labs',
      description: 'The open source project behind yokoten: one set of rules that every AI coding agent follows.',
      contactPoint: { '@type': 'ContactPoint', contactType: 'customer support', url: `${LINKS.github}/issues` },
    },
    {
      '@type': 'SoftwareApplication',
      ...APP,
      name: 'yokoten',
      alternateName: '横展',
      url: o.homeUrl,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Linux, macOS, Windows',
      softwareVersion: version.version,
      softwareRequirements: `Node.js ${version.node}`,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      license: `https://opensource.org/licenses/${version.license}`,
      codeRepository: LINKS.github,
      sameAs: [LINKS.github, LINKS.npm],
      author: ORG,
      publisher: ORG,
      inLanguage,
    },
  ];
  if (o.page !== '404') {
    const type = o.page === 'about' ? 'AboutPage' : o.page === 'home' && o.questions ? ['WebPage', 'FAQPage'] : 'WebPage';
    graph.push({
      '@type': type,
      '@id': o.url,
      url: o.url,
      name: o.title,
      description: o.description,
      inLanguage,
      about: APP,
      ...(o.questions ? { mainEntity: o.questions.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: plain(x.a) } })) } : {}),
    });
  }
  // `<` is escaped so no text can close the script element.
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
}
