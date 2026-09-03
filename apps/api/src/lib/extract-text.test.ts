import { describe, expect, it } from 'vitest';
import {
  MAX_SERVER_EXTRACT_BYTES,
  canExtractOnServer,
  extractOnServer,
  stripConversionPreamble,
  type MarkdownConverter,
} from './extract-text.js';

/** The shape of a real conversion, taken from a ScanSnap scan in the export. */
const preamble = `# 36-2.pdf
## Metadata
- PDFFormatVersion=1.3
- IsLinearized=false
- Producer=macOS Version 10.14.6 (Build 18G8022) Quartz PDFContext
- Creator=ScanSnap Manager



## Contents
### Page 1
`;

const prose =
  'Your diagnosis based on what you shared about how you are feeling is allergic rhinitis, ' +
  'also known as hay fever, and the plan is an antihistamine each morning for two weeks.';

function converter(answer: { format: string; data?: string; error?: string }): MarkdownConverter {
  return { toMarkdown: () => ({ transform: async () => answer }) };
}

describe('server-side extraction', () => {
  it('drops the preamble and the page headings, and keeps the text', () => {
    const stripped = stripConversionPreamble(`${preamble}${prose}\n### Page 2\nMore.`);
    expect(stripped).not.toContain('ScanSnap');
    expect(stripped).not.toContain('Page');
    expect(stripped).toContain(prose);
    expect(stripped).toContain('More.');
  });

  it('finds nothing in a scan with no text layer, so the row can be closed', async () => {
    const extracted = await extractOnServer(converter({ format: 'markdown', data: preamble }), 'scan.pdf', new Blob());
    expect(extracted?.quality.usable).toBe(false);
  });

  it('cleans real text the same way the browser does', async () => {
    const extracted = await extractOnServer(
      converter({ format: 'markdown', data: `${preamble}S t a t e m e n t ${prose}` }),
      'scan.pdf',
      new Blob(),
    );
    expect(extracted?.quality.usable).toBe(true);
    expect(extracted?.text.startsWith('Statement ')).toBe(true);
  });

  it('reports a file it could not read as null, so the row stays pending', async () => {
    expect(await extractOnServer(converter({ format: 'error', error: 'unsupported' }), 'x.pdf', new Blob())).toBeNull();
  });

  it('only takes PDFs, under the cap, where the binding exists', () => {
    expect(canExtractOnServer({ AI: {} }, 'application/pdf', 1024)).toBe(true);
    expect(canExtractOnServer({}, 'application/pdf', 1024)).toBe(false);
    expect(canExtractOnServer({ AI: {} }, 'image/jpeg', 1024)).toBe(false);
    expect(canExtractOnServer({ AI: {} }, 'application/pdf', MAX_SERVER_EXTRACT_BYTES + 1)).toBe(false);
  });
});
