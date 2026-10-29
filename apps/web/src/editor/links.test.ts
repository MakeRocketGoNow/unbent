import { describe, expect, it } from 'vitest';
import { markdownState, relinkWebImageChanges, removalRange, removeAttachmentLinkChanges, rewriteText, webImageUrls } from './links.js';

/**
 * The editor's rewrites of a note's attachment links, on a headless state: what the
 * attachments panel and "Save web images" apply to the open editor, or to the body when
 * no editor is mounted.
 */
const remove = (text: string, filename: string) =>
  rewriteText(text, (state) => removeAttachmentLinkChanges(state, filename));

describe('removing a file\'s links', () => {
  it('removes the matching link and leaves neighbours', () => {
    expect(remove('Before [keep](files/keep.pdf) [gone](files/gone.pdf) after', 'gone.pdf')).toBe(
      'Before [keep](files/keep.pdf)  after',
    );
  });

  it('removes angle-bracket, percent-encoded, escaped and balanced forms', () => {
    expect(remove('![x](<files/my photo.png>)', 'my photo.png')).toBe('');
    expect(remove('a ![x](files/caf%C3%A9.png) b', 'café.png')).toBe('a  b');
    expect(remove('[r](files/Report\\(R\\).pdf) and [r](files/Report(R).pdf) [k](files/Report.pdf)', 'Report(R).pdf')).toBe(
      ' and  [k](files/Report.pdf)',
    );
  });

  it('takes a link that is a paragraph of its own out with the line and one gap', () => {
    expect(remove('a\n\n![x](files/x.png)\n\nb', 'x.png')).toBe('a\n\nb');
    expect(remove('![x](files/x.png)\n\nb', 'x.png')).toBe('b');
    expect(remove('a\n\n![x](files/x.png)', 'x.png')).toBe('a');
    expect(remove('- [x](files/x.png)\n- b', 'x.png')).toBe('- \n- b');
  });

  it('keeps the paragraph gap when the link shares its paragraph with text', () => {
    expect(remove('text\n![x](files/x.png)\n\nmore', 'x.png')).toBe('text\n\nmore');
    expect(remove('a\n\n![x](files/x.png)\nb', 'x.png')).toBe('a\n\nb');
    expect(remove('- a\n\n  ![x](files/x.png)\n  tail', 'x.png')).toBe('- a\n\n  tail');
    // Two pictures of one file on adjacent lines: each takes its line, neither the gap.
    expect(remove('a\n\n![x](files/x.png)\n![y](files/x.png)\n\nb', 'x.png')).toBe('a\n\n\nb');
  });

  /** The Joplin import wraps a picture in a link; the file goes, the link around it stays. */
  it('removes an image inside a link without eating the outer bracket', () => {
    expect(remove('a [![x](files/a.png)](https://e.com) b', 'a.png')).toBe('a [](https://e.com) b');
  });

  it('takes a picture inside a removed link with its container, once', () => {
    expect(remove('see [![a](files/x.png)](files/y.pdf) end', 'y.pdf')).toBe('see  end');
    expect(remove('see [![a](files/x.png)](files/x.png) end', 'x.png')).toBe('see  end');
  });

  it('reads a link where it lies, so an indented bullet is a link and a code block is not', () => {
    expect(remove('- a\n  - b\n    - [x](files/x.png)', 'x.png')).toBe('- a\n  - b\n    - ');
    const code = 'text\n\n    [x](files/x.png)';
    expect(remove(code, 'x.png')).toBe(code);
  });

  it('changes nothing when the file is not linked', () => {
    const text = '[a](files/a.pdf) and prose';
    expect(remove(text, 'b.pdf')).toBe(text);
  });
});

/** The rule the rich editor's widget Delete shares with the panel's. */
describe('removalRange', () => {
  it('takes the range alone when its line holds other text', () => {
    const doc = markdownState('see [x](files/x.png) here').doc;
    expect(removalRange(doc, 4, 20)).toEqual({ from: 4, to: 20 });
  });

  it('takes the line and one gap only when the line is a paragraph of its own', () => {
    const cut = (text: string, from: number, to: number) => {
      const doc = markdownState(text).doc;
      const range = removalRange(doc, from, to);
      return doc.sliceString(0, range.from) + doc.sliceString(range.to);
    };
    expect(cut('a\n\n![x](files/x.png)\n\nb', 3, 20)).toBe('a\n\nb');
    expect(cut('a\n![x](files/x.png)\n\nb', 2, 19)).toBe('a\n\nb');
    expect(cut('a\n\n![x](files/x.png)', 3, 20)).toBe('a');
  });
});

describe('relinking saved web images', () => {
  const md = [
    '![a](https://cdn.example/a.jpg) and ![again](https://cdn.example/a.jpg "shot")',
    '![b](<http://example.com/pics/b c.png>)',
    '[not an image](https://example.com/x.png) ![local](files/x.png)',
  ].join('\n');

  it('points saved images at their files, keeps titles, and leaves the rest', () => {
    const out = rewriteText(md, (state) =>
      relinkWebImageChanges(state, (url) =>
        url.endsWith('a.jpg') ? 'a.jpg' : url.endsWith('b c.png') ? 'b c-2.png' : null,
      ),
    );
    expect(out).toBe(
      [
        '![a](files/a.jpg) and ![again](files/a.jpg "shot")',
        '![b](<files/b c-2.png>)',
        '[not an image](https://example.com/x.png) ![local](files/x.png)',
      ].join('\n'),
    );
  });

  it('lists each web image once, by the reading the relink uses', () => {
    expect(webImageUrls(markdownState(md))).toEqual([
      'https://cdn.example/a.jpg',
      'http://example.com/pics/b c.png',
    ]);
    // What is fetched is what is looked up: a character reference stays as written.
    const amp = '![a](https://e.com/p?a=1&amp;b=2)';
    const [url] = webImageUrls(markdownState(amp));
    expect(rewriteText(amp, (state) => relinkWebImageChanges(state, (u) => (u === url ? 'p.png' : null)))).toBe(
      '![a](files/p.png)',
    );
  });

  it('keeps a web link a fetch could not replace', () => {
    expect(rewriteText('![a](https://cdn.example/a.jpg)', (s) => relinkWebImageChanges(s, () => null))).toBe(
      '![a](https://cdn.example/a.jpg)',
    );
  });

  it('relinks a picture inside a link without touching the link', () => {
    const out = rewriteText('[![a](https://cdn.example/a.jpg)](https://e.com)', (s) =>
      relinkWebImageChanges(s, () => 'a.jpg'),
    );
    expect(out).toBe('[![a](files/a.jpg)](https://e.com)');
  });
});

describe('a headless state', () => {
  it('parses with the editor\'s grammar', () => {
    expect(markdownState('- [x](files/x.png)').doc.toString()).toBe('- [x](files/x.png)');
  });
});
