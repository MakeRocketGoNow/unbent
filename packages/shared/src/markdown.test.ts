import { describe, expect, it } from 'vitest';
import {
  absoluteAttachmentRefs,
  absolutizeAttachmentLinks,
  attachmentFilenamesInMarkdown,
  attachmentUrl,
  excerptMarkdown,
  findAbsoluteAttachmentLinks,
  formatAttachmentMarkdown,
  localizeImageLinks,
  relativizeAttachmentLinks,
  remoteImageUrls,
  removeAttachmentLinks,
  renderMarkdown,
  snippetParts,
} from './markdown.js';

const NOTE = 'note-123';
const render = (md: string) => renderMarkdown(md, { noteId: NOTE });

describe('formatAttachmentMarkdown', () => {
  it('leaves a simple path unbracketed', () => {
    expect(formatAttachmentMarkdown('Scan.pdf', 'files/Scan.pdf')).toBe(
      '[Scan.pdf](files/Scan.pdf)',
    );
  });

  it('wraps destinations that contain spaces', () => {
    expect(formatAttachmentMarkdown('Treatment Plan.pdf', 'files/Treatment Plan.pdf')).toBe(
      '[Treatment Plan.pdf](<files/Treatment Plan.pdf>)',
    );
  });

  it('prefixes images with !', () => {
    expect(formatAttachmentMarkdown('photo.png', 'files/my photo.png', { image: true })).toBe(
      '![photo.png](<files/my photo.png>)',
    );
  });

  /** Without brackets the whole line is literal text: no link, no PDF viewer. */
  it('produces markdown the renderer can turn into a PDF embed', () => {
    const md = formatAttachmentMarkdown(
      'Principal Software Engineer in Remote _ Careers at US Remote.pdf',
      'files/Principal Software Engineer in Remote _ Careers at US Remote.pdf',
    );
    expect(render(md)).toContain('unbent-pdf');
  });
});

describe('attachmentFilenamesInMarkdown', () => {
  it('collects link and image destinations', () => {
    const md = 'See [a](files/a.pdf) and ![b](files/b.png).';
    expect([...attachmentFilenamesInMarkdown(md)].sort()).toEqual(['a.pdf', 'b.png']);
  });

  it('decodes percent-encoded and angle-bracket destinations', () => {
    const md = '[x](<files/my photo.png>) ![y](files/caf%C3%A9.png)';
    expect(attachmentFilenamesInMarkdown(md)).toEqual(
      new Set(['my photo.png', 'café.png']),
    );
  });

  it('ignores absolute and non-attachment URLs', () => {
    expect(attachmentFilenamesInMarkdown('[x](https://example.com/files/x.pdf)')).toEqual(
      new Set(),
    );
  });

  /**
   * A bracketed destination ends at `>`, not the first `)`. Imported PDFs really are named
   * like this, and the whole name must match the attachment row or the file is wrongly
   * flagged "not linked" while the body renders it fine.
   */
  it('keeps parentheses inside an angle-bracket destination', () => {
    const name = 'SAMPLE INVOICE (ACME) Final Copy.pdf';
    const md = formatAttachmentMarkdown(name, `files/${name}`);
    expect(attachmentFilenamesInMarkdown(md).has(name)).toBe(true);
  });

  it('matches what formatAttachmentMarkdown emits, both link and image', () => {
    const name = 'Report (final) v2.pdf';
    const link = formatAttachmentMarkdown(name, `files/${name}`);
    const image = formatAttachmentMarkdown(name, `files/${name}`, { image: true });
    expect(attachmentFilenamesInMarkdown(`${link}\n\n${image}`)).toEqual(new Set([name]));
  });

  /**
   * The Evernote importer serialises with mdast-util-to-markdown, which backslash-escapes
   * a parenthesis in a bare destination. Valid CommonMark, rendered fine, and until
   * 2026-10-28 read here as `Report\(R\`, so every such file was "Not linked".
   */
  it('reads a backslash-escaped bare destination', () => {
    const md = '[Report(R).pdf](files/Report\\(R\\).pdf)';
    expect(attachmentFilenamesInMarkdown(md)).toEqual(new Set(['Report(R).pdf']));
  });

  /** CommonMark allows a balanced pair bare, and a person may well write one. */
  it('reads balanced parentheses in a bare destination', () => {
    const md = '[r](files/Report(R).pdf) and ![p](files/Scan(2).png)';
    expect(attachmentFilenamesInMarkdown(md)).toEqual(new Set(['Report(R).pdf', 'Scan(2).png']));
  });

  it('reads an escape inside an angle-bracket destination', () => {
    expect(attachmentFilenamesInMarkdown('[x](<files/My Report\\(R\\).pdf>)')).toEqual(
      new Set(['My Report(R).pdf']),
    );
  });
});

