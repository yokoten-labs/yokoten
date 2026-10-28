// The two marks a text field may hold: `code` and [a link](url). Everything else is escaped.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function inline(text: string): string {
  return text
    .split(/(`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g)
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return `<code>${esc(part.slice(1, -1))}</code>`;
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
      if (link) {
        const [, words, url] = link;
        const outside = /^https?:/.test(url);
        return `<a href="${esc(url)}"${outside ? ' rel="noopener"' : ''}>${inline(words)}</a>`;
      }
      return esc(part);
    })
    .join('');
}
