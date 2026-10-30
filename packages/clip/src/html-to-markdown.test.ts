import { describe, expect, it } from 'vitest';
import { fromHtml } from 'hast-util-from-html';
import { htmlToMarkdown, type Node } from './html-to-markdown.js';

// The output itself is pinned by the ENML converter's tests in `@unbent/enex`, which run
// through this module; these cover what is particular to it as an entry point.
describe('htmlToMarkdown', () => {
  it('converts a fragment given as a string', () => {
    expect(htmlToMarkdown('<h2>Notes</h2><p>Some <b>bold</b> text</p>')).toBe('## Notes\n\nSome **bold** text');
  });

  it('converts a tree the caller already parsed', () => {
    const tree = fromHtml('<p>From a tree</p>', { fragment: true });
    expect(htmlToMarkdown(tree)).toBe('From a tree');
  });

  it('strips styling and makes line divs paragraphs', () => {
    expect(
      htmlToMarkdown('<div style="color:red" class="x"><span>one</span></div><div><font>two</font></div>'),
    ).toBe('one\n\ntwo');
  });

  it('runs the caller’s transforms before the cleaning ones', () => {
    const seen: string[] = [];
    const out = htmlToMarkdown('<a class="keep" href="https://example.com/">Acme</a>', {
      transforms: [
        (tree: Node) => {
          const a = tree.children![0]!;
          // The class is still there: stripPresentation has not run yet.
          seen.push(String((a.properties!['className'] as string[]).join(' ')));
        },
      ],
    });
    expect(seen).toEqual(['keep']);
    expect(out).toBe('[Acme](https://example.com/)');
  });
});
