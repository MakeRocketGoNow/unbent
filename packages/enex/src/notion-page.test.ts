import { describe, expect, it } from 'vitest';
import { parseNotionPage, rewriteNotionBody, type RewriteContext } from './notion-page.js';

describe('parseNotionPage', () => {
  const known = new Set(['Date', 'Rating', 'Notes', 'Shop']);

  it('reads the title, the property block, and the body', () => {
    const page = parseNotionPage(
      '# Almond Latte\n\nDate: August 2, 2026\nRating: ★\nShop: Red Door\n\nToo sweet.\n\nTry oat milk.\n',
      known,
    );
    expect(page.title).toBe('Almond Latte');
    expect(page.props).toEqual([
      ['Date', 'August 2, 2026'],
      ['Rating', '★'],
      ['Shop', 'Red Door'],
    ]);
    expect(page.body).toBe('Too sweet.\n\nTry oat milk.');
  });

  it('continues a property across lines, and drops a key the columns do not name', () => {
    const page = parseNotionPage(
      '# Ride\n\nDate: August 22, 2026\nNotes: Creaking from the fork.\nBonked early.\nDiscount Applied: Full Price\nShop: Loft\n\nBody.',
      known,
    );
    expect(page.props).toEqual([
      ['Date', 'August 22, 2026'],
      ['Notes', 'Creaking from the fork.\nBonked early.'],
      ['Shop', 'Loft'],
    ]);
    expect(page.body).toBe('Body.');
  });

  it('reads a key that holds a colon, and the longer of two keys that share a start', () => {
    const page = parseNotionPage(
      '# Sensor\n\nTags: Smart Home, Health\nuserDefined:URL: https://x.test/a?b=1\nDate Added: May 26, 2026 8:15 AM\nDate: May 1, 2026\n\nBody.',
      new Set(['Tags', 'userDefined:URL', 'Date', 'Date Added']),
    );
    expect(page.props).toEqual([
      ['Tags', 'Smart Home, Health'],
      ['userDefined:URL', 'https://x.test/a?b=1'],
      ['Date Added', 'May 26, 2026 8:15 AM'],
      ['Date', 'May 1, 2026'],
    ]);
  });

  it('reads a page with no properties, and one with no title', () => {
    expect(parseNotionPage('# Torque Specs\n\nAll from the manual.\n\n| a | b |\n', new Set())).toEqual({
      title: 'Torque Specs',
      props: [],
      body: 'All from the manual.\n\n| a | b |',
    });
    expect(parseNotionPage('# Untitled\n', known)).toEqual({ title: 'Untitled', props: [], body: '' });
    expect(parseNotionPage('Just text', known)).toEqual({ title: '', props: [], body: 'Just text' });
    // A body whose first line happens to look like a property is still the body when no
    // column is named that way.
    expect(parseNotionPage('# T\n\nNote: not a property\n\nMore.', known).body).toBe('Note: not a property\n\nMore.');
  });
});

describe('rewriteNotionBody', () => {
  const ctx: RewriteContext = {
    resolve: (path) => {
      if (path === 'Almond Latte/image.png') return { kind: 'file', name: 'image.png' };
      if (path === 'Almond Latte/Menu (2).pdf') return { kind: 'file', name: 'Menu (2).pdf' };
      if (path === 'Home/My Tasks 3ffec446e5004ef1b520ac05b60b8a13.md') return { kind: 'page', href: '/notes/3ffec446-e500-4ef1-b520-ac05b60b8a13' };
      if (path === 'Home/Untitled a395584f8291486999819760f5851cce_all.csv') return { kind: 'database' };
      return null;
    },
    page: (id) => (id === '355353deeb70817f8372da5cd364f645' ? '/notes/355353de-eb70-817f-8372-da5cd364f645' : null),
  };

  it('points attachments at files/, bracketing a name with spaces, and drops the caption under a file', () => {
    const body =
      '![image.png](Almond%20Latte/image.png)\n\n[Menu (2).pdf](Almond%20Latte/Menu%20(2).pdf)\nMenu (2).pdf\n\nAfter.';
    expect(rewriteNotionBody(body, ctx)).toBe(
      '![image.png](files/image.png)\n\n[Menu (2).pdf](<files/Menu (2).pdf>)\n\nAfter.',
    );
  });

  it('links a sub-page to its note, flattens a database link to its name, and leaves the unknown alone', () => {
    const body =
      '[My Tasks](Home/My%20Tasks%203ffec446e5004ef1b520ac05b60b8a13.md)\n\n[Untitled](Home/Untitled%20a395584f8291486999819760f5851cce_all.csv)\n\n[Gone view](Gone%200000000000000000000000000000dead_all.csv)\n\n[gone](Home/Missing%20deadbeef.md)\n\n[web](https://example.test/x)\n\n[anchor](#top)';
    expect(rewriteNotionBody(body, ctx)).toBe(
      '[My Tasks](/notes/3ffec446-e500-4ef1-b520-ac05b60b8a13)\n\nUntitled\n\nGone view\n\n[gone](Home/Missing%20deadbeef.md)\n\n[web](https://example.test/x)\n\n[anchor](#top)',
    );
  });

  it('rewrites a notion.so link to an imported page and keeps one to anything else', () => {
    const body =
      '[Profile](https://www.notion.so/Movie-Viewer-Profile-355353deeb70817f8372da5cd364f645)\n[Bare](https://www.notion.so/355353deeb70817f8372da5cd364f645?pvs=4)\n[Other](https://www.notion.so/Elsewhere-0123456789abcdef0123456789abcdef)';
    expect(rewriteNotionBody(body, ctx)).toBe(
      '[Profile](/notes/355353de-eb70-817f-8372-da5cd364f645)\n[Bare](/notes/355353de-eb70-817f-8372-da5cd364f645)\n[Other](https://www.notion.so/Elsewhere-0123456789abcdef0123456789abcdef)',
    );
  });

  it('turns a callout into a quote, joining the icon to the first line and dropping icon images', () => {
    const body =
      'Before.\n\n<aside>\n🔪\n\nContains violence.\n\nSecond paragraph.\n\n</aside>\n\n<aside>\n<img src="https://app.notion.com/icons/notion_gray.svg" alt="x" width="40px" />\n\nConfigured as a Tasks database.\n\n</aside>\n\nAfter.';
    expect(rewriteNotionBody(body, ctx)).toBe(
      'Before.\n\n> 🔪 Contains violence.\n>\n> Second paragraph.\n\n> Configured as a Tasks database.\n\nAfter.',
    );
  });
});
