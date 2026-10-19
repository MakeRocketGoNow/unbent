import { describe, expect, it, vi } from 'vitest';

/**
 * pdf.js is mocked to the one behaviour these tests are about: what `page.render` is
 * called with. Rasterizing itself needs a real canvas and a real worker, neither of which
 * exists under jsdom: it is verified by rendering an actual scan in a browser instead.
 */
type RenderParams = Record<string, unknown>;
const render = vi.fn((_params: RenderParams) => ({ promise: Promise.resolve() }));
const streamTextContent = vi.fn((_params: Record<string, unknown>) => 'text stream');
/** Whether the mocked page is stored turned a quarter, as a landscape scan often is. */
let turned = false;
const getPage = vi.fn(async () => ({
  // pdf.js applies the page's `/Rotate` to a viewport by default; `rawDims` stay unturned.
  getViewport: ({ scale }: { scale: number }) => ({
    scale,
    width: (turned ? 800 : 600) * scale,
    height: (turned ? 600 : 800) * scale,
    rawDims: { pageWidth: 600, pageHeight: 800 },
  }),
  render,
  streamTextContent,
}));

/** What each `TextLayer` was built with; rendering it is pdf.js's, and a no-op here. */
const textLayers: Record<string, unknown>[] = [];
class TextLayer {
  constructor(params: Record<string, unknown>) {
    textLayers.push(params);
  }
  render() {
    return Promise.resolve();
  }
}

const getDocument = vi.fn((_params: Record<string, unknown>) => ({
  promise: Promise.resolve({ numPages: 1, getPage }),
  destroy: () => {},
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: 'stub' },
  getDocument,
  TextLayer,
}));

const { loadPdf } = await import('./render.js');

async function renderOnce(dpr: number) {
  vi.stubGlobal('devicePixelRatio', dpr);
  global.fetch = vi.fn(async () => ({
    ok: true,
    headers: new Headers(),
    arrayBuffer: async () => new ArrayBuffer(8),
  })) as never;

  render.mockClear();
  const doc = await loadPdf('/api/notes/n1/files/scan.pdf');
  await doc.renderPage(1, document.createElement('canvas'), 420);
  return render.mock.calls[0]![0];
}

describe('renderPage parameters', () => {
  /**
   * pdf.js 6 discards a caller's context whenever `canvas` is also given
   * (`_canvasContext = params.canvas ? null : params.canvasContext`) and builds its own.
   * A `ctx.scale(dpr, dpr)` applied to the context passed in was therefore thrown away,
   * so pages drew at 1x into a canvas sized for 2x: a quarter-filled, blank-margined
   * page on every retina screen.
   */
  it('never passes a canvasContext alongside the canvas', async () => {
    const params = await renderOnce(2);
    expect(params['canvas']).toBeInstanceOf(HTMLCanvasElement);
    expect(params).not.toHaveProperty('canvasContext');
  });

  it('carries the device-pixel scale as a transform', async () => {
    const params = await renderOnce(2);
    expect(params['transform']).toEqual([2, 0, 0, 2, 0, 0]);
  });

  /** At 1x there is nothing to scale; pdf.js applies its own null default. */
  it('passes no transform on a non-retina display', async () => {
    const params = await renderOnce(1);
    expect(params['transform']).toBeUndefined();
  });

  /** Beyond 2x the memory cost grows faster than the visible gain. */
  it('caps the scale at 2x', async () => {
    const params = await renderOnce(3);
    expect(params['transform']).toEqual([2, 0, 0, 2, 0, 0]);
  });
});

describe('renderText', () => {
  async function layOut(cssWidth: number) {
    await renderOnce(1);
    textLayers.length = 0;
    const doc = await loadPdf('/api/notes/n1/files/scan.pdf');
    const container = document.createElement('div');
    const width = await doc.renderText(1, container, cssWidth);
    return { width, container, params: textLayers[0]! };
  }

  /**
   * The viewer divides a page's displayed width by this to get `--total-scale-factor`,
   * so it has to be the page's width at scale 1 as drawn, not the width it was laid
   * out at.
   */
  it("resolves to the page's width at scale 1", async () => {
    const { width } = await layOut(1200);
    expect(width).toBe(600);
  });

  /** As drawn, after the turn: the unturned width would scale a landscape page's text wrong. */
  it("resolves to a turned page's width as drawn", async () => {
    turned = true;
    try {
      const { width } = await layOut(1200);
      expect(width).toBe(800);
    } finally {
      turned = false;
    }
  });

  it('lays the text out for the width the page is drawn at', async () => {
    const { params, container } = await layOut(1200);
    expect((params['viewport'] as { scale: number }).scale).toBe(2);
    expect(params['container']).toBe(container);
    expect(params['textContentSource']).toBe('text stream');
  });

  /** So a tagged PDF's running headers and page numbers stay hidden from a screen reader. */
  it('keeps marked content', async () => {
    await layOut(600);
    expect(streamTextContent.mock.lastCall![0]).toEqual({ includeMarkedContent: true });
  });
});

/**
 * An attachment is whatever someone uploaded or imported, so it is treated as hostile.
 * `render.ts` explains the two ways a PDF could get script into the page; these pin the
 * options that close them.
 */
describe('getDocument options', () => {
  it('never compiles font data with eval', async () => {
    await renderOnce(1);
    expect(getDocument.mock.lastCall![0]['isEvalSupported']).toBe(false);
  });

  /** XFA forms render as live HTML rather than onto the canvas; off is pdf.js's default. */
  it('leaves XFA forms off', async () => {
    await renderOnce(1);
    expect(getDocument.mock.lastCall![0]['enableXfa']).toBeUndefined();
  });
});
