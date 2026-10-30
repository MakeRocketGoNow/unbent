import { describe, expect, it } from 'vitest';
import { extractArticle } from './extract.js';
import { ARTICLE_PAGE, LINKS_PAGE, PARAGRAPHS, RELATIVE_PAGE } from './test-pages.js';

const URL_ = 'https://www.example.com/guides/anvil-care';

describe('extractArticle', () => {
  it('keeps the article and leaves the chrome around it', () => {
    const article = extractArticle(ARTICLE_PAGE, URL_)!;
    expect(article).not.toBeNull();
    for (const p of PARAGRAPHS) expect(article.contentHtml).toContain(p.slice(0, 60));
    for (const chrome of ['Shop the catalogue', 'Popular this week', 'Subscribe', 'Copyright', 'analytics']) {
      expect(article.contentHtml).not.toContain(chrome);
    }
  });

  it('reads the page’s metadata', () => {
    const article = extractArticle(ARTICLE_PAGE, URL_)!;
    expect(article.title).toBe('Caring for your anvil');
    expect(article.byline).toBe('By Pat Example');
    expect(article.siteName).toBe('Acme Workshop');
    expect(article.excerpt).toBe("How to keep an anvil's face true for decades.");
    expect(article.lang).toBe('en-GB');
  });

  it('takes the site’s name off the title only beside a separator', () => {
    const titled = (title: string) =>
      extractArticle(ARTICLE_PAGE.replace(/<title>.*<\/title>/, `<title>${title}</title>`), URL_)!.title;
    expect(titled('Acme Workshop | Caring for your anvil')).toBe('Caring for your anvil');
    expect(titled('Caring for your anvil \u2013 Acme Workshop')).toBe('Caring for your anvil');
    expect(titled('Anvils at Acme Workshop')).toBe('Anvils at Acme Workshop');
    expect(titled('Acme Workshop')).toBe('Acme Workshop');
  });

  it('falls back to the host for a site with no name', () => {
    const article = extractArticle(RELATIVE_PAGE, URL_)!;
    expect(article.siteName).toBe('example.com');
    expect(article.byline).toBeNull();
    expect(article.lang).toBeNull();
  });

  it('answers null for a page with no article', () => {
    expect(extractArticle(LINKS_PAGE, URL_)).toBeNull();
    expect(extractArticle('<html><body></body></html>', URL_)).toBeNull();
  });

  it('makes relative links and pictures absolute', () => {
    const { contentHtml } = extractArticle(RELATIVE_PAGE, 'https://example.com/guides/welding/steps.html')!;
    expect(contentHtml).toContain('src="https://example.com/guides/welding/images/scarf-joint.jpg"');
    expect(contentHtml).toContain('src="https://example.com/media/heat-colours.png"');
    expect(contentHtml).toContain('href="https://example.com/guides/flux.html"');
  });

  it('resolves against a relative <base>', () => {
    const page = RELATIVE_PAGE.replace('<head>', '<head><base href="/archive/2024/">');
    const { contentHtml } = extractArticle(page, 'https://example.com/guides/welding/steps.html')!;
    expect(contentHtml).toContain('src="https://example.com/archive/2024/images/scarf-joint.jpg"');
    expect(contentHtml).toContain('href="https://example.com/archive/flux.html"');
  });

  it('leaves the real global alone', () => {
    extractArticle(ARTICLE_PAGE, URL_);
    expect((globalThis as { location?: unknown }).location).toBeUndefined();
  });
});
