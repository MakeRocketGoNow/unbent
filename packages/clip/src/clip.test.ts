import { describe, expect, it } from 'vitest';
import { clipFragment, clipPage } from './clip.js';
import { ARTICLE_PAGE, LINKS_PAGE, PARAGRAPHS, RELATIVE_PAGE } from './test-pages.js';

const PAGE_URL = 'https://www.example.com/guides/anvil-care';

/** The body after the source line. */
const article = (markdown: string) => markdown.split('\n\n').slice(1).join('\n\n');

const fragment = (html: string, opts?: { maxImages?: number }) =>
  clipFragment(html, 'https://example.com/guides/welding/steps.html', { title: 'Forge welding' }, opts);

describe('clipPage', () => {
  it('keeps only the article of a page with chrome around it', () => {
    const clip = clipPage(ARTICLE_PAGE, PAGE_URL);
    expect(clip.title).toBe('Caring for your anvil');
    expect(article(clip.markdown)).toBe(
      [
        PARAGRAPHS[0],
        `${PARAGRAPHS[1]} See [dressing the edges](https://www.example.com/guides/dressing-edges) for the method.`,
        PARAGRAPHS[2],
      ].join('\n\n'),
    );
    for (const chrome of ['Shop the catalogue', 'Popular this week', 'Subscribe', 'Copyright', 'analytics', 'float']) {
      expect(clip.markdown).not.toContain(chrome);
    }
    expect(clip.source).toEqual({ url: PAGE_URL, siteName: 'Acme Workshop', byline: 'By Pat Example' });
  });

  it('opens with the source line, with the byline when there is one', () => {
    const clip = clipPage(ARTICLE_PAGE, PAGE_URL);
    expect(clip.markdown.split('\n')[0]).toBe(`Clipped from [Acme Workshop](${PAGE_URL}), by Pat Example`);
    expect(clip.markdown.split('\n')[1]).toBe('');
  });

  it('names the host in the source line when the site has no name, and no byline', () => {
    const clip = clipPage(RELATIVE_PAGE, 'https://www.example.com/guides/welding/steps.html');
    expect(clip.markdown.split('\n')[0]).toBe(
      'Clipped from [example.com](https://www.example.com/guides/welding/steps.html)',
    );
    expect(clip.source.byline).toBeNull();
  });

  it('does not repeat the title in the body', () => {
    const clip = clipPage(ARTICLE_PAGE, PAGE_URL);
    expect(article(clip.markdown)).not.toMatch(/^#+ Caring for your anvil/m);
  });

  it('makes relative links absolute and pictures files', () => {
    const clip = clipPage(RELATIVE_PAGE, 'https://example.com/guides/welding/steps.html');
    expect(clip.markdown).toContain('[notes on flux](https://example.com/guides/flux.html)');
    expect(clip.markdown).toContain('![A scarf joint ready to weld](files/scarf-joint.jpg)');
    expect(clip.markdown).toContain('![Heat colours chart](files/heat-colours.png)');
    expect(clip.images).toEqual([
      {
        url: 'https://example.com/guides/welding/images/scarf-joint.jpg',
        path: 'files/scarf-joint.jpg',
        filename: 'scarf-joint.jpg',
        alt: 'A scarf joint ready to weld',
      },
      {
        url: 'https://example.com/media/heat-colours.png',
        path: 'files/heat-colours.png',
        filename: 'heat-colours.png',
        alt: 'Heat colours chart',
      },
    ]);
  });

  it('falls back to the whole page, less its chrome, when there is no article', () => {
    const clip = clipPage(LINKS_PAGE, 'https://example.com/');
    expect(clip.title).toBe('Acme Workshop');
    expect(clip.markdown).toContain('## Latest guides');
    expect(clip.markdown).toContain('[Caring for your anvil](https://example.com/guides/anvil)');
    expect(clip.markdown).toContain('Open Tuesday to Saturday.');
    for (const chrome of ['Shop the catalogue', 'Copyright']) expect(clip.markdown).not.toContain(chrome);
    expect(clip.source).toEqual({ url: 'https://example.com/', siteName: 'example.com', byline: null });
  });

  it('drops a title heading from the fallback too, and reads the page’s <base>', () => {
    const page = `<html><head><title>Opening hours - Acme Workshop</title>
      <meta property="og:site_name" content="Acme Workshop"><base href="/shop/"></head>
      <body><h1>Opening hours</h1><p>Tuesday to Saturday, <a href="hours.html">all week</a>.</p>
      <script>track()</script><noscript>Enable scripts</noscript></body></html>`;
    const clip = clipPage(page, 'https://example.com/visit');
    expect(clip.title).toBe('Opening hours');
    expect(clip.markdown).toBe(
      'Clipped from [Acme Workshop](https://example.com/visit)\n\n' +
        'Tuesday to Saturday, [all week](https://example.com/shop/hours.html).',
    );
  });
});

describe('clipFragment', () => {
  it('uses the given title and site name, falling back to the host', () => {
    const named = clipFragment('<p>Hi</p>', 'https://example.com/a', { title: ' Notes ', siteName: 'Acme', byline: 'Pat' });
    expect(named.title).toBe('Notes');
    expect(named.markdown).toBe('Clipped from [Acme](https://example.com/a), by Pat\n\nHi');
    expect(fragment('<p>Hi</p>').markdown.split('\n')[0]).toBe(
      'Clipped from [example.com](https://example.com/guides/welding/steps.html)',
    );
  });

  it('drops HTML comments rather than writing them through as raw HTML', () => {
    expect(
      article(fragment('<!--StartFragment--><p>Hi<!-- a template note --></p><!--EndFragment-->').markdown),
    ).toBe('Hi');
  });

  it('drops a leading heading that repeats the title, and only that one', () => {
    expect(article(fragment('<div><h1>Forge  welding</h1><p>Body</p></div>').markdown)).toBe('Body');
    expect(article(fragment('<h1>Forge welding, part two</h1><p>Body</p>').markdown)).toBe(
      '# Forge welding, part two\n\nBody',
    );
    expect(article(fragment('<p>Intro</p><h2>Forge welding</h2>').markdown)).toBe('Intro\n\n## Forge welding');
  });

  it('fetches a picture used twice once', () => {
    const clip = fragment('<p><img src="a.png" alt="first"></p><p><img src="./a.png" alt="again"></p>');
    expect(clip.images).toHaveLength(1);
    expect(article(clip.markdown)).toBe('![first](files/a.png)\n\n![again](files/a.png)');
  });

  it('gives two pictures with one name two files', () => {
    const clip = fragment('<img src="/one/photo.jpg"><img src="/two/photo.jpg"><img src="/three/photo.jpg">');
    expect(clip.images.map((i) => i.filename)).toEqual(['photo.jpg', 'photo-2.jpg', 'photo-3.jpg']);
  });

  it('keeps pictures past the cap as absolute addresses, unlisted', () => {
    const clip = fragment('<img src="1.png"><img src="2.png"><img src="3.png"><img src="1.png">', { maxImages: 2 });
    expect(clip.images.map((i) => i.filename)).toEqual(['1.png', '2.png']);
    expect(article(clip.markdown)).toBe(
      '![](files/1.png)![](files/2.png)![](https://example.com/guides/welding/3.png)![](files/1.png)',
    );
  });

  it('keeps twelve pictures by default', () => {
    const html = Array.from({ length: 14 }, (_, i) => `<img src="p${i}.png">`).join('');
    expect(fragment(html).images).toHaveLength(12);
  });

  it('drops tracking pixels, data URIs and pictures with no address', () => {
    const clip = fragment(
      '<p>Text</p>' +
        '<img src="https://tracker.example.net/p.gif" width="1" height="1">' +
        '<img src="/pixel.gif" height="0">' +
        '<img src="data:image/png;base64,iVBORw0KGgo=">' +
        '<img src="">' +
        '<img>',
    );
    expect(clip.images).toEqual([]);
    expect(article(clip.markdown)).toBe('Text');
  });

  it('takes a picture from srcset when src is missing or a placeholder', () => {
    const missing = fragment('<img srcset="small.jpg 300w, large.jpg 1200w" alt="a">');
    expect(missing.images[0]!.url).toBe('https://example.com/guides/welding/small.jpg');

    const placeholder = fragment(
      '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" srcset="small.jpg 300w, large.jpg 1200w, mid.jpg 800w">',
    );
    expect(placeholder.images[0]!.url).toBe('https://example.com/guides/welding/large.jpg');

    const dense = fragment('<img src="data:," srcset="a.jpg, b.jpg 3x, c.jpg 2x">');
    expect(dense.images[0]!.url).toBe('https://example.com/guides/welding/b.jpg');

    const cdn = fragment('<img srcset="/w_300,h_200/photo.jpg 300w, /w_900,h_600/photo.jpg 900w">');
    expect(cdn.images[0]!.url).toBe('https://example.com/w_300,h_200/photo.jpg');

    const real = fragment('<img src="real.jpg" srcset="other.jpg 2x">');
    expect(real.images[0]!.url).toBe('https://example.com/guides/welding/real.jpg');
    expect(article(real.markdown)).toBe('![](files/real.jpg)');
  });

  it('names pictures from their address, keeping only picture extensions', () => {
    const names = fragment(
      [
        '<img src="/a/My%20Photo.JPG">',
        '<img src="/render.php?id=7">',
        '<img src="/images/">',
        '<img src="/b/.hidden.png">',
        '<img src="/c/chart.webp?v=2">',
      ].join(''),
    ).images.map((i) => i.filename);
    expect(names).toEqual(['My Photo.JPG', 'render', 'image-3', 'hidden.png', 'chart.webp']);
  });

  it('keeps the text of a javascript: link and drops the link', () => {
    expect(article(fragment('<p><a href="javascript:void(0)">Show more</a> and <a href="#notes">notes</a></p>').markdown)).toBe(
      'Show more and [notes](https://example.com/guides/welding/steps.html#notes)',
    );
  });

  it('leaves the site’s markup behind', () => {
    expect(article(fragment('<div class="x" style="color:red"><span>one</span></div><div>two</div>').markdown)).toBe(
      'one\n\ntwo',
    );
  });
});
