/**
 * Minimal browser globals for running pdf.js under Node in tests.
 *
 * pdf.js targets browsers and Web Workers, both of which provide DOMMatrix, Path2D, and
 * ImageData — verified directly in a real Web Worker, which is where the import actually
 * runs. Node has none of them, so text extraction throws "DOMMatrix is not defined"
 * before reading a single page.
 *
 * These stubs exist only to get past construction. Text extraction never rasterizes, so
 * nothing here is called during a real extraction; a shim that silently returned wrong
 * geometry would be worse than one that is obviously inert.
 */

class DOMMatrixStub {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(init?: number[] | string) {
    if (Array.isArray(init) && init.length >= 6) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = init as [
        number, number, number, number, number, number,
      ];
    }
  }
}

class Path2DStub {
  addPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
}

class ImageDataStub {
  data: Uint8ClampedArray;
  constructor(
    public width: number,
    public height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

const g = globalThis as Record<string, unknown>;
g['DOMMatrix'] ??= DOMMatrixStub;
g['Path2D'] ??= Path2DStub;
g['ImageData'] ??= ImageDataStub;