describe('removeAttachmentLinks', () => {
  it('removes the matching link and leaves neighbors', () => {
    const md = 'Before [keep](files/keep.pdf) [gone](files/gone.pdf) after';
    expect(removeAttachmentLinks(md, 'gone.pdf')).toBe(
      'Before [keep](files/keep.pdf)  after',
    );
  });

  it('removes angle-bracket and image forms', () => {
    expect(removeAttachmentLinks('![x](<files/my photo.png>)', 'my photo.png')).toBe('');
  });

  it('removes the percent-encoded form', () => {
    expect(removeAttachmentLinks('a ![x](files/caf%C3%A9.png) b', 'café.png')).toBe('a  b');
  });

  /** Deleting an imported file has to take its escaped link with it. */
  it('removes a backslash-escaped and a balanced-parenthesis form', () => {
    const md = '[r](files/Report\\(R\\).pdf)\n\n[r](files/Report(R).pdf)\n\n[keep](files/Report.pdf)';
    expect(removeAttachmentLinks(md, 'Report(R).pdf')).toBe('\n\n[keep](files/Report.pdf)');
  });
});

/**
 * The round trip the clipboard makes: relative links leave a note absolute, so they say
 * which note's file they mean, and come back relative once the file is stored in the
 * destination, under whatever name it got there.
 */
describe('absolutizeAttachmentLinks', () => {
  it('names the note in every same-note link and image', () => {
    const md = 'See [a](files/a.pdf) and ![b](files/b.png).';
    expect(absolutizeAttachmentLinks(md, { noteId: NOTE })).toBe(
      `See [a](/api/notes/${NOTE}/files/a.pdf) and ![b](/api/notes/${NOTE}/files/b.png).`,
    );
  });

  /**
   * A bare `(` would be read as a balanced pair by one parser and an unfinished
   * destination by another; a backslash would be an escape. The brackets make the name
   * one spelling every reader of the body handles, as they already did for a space.
   */
  it('brackets a name with a parenthesis or a backslash', () => {
    expect(formatAttachmentMarkdown('Report(R).pdf', 'files/Report(R).pdf')).toBe(
      '[Report(R).pdf](<files/Report(R).pdf>)',
    );
    expect(formatAttachmentMarkdown('a\\b.pdf', 'files/a\\b.pdf')).toBe('[a\\b.pdf](<files/a\\b.pdf>)');
    expect(formatAttachmentMarkdown('plain.pdf', 'files/plain.pdf')).toBe('[plain.pdf](files/plain.pdf)');
  });

  it('absolutizes a backslash-escaped destination by the name it means', () => {
    expect(
      absolutizeAttachmentLinks('[r](files/Report\\(R\\).pdf)', { noteId: NOTE, origin: 'https://app.example' }),
    ).toBe(`[r](https://app.example/api/notes/${NOTE}/files/Report(R).pdf)`);
  });

  it('encodes a bracketed name and drops the brackets it no longer needs', () => {
    const md = formatAttachmentMarkdown('Report (final) v2.pdf', 'files/Report (final) v2.pdf');
    expect(absolutizeAttachmentLinks(md, { noteId: NOTE, origin: 'https://app.example' })).toBe(
      `[Report (final) v2.pdf](https://app.example/api/notes/${NOTE}/files/Report%20(final)%20v2.pdf)`,
    );
  });

  it('leaves remote links and prose alone', () => {
    const md = 'A [site](https://example.com/files/x.pdf) and files/plain.txt in prose.';
    expect(absolutizeAttachmentLinks(md, { noteId: NOTE })).toBe(md);
  });
});

