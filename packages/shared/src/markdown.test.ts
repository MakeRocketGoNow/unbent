import { describe, expect, it } from 'vitest';
import {
  attachmentFilenamesInMarkdown,
  formatAttachmentMarkdown,
  removeAttachmentLinks,
  renderMarkdown,
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

  /** Without brackets the whole line is literal text — no link, no PDF viewer. */
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
 * content could forge the class, imported ENML — which is untrusted — could make arbitrary
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
