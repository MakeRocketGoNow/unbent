import { describe, it, expect, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  abandonUploads,
  attachments,
  insertUploads,
  pendingUploads,
  type AttachConfig,
} from './attach.js';

/**
 * The upload routine drop, paste and the Attach button share.
 *
 * What matters is the shape of the document at each step: a placeholder the moment the
 * file is chosen, the real link when the upload lands, a comment when it fails, and
 * nothing at all when it is abandoned — that last one is the case the Android app
 * depends on, because a placeholder left in a saved note is permanent once the WebView
 * that could have replaced it is gone.
 */

/** An upload the test finishes by hand, and the signal it was given. */
function deferredUpload() {
  const calls: { file: File; signal: AbortSignal; resolve: (p: string) => void; reject: (e: Error) => void }[] = [];
  const upload: AttachConfig['upload'] = (file, signal) =>
    new Promise<string>((resolve, reject) => {
      calls.push({ file, signal, resolve, reject });
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  /** The n-th upload asked for; a test that reaches for one that never came fails here. */
  const call = (n: number) => {
    const c = calls[n];
    if (!c) throw new Error(`upload ${n} was never requested`);
    return c;
  };
  return { upload, calls, call };
}

function mount(doc: string, config: AttachConfig) {
  return new EditorView({
    state: EditorState.create({ doc, extensions: [attachments(config)] }),
    parent: document.body,
  });
}

const png = () => new File(['x'], 'a.png', { type: 'image/png' });
const pdf = () => new File(['x'], 'b.pdf', { type: 'application/pdf' });

/** Lets the promise chain inside insertUploads advance after a resolve or reject. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('insertUploads', () => {
  it('puts a placeholder at the position and the link in its place when the upload lands', async () => {
    const { upload, calls, call } = deferredUpload();
    const view = mount('one\ntwo', { upload });

    const done = insertUploads(view, [png()], 4);
    expect(view.state.doc.toString()).toMatch(/^one\n!\[uploading a\.png…]\(#upload-[0-9a-f]{8}\)\ntwo$/);
    expect(pendingUploads(view)).toBe(1);

    call(0).resolve('files/a.png');
    await done;
    expect(view.state.doc.toString()).toBe('one\n![a.png](files/a.png)\ntwo');
    expect(pendingUploads(view)).toBe(0);
    view.destroy();
  });

  it('links a file that is not an image without the image mark', async () => {
    const { upload, calls, call } = deferredUpload();
    const view = mount('', { upload });
    const done = insertUploads(view, [pdf()], 0);
    call(0).resolve('files/b.pdf');
    await done;
    expect(view.state.doc.toString()).toBe('[b.pdf](files/b.pdf)\n');
    view.destroy();
  });

  /*
     Every placeholder goes in before the first upload starts. The old loop inserted each
     one at `at` only when its turn came, after the previous upload, so three files came
     out reversed — and drifted if the user had typed above `at` meanwhile.
  */
  it('inserts all placeholders at once, in file order, as one undo step', async () => {
    const { upload, calls, call } = deferredUpload();
    const view = mount('', { upload });
    const done = insertUploads(view, [png(), pdf()], 0);

    const lines = view.state.doc.toString().split('\n');
    expect(lines[0]).toMatch(/^!\[uploading a\.png…]/);
    expect(lines[1]).toMatch(/^!\[uploading b\.pdf…]/);
    expect(pendingUploads(view)).toBe(2);
    // Sequential: the second upload has not been asked for yet.
    expect(calls).toHaveLength(1);

    call(0).resolve('files/a.png');
    await settle();
    expect(calls).toHaveLength(2);
    call(1).resolve('files/b.pdf');
    await done;
    expect(view.state.doc.toString()).toBe('![a.png](files/a.png)\n[b.pdf](files/b.pdf)\n');
    view.destroy();
  });

  it('still finds the placeholder after typing before it', async () => {
    const { upload, calls, call } = deferredUpload();
    const view = mount('tail', { upload });
    const done = insertUploads(view, [png()], 0);
    view.dispatch({ changes: { from: 0, insert: 'typed ahead\n' } });
    call(0).resolve('files/a.png');
    await done;
    expect(view.state.doc.toString()).toBe('typed ahead\n![a.png](files/a.png)\ntail');
    view.destroy();
  });

  it('leaves a comment where an upload failed', async () => {
    const { upload, calls, call } = deferredUpload();
    const view = mount('', { upload });
    const done = insertUploads(view, [png()], 0);
    call(0).reject(new Error('413'));
    await done;
    expect(view.state.doc.toString()).toBe('<!-- upload failed: 413 -->\n');
    view.destroy();
  });

  it('reports the number in flight as it changes', async () => {
    const { upload, calls, call } = deferredUpload();
    const onPending = vi.fn();
    const view = mount('', { upload, onPending });
    const done = insertUploads(view, [png(), pdf()], 0);
    call(0).resolve('files/a.png');
    await settle();
    call(1).resolve('files/b.pdf');
    await done;
    // Two registered before the first upload, then down one at a time.
    expect(onPending.mock.calls.map((c) => c[0])).toEqual([1, 2, 1, 0]);
    view.destroy();
  });

  it('does nothing without an uploader', async () => {
    const view = mount('doc', {});
    await insertUploads(view, [png()], 0);
    expect(view.state.doc.toString()).toBe('doc');
    view.destroy();
  });
});

describe('abandonUploads', () => {
  it('removes the placeholders, aborts the uploads, and writes no failure comment', async () => {
    const { upload, calls, call } = deferredUpload();
    const onPending = vi.fn();
    const view = mount('keep', { upload, onPending });
    const done = insertUploads(view, [png(), pdf()], 0);

    expect(abandonUploads(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('keep');
    expect(pendingUploads(view)).toBe(0);
    expect(call(0).signal.aborted).toBe(true);
    expect(onPending).toHaveBeenLastCalledWith(0);

    // The aborted upload rejects; the routine must not turn that into a comment, and the
    // second file, never started, must not start now.
    await done;
    expect(view.state.doc.toString()).toBe('keep');
    expect(calls).toHaveLength(1);
    view.destroy();
  });

  it('is a no-op with nothing in flight', () => {
    const { upload } = deferredUpload();
    const view = mount('doc', { upload });
    expect(abandonUploads(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('doc');
    view.destroy();
  });
});

describe('paste', () => {
  it('routes pasted files through the same placeholder', () => {
    const { upload } = deferredUpload();
    const view = mount('', { upload });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [png()], getData: () => '', types: ['Files'] },
      configurable: true,
    });
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toMatch(/^!\[uploading a\.png…]/);
    view.destroy();
  });
});