describe('findAbsoluteAttachmentLinks', () => {
  it('reads the note and decoded filename, with or without an origin', () => {
    const md = `![a](${attachmentUrl('n1', 'my photo.png', 'https://app.example')}) [b](<${attachmentUrl('n2', 'b.pdf')}>)`;
    expect(findAbsoluteAttachmentLinks(md)).toEqual([
      { from: 0, to: md.indexOf(' [b]'), label: '![a]', noteId: 'n1', filename: 'my photo.png' },
      { from: md.indexOf('[b]'), to: md.length, label: '[b]', noteId: 'n2', filename: 'b.pdf' },
    ]);
  });

  it('ignores the download query the panel link carries', () => {
    const md = `[a](${attachmentUrl('n1', 'a.pdf')}?download=1)`;
    expect(findAbsoluteAttachmentLinks(md)[0]?.filename).toBe('a.pdf');
  });

  it('names each file once per note', () => {
    const url = attachmentUrl('n1', 'a.pdf');
    const md = `[a](${url}) [again](${url}) [other](${attachmentUrl('n2', 'a.pdf')})`;
    expect(absoluteAttachmentRefs(md)).toEqual([
      { noteId: 'n1', filename: 'a.pdf' },
      { noteId: 'n2', filename: 'a.pdf' },
    ]);
  });
});

describe('remote images', () => {
  const md = [
    '![a](https://cdn.example/a.jpg) and ![again](https://cdn.example/a.jpg)',
    '![b](<http://example.com/pics/b c.png>)',
    '[not an image](https://example.com/x.png) ![local](files/x.png)',
  ].join('\n');

  it('lists each web image once, in order, and nothing else', () => {
    expect(remoteImageUrls(md)).toEqual([
      'https://cdn.example/a.jpg',
      'http://example.com/pics/b c.png',
    ]);
  });

  it('points saved images at their files and leaves the rest', () => {
    const out = localizeImageLinks(md, (url) =>
      url.endsWith('a.jpg') ? 'a.jpg' : url.endsWith('b c.png') ? 'b c-2.png' : null,
    );
    expect(out).toBe(
      [
        '![a](files/a.jpg) and ![again](files/a.jpg)',
        '![b](<files/b c-2.png>)',
        '[not an image](https://example.com/x.png) ![local](files/x.png)',
      ].join('\n'),
    );
  });

  it('keeps a web link a fetch could not replace', () => {
    expect(localizeImageLinks('![a](https://cdn.example/a.jpg)', () => null)).toBe(
      '![a](https://cdn.example/a.jpg)',
    );
  });
});

describe('relativizeAttachmentLinks', () => {
  it('rewrites to the name the destination gave the file, bracketed when it needs to be', () => {
    const md = `![a](${attachmentUrl('n1', 'a.png')}) and [b](${attachmentUrl('n1', 'b.pdf')})`;
    const out = relativizeAttachmentLinks(md, ({ filename }) =>
      filename === 'a.png' ? 'a-2.png' : 'my b.pdf',
    );
    expect(out).toBe('![a](files/a-2.png) and [b](<files/my b.pdf>)');
  });

  it('leaves a link alone when told to', () => {
    const md = `[a](${attachmentUrl('n1', 'a.pdf')}) text`;
    expect(relativizeAttachmentLinks(md, () => null)).toBe(md);
  });
});

describe('attachment resolution', () => {
  it('rewrites relative image paths to the API', () => {
    expect(render('![alt](files/diagram.png)')).toContain(
      `src="/api/notes/${NOTE}/files/diagram.png"`,
    );
  });

  it('rewrites relative link paths', () => {
    expect(render('[report](files/report.pdf)')).toContain(
      `href="/api/notes/${NOTE}/files/report.pdf"`,
    );
  });

  // CommonMark requires angle brackets when a URL contains spaces.
  it('encodes filenames with spaces', () => {
    expect(render('![x](<files/my photo.png>)')).toContain('my%20photo.png');
  });

  it('encodes unicode filenames', () => {
    expect(render('![x](files/café.png)')).toContain('caf%C3%A9.png');
  });

  // Editors commonly percent-encode on insert; that must not be double-encoded.
  it('does not double-encode an already-encoded filename', () => {
    const out = render('![x](files/my%20photo.png)');
    expect(out).toContain('my%20photo.png');
    expect(out).not.toContain('my%2520photo.png');
  });

  // A lone `%` is not valid percent-encoding; decodeURIComponent would throw.
  it('survives a filename with a bare percent sign', () => {
    const out = render('![x](files/100%.png)');
    expect(out).toContain('/api/notes/');
    expect(out).toContain('.png');
  });

  it('leaves absolute URLs alone', () => {
    expect(render('![x](https://example.com/a.png)')).toContain('src="https://example.com/a.png"');
  });

  it('leaves anchors and other relative paths alone', () => {
    expect(render('[jump](#section)')).toContain('href="#section"');
    expect(render('[up](../other/file.md)')).toContain('href="../other/file.md"');
  });
});

/** Notes can contain arbitrary HTML, and imported ENML is untrusted by construction. */
describe('sanitization', () => {
  it('strips script tags', () => {
    const out = render('<script>alert(1)</script>\n\ntext');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('strips inline event handlers', () => {
    expect(render('<img src="x" onerror="alert(1)">')).not.toContain('onerror');
  });

  it('strips javascript: URLs', () => {
    expect(render('[click](javascript:alert(1))')).not.toContain('javascript:');
  });

  it('strips iframes', () => {
    expect(render('<iframe src="https://evil.test"></iframe>')).not.toContain('<iframe');
  });

  it('strips data: URLs in links', () => {
    expect(render('[x](data:text/html,<script>alert(1)</script>)')).not.toContain('data:text/html');
  });

  it('keeps benign formatting', () => {
    const out = render('**bold** and `code` and [link](https://example.com)');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<code>code</code>');
    expect(out).toContain('href="https://example.com"');
  });
});

/**
 * A lone newline is a line break, not a space.
 *
 * CommonMark folds soft breaks into spaces, which turns a note written as separate lines
 * into one run-on paragraph. People press Enter in a notes app expecting a new line.
 */
describe('soft line breaks', () => {
  it('renders a single newline as a break', () => {
    const out = render('line one\nline two');
    expect(out).toContain('<br>');
    expect(out).toContain('line one');
    expect(out).toContain('line two');
  });

  it('still renders a blank line as a new paragraph', () => {
    const out = render('para one\n\npara two');
    expect(out.match(/<p>/g)).toHaveLength(2);
  });

  it('keeps trailing-space and backslash breaks working', () => {
    expect(render('a  \nb')).toContain('<br>');
    expect(render('a\\\nb')).toContain('<br>');
  });

  /** A break inside a list item must not split the item into two. */
  it('does not break list structure', () => {
    const out = render('- item one\n- item two');
    expect(out.match(/<li>/g)).toHaveLength(2);
    expect(out).toContain('<ul>');
  });

  it('does not insert breaks inside a code block', () => {
    const out = render('```\nconst a = 1;\nconst b = 2;\n```');
    expect(out).toContain('<code>');
    expect(out).not.toContain('<br>');
  });

  it('does not break table rows', () => {
    const out = render('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(out).toContain('<table>');
    expect(out).not.toContain('<br>');
  });

  /** The imported corpus separates paragraphs with blank lines; nothing should change. */
  it('leaves blank-line-separated content unchanged', () => {
    const out = render('Garden plan for the spring.\n\nAvery Okonkwo\n\nRiverside');
    expect(out.match(/<p>/g)).toHaveLength(3);
    expect(out).not.toContain('<br>');
  });
});

describe('gfm', () => {
  it('renders tables', () => {
    const out = render('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(out).toContain('<table>');
    expect(out).toContain('<td>1</td>');
  });

  it('renders task lists', () => {
    const out = render('- [x] done\n- [ ] todo');
    expect(out).toContain('type="checkbox"');
    expect(out).toContain('checked');
  });

  it('renders strikethrough and autolinks', () => {
    expect(render('~~gone~~')).toContain('<del>gone</del>');
    expect(render('https://example.com')).toContain('<a href="https://example.com"');
  });
});

describe('structure', () => {
  it('renders headings and code blocks', () => {
    expect(render('# Title')).toContain('<h1>Title</h1>');
    expect(render('```js\nconst x = 1;\n```')).toContain('<code class="language-js">');
  });

  it('handles an empty document', () => {
    expect(render('').trim()).toBe('');
  });
});

/**
 * The marker that turns an attachment link into an inline viewer.
 *
 * The security property under test is that only this pipeline can produce it. If note
 * content could forge the class, imported ENML (which is untrusted) could make arbitrary
 * links render as embedded documents.
 */
describe('pdf embed marker', () => {
  it('marks a PDF attachment link', () => {
    const out = render('[Scan.pdf](files/Scan.pdf)');
    expect(out).toContain('unbent-pdf');
  });

  it('marks a PDF whose name needs encoding', () => {
    expect(render('[T.pdf](<files/Treatment Plan.pdf>)')).toContain('unbent-pdf');
  });

  it('ignores case in the extension', () => {
    expect(render('[S.PDF](files/S.PDF)')).toContain('unbent-pdf');
  });

  it('does not mark other attachment types', () => {
    expect(render('[photo](files/photo.png)')).not.toContain('unbent-pdf');
    expect(render('[sheet](files/data.csv)')).not.toContain('unbent-pdf');
  });

  it('does not mark an external PDF link', () => {
    // Only same-note attachments are proxied and ownership-checked; an arbitrary remote
    // URL must never be fetched and rendered as though it were the user's own file.
    expect(render('[remote](https://evil.test/x.pdf)')).not.toContain('unbent-pdf');
  });

  it('cannot be forged by an author-supplied class', () => {
    const out = render('<a class="unbent-pdf" href="https://evil.test/x">click</a>');
    expect(out).not.toContain('unbent-pdf');
  });

  it('cannot be forged on an inline HTML link to a real attachment', () => {
    const out = render('<a class="unbent-pdf" href="files/note.txt">click</a>');
    expect(out).not.toContain('unbent-pdf');
  });
});

describe('image links', () => {
  it('wraps an attachment image in a link to itself', () => {
    const out = render('![diagram](files/diagram.png)');
    expect(out).toContain(
      `<a href="/api/notes/${NOTE}/files/diagram.png" class="unbent-zoom"><img src="/api/notes/${NOTE}/files/diagram.png" alt="diagram"></a>`,
    );
  });

  it('wraps a remote image too', () => {
    const out = render('![](https://example.com/a.png)');
    expect(out).toContain('<a href="https://example.com/a.png" class="unbent-zoom"><img');
  });

  it('leaves an image that is already a link alone', () => {
    const out = render('[![badge](files/badge.png)](https://example.com)');
    expect(out).not.toContain('unbent-zoom');
    expect(out).toContain('<a href="https://example.com"><img');
  });

  it('cannot be forged by an author-supplied class', () => {
    const out = render('<a class="unbent-zoom" href="https://evil.test/x">click</a>');
    expect(out).not.toContain('unbent-zoom');
  });
});

/**
 * A file's extension is the usual signal, but an imported one may not have a truthful
 * name: Evernote writes `<file-name>` as a display label, so a real export carries PDFs
 * called `Menu Card`. The note's own attachment rows record the declared type, and
 * that is what rescues notes already imported under such a name.
 */
describe('pdf embed marker from stored content types', () => {
  const withPdfs = (md: string, names: string[]) =>
    renderMarkdown(md, { noteId: NOTE, pdfFilenames: new Set(names) });

  it('marks an extensionless attachment stored as a PDF', () => {
    expect(withPdfs('[Menu Card](<files/Menu Card>)', ['Menu Card'])).toContain(
      'unbent-pdf',
    );
  });

  it('matches a name that needed encoding in the URL', () => {
    const out = withPdfs('[Gift](<files/Lease Summary - DRAFT DRAFT>)', [
      'Lease Summary - DRAFT DRAFT',
    ]);
    expect(out).toContain('unbent-pdf');
  });

  it('leaves files not in the set alone', () => {
    expect(withPdfs('[notes](files/notes)', ['Menu Card'])).not.toContain('unbent-pdf');
  });

  it('still marks by extension when no set is given', () => {
    expect(withPdfs('[Scan.pdf](files/Scan.pdf)', [])).toContain('unbent-pdf');
  });

  it('does not mark an external link that happens to share the name', () => {
    // The set says which of *this note's* files are PDFs; it must not vouch for a URL
    // pointing somewhere else, which is never fetched through the ownership check.
    const out = withPdfs('[x](https://evil.test/files/Menu Card)', ['Menu Card']);
    expect(out).not.toContain('unbent-pdf');
  });

  it('does not let another note id borrow the set', () => {
    const out = withPdfs('[x](https://evil.test/api/notes/other/files/Menu Card)', [
      'Menu Card',
    ]);
    expect(out).not.toContain('unbent-pdf');
  });
});

/**
 * The preview styles ordered-list markers by nesting depth (`ol ol` -> lower-alpha, and
 * so on), matching the editor's `1.` -> `a.` -> `i.` cycle. That only works while the
 * pipeline emits genuinely nested lists: a flattened structure would still read fine as
 * text but would silently number every level as decimal.
 */
describe('nested ordered lists', () => {
  it('nests an indented ordered list inside its parent item', () => {
    const html = render('1. one\n2. two\n   1. three');
    expect(html).toContain('<ol>');
    // The child list opens before the parent list closes.
    expect(html.indexOf('<ol>', html.indexOf('three') - 40)).toBeLessThan(
      html.lastIndexOf('</ol>'),
    );
    expect(html.match(/<ol>/g)).toHaveLength(2);
  });

  it('keeps an ordered list under a bullet out of the ordered nesting chain', () => {
    // `ol ol` must not match here, so the inner list restarts the cycle at decimal.
    const html = render('- bullet\n  1. nested');
    expect(html).toContain('<ul>');
    expect(html.match(/<ol>/g)).toHaveLength(1);
  });

  it('nests three ordered levels', () => {
    const html = render('1. one\n   1. two\n      1. three');
    expect(html.match(/<ol>/g)).toHaveLength(3);
  });
});

describe('excerptMarkdown', () => {
  it('keeps the words of a heading and loses the marks', () => {
    expect(excerptMarkdown('## Heading\n\nreal text')).toBe('Heading · real text');
  });

  it('flattens inline markup to its text', () => {
    expect(excerptMarkdown('Paid **in full** with `card` and ~~cash~~ — see [the receipt](https://x.test)')).toBe(
      'Paid in full with card and cash — see the receipt',
    );
  });

  /** The row shows a note's files on its own line, so the body's link to one is not prose. */
  it('drops attachment links and images entirely', () => {
    expect(excerptMarkdown('[Sale Confirmation.pdf](<files/Sale Confirmation.pdf>)')).toBe('');
    expect(excerptMarkdown('![scan.png](files/scan.png)\n\nUsed credit card.')).toBe('Used credit card.');
    expect(excerptMarkdown('See [scan.pdf](files/scan.pdf) for the total.')).toBe('See for the total.');
  });

  it('reads a list item by item, with its boxes', () => {
    expect(excerptMarkdown('- [x] milk\n- [ ] eggs\n- bread')).toBe('☑ milk · ☐ eggs · bread');
  });

  it('opens a nested list after its parent item', () => {
    expect(excerptMarkdown('- fruit\n  - apple\n  - pear\n- veg')).toBe('fruit · apple · pear · veg');
  });

  it('reads a table row by row', () => {
    expect(excerptMarkdown('| a | b |\n| - | - |\n| 1 | 2 |')).toBe('a b · 1 2');
  });

  it('reads a quote and a code block as their text', () => {
    expect(excerptMarkdown('> quoted\n\n```\nlet x = 1\n```')).toBe('quoted · let x = 1');
  });

  it('leaves raw html and rules out', () => {
    expect(excerptMarkdown('<div>boxed</div>\n\n---\n\nafter')).toBe('after');
    expect(excerptMarkdown('a <b>bold</b> word')).toBe('a bold word');
  });

  it('folds a line break inside a paragraph into a space', () => {
    expect(excerptMarkdown('one\ntwo')).toBe('one two');
  });

  /**
   * Same grammar as the renderer: a lone `-` under a line is a list in progress, not a
   * setext underline, so the dash stays the text it is rather than vanishing into a mark.
   */
  it('reads a lone dash under a line as text, as the renderer does', () => {
    expect(excerptMarkdown('item\n-')).toBe('item -');
  });

  it('truncates with an ellipsis at the limit', () => {
    const out = excerptMarkdown('x'.repeat(200));
    expect(out).toHaveLength(140);
    expect(out.endsWith('…')).toBe(true);
  });

  it('stops reading once the limit is reached', () => {
    const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n\n');
    expect(excerptMarkdown(many).endsWith('…')).toBe(true);
  });

  it('is empty for an empty body', () => {
    expect(excerptMarkdown('')).toBe('');
    expect(excerptMarkdown('\n\n   \n')).toBe('');
  });
});

describe('snippetParts', () => {
  /** The parts as one string, each hit in brackets, so a case reads as what the row shows. */
  const shown = (snippet: string) =>
    snippetParts(snippet)
      .map((p) => (p.hit ? `[${p.text}]` : p.text))
      .join('');

  it('shows an attachment link as its label, with the hit marked once', () => {
    expect(shown('**43-1234567** [<<SAMPLE_INVOICE>>.pdf](files/<<SAMPLE_INVOICE>>.pdf)')).toBe(
      '43-1234567 [SAMPLE_INVOICE].pdf',
    );
    expect(shown('see [<<Report>> (final).pdf](<files/<<Report>> (final).pdf>) here')).toBe(
      'see [Report] (final).pdf here',
    );
  });

  it('leaves plain text and its ellipses as they came', () => {
    expect(shown('…please <<check>> the address on…')).toBe('…please [check] the address on…');
    expect(shown('a << b and <<x>>')).toBe('a << b and [x]');
  });

  it('drops the marks of headings, lists, emphasis and code, and joins blocks with a dot', () => {
    expect(shown('# Heading <<word>>\n\n- one\n- [x] done <<word>>\n\nplain')).toBe(
      'Heading [word] · one · ☑ done [word] · plain',
    );
    expect(shown('a **<<bold>>** and _em_ and ~~gone~~ and `<<code>>`')).toBe('a [bold] and em and gone and [code]');
  });

  /** FTS5 marks a run of matched tokens as one, so a hit can open outside a mark and close inside it. */
  it('keeps a hit whose markers straddle emphasis', () => {
    expect(shown('<<foo **bar>>** after')).toBe('[foo bar] after');
  });

  it('shows an image by its alt and raw HTML by its words', () => {
    expect(shown('an ![<<photo>>.jpg](files/<<photo>>.jpg) here')).toBe('an [photo].jpg here');
    expect(shown('<div><<hello>> there</div>')).toBe('[hello] there');
  });

  it('mends a link the window opened inside', () => {
    expect(shown('…pdf](files/<<Scan>>.pdf) and more')).toBe('…pdf and more');
    expect(shown('…<<Scan>>.pdf](<files/Scan.pdf>) and more')).toBe('…[Scan].pdf and more');
    expect(shown('…<<Scan>>.pdf>) and more')).toBe('…and more');
    expect(shown('…files/<<Scan>>.pdf) and more')).toBe('…and more');
  });

  it('mends a link the window closed inside', () => {
    expect(shown('see [<<Scan>>.pdf](<files/<<Scan>> 2…')).toBe('see [Scan].pdf…');
    expect(shown('see [<<Scan>> 2…')).toBe('see [Scan] 2…');
  });

  /** A phrase typed with punctuation in it, `pdf](files`, is one FTS5 phrase and one mark. */
  it('closes a hit that opened in a label and closed in its destination', () => {
    expect(shown('see [Scan.<<pdf](files>>/Scan.pdf) and more')).toBe('see Scan.[pdf] and more');
  });

  it('drops a mark the window cut from its partner', () => {
    expect(shown('…mid **bold <<word>> rest…')).toBe('…mid bold [word] rest…');
    expect(shown('code `a**b` and <<x>>')).toBe('code a**b and [x]');
  });

  it('leaves a parenthesis in prose alone', () => {
    expect(shown('…call (555) 123 or <<x>>')).toBe('…call (555) 123 or [x]');
    expect(shown('…tea) and <<x>>')).toBe('…tea) and [x]');
    expect(shown('…etc.) and <<x>>')).toBe('…etc.) and [x]');
  });

  it('shows the snippet as it came when flattening leaves nothing', () => {
    expect(shown('(files/<<onlyurl>>.pdf)')).toBe('(files/[onlyurl].pdf)');
  });
});
