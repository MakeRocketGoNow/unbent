import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type { Note } from '@unbent/shared';
import { ApiError } from '../notes-api.js';
import * as actions from '../store/actions.js';
import { ClipLinkForm, asPageUrl, useClipLink } from './ClipLinkForm.js';

vi.mock('../store/actions.js', () => ({ clipLink: vi.fn() }));

/**
 * The form a link is clipped from: what it sends, what it refuses before sending, and
 * that the server's answer about a page lands under the field, with the address still
 * in it. The request is `actions.clipLink`, a request made now and never queued.
 */
const note = {
  id: 'n1',
  title: 'An article',
  body: 'Clipped from…',
  tags: [],
  notebook: null,
  createdAt: 1,
  updatedAt: 1,
} as unknown as Note;

const filing = { tags: ['read'], notebook: 'Reading' };

interface FormProps {
  filing: typeof filing;
  offline: boolean;
  compact?: boolean;
  onClipped: (note: Note) => void;
  onCancel: () => void;
  /** Draws the form as a new element, as a change of the head's layout does. */
  place?: string;
}

/** The form with its state held above it, as `NotesLayout` holds it. */
function Form({ place = 'a', compact, ...options }: FormProps) {
  const clip = useClipLink(options);
  return <ClipLinkForm key={place} clip={clip} offline={options.offline} compact={compact} onCancel={options.onCancel} />;
}

describe('asPageUrl', () => {
  it('takes a web address as pasted, and supplies the scheme a typed one lacks', () => {
    expect(asPageUrl(' https://example.com/a-slug?x=1 ')).toBe('https://example.com/a-slug?x=1');
    expect(asPageUrl('http://example.com')).toBe('http://example.com/');
    expect(asPageUrl('example.com/article')).toBe('https://example.com/article');
    expect(asPageUrl('example.com:8080/article')).toBe('https://example.com:8080/article');
    expect(asPageUrl('localhost:5173')).toBe('https://localhost:5173/');
  });

  it('refuses what is not a web page', () => {
    expect(asPageUrl('')).toBeNull();
    expect(asPageUrl('look at https://example.com')).toBeNull();
    expect(asPageUrl('mailto:someone@example.com')).toBeNull();
    expect(asPageUrl('ftp://example.com/file')).toBeNull();
    expect(asPageUrl('https://')).toBeNull();
  });
});

describe('ClipLinkForm', () => {
  beforeEach(() => {
    vi.mocked(actions.clipLink).mockReset();
  });
  afterEach(cleanup);

  it('clips the pasted address, filed as the list files a note, and hands the note back', async () => {
    vi.mocked(actions.clipLink).mockResolvedValue({ ...note, clip: { images: { stored: 2, failed: [] } } });
    const onClipped = vi.fn();
    const { getByLabelText, getByRole } = render(
      <Form filing={filing} offline={false} onClipped={onClipped} onCancel={() => {}} />,
    );
    const field = getByLabelText('Link to clip');
    // Focus arrives with the form: the field is the point of opening it.
    expect(document.activeElement).toBe(field);

    fireEvent.change(field, { target: { value: 'example.com/a-slug' } });
    fireEvent.click(getByRole('button', { name: 'Clip' }));

    await waitFor(() => expect(onClipped).toHaveBeenCalledWith(expect.objectContaining({ id: 'n1' })));
    expect(actions.clipLink).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com/a-slug', tags: ['read'], notebook: 'Reading' }));
  });

  it('clips on Enter and leaves on Escape', async () => {
    vi.mocked(actions.clipLink).mockResolvedValue({ ...note, clip: { images: { stored: 0, failed: [] } } });
    const onClipped = vi.fn();
    const onCancel = vi.fn();
    const { getByLabelText } = render(
      <Form filing={filing} offline={false} onClipped={onClipped} onCancel={onCancel} />,
    );
    const field = getByLabelText('Link to clip');
    fireEvent.change(field, { target: { value: 'https://example.com/' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(onClipped).toHaveBeenCalledOnce());

    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('says what is wrong with the address before asking the server', () => {
    const { getByLabelText, getByRole } = render(
      <Form filing={filing} offline={false} onClipped={() => {}} onCancel={() => {}} />,
    );
    fireEvent.click(getByRole('button', { name: 'Clip' }));
    expect(getByRole('alert').textContent).toBe('Paste the address of a web page.');

    fireEvent.change(getByLabelText('Link to clip'), { target: { value: 'not a link at all' } });
    fireEvent.click(getByRole('button', { name: 'Clip' }));
    expect(getByRole('alert').textContent).toBe("That isn't a web address.");
    expect(actions.clipLink).not.toHaveBeenCalled();
  });

  /* The route's own sentence, without the status it leads with in a log, and the address
     kept in the field: a link the site refused is still worth copying into a note by hand. */
  it("shows the server's answer about the page under the field and keeps the address", async () => {
    vi.mocked(actions.clipLink).mockRejectedValue(
      new ApiError(502, '502: The site refused to serve the page.', 'HOST_REFUSED'),
    );
    const { getByLabelText, getByRole } = render(
      <Form filing={filing} offline={false} onClipped={() => {}} onCancel={() => {}} />,
    );
    const field = getByLabelText('Link to clip') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'https://example.com/article' } });
    fireEvent.click(getByRole('button', { name: 'Clip' }));

    await waitFor(() => expect(getByRole('alert').textContent).toBe('The site refused to serve the page.'));
    expect(field.value).toBe('https://example.com/article');
    expect(field.disabled).toBe(false);
    expect(field.getAttribute('aria-invalid')).toBe('true');
  });

  /* An answer lost on the way back: the server may hold the note already, so a second
     press asks for that note, and a changed address is a new one. */
  it('sends the same id when pressed again, and a new one for a new address', async () => {
    vi.mocked(actions.clipLink).mockRejectedValue(new ApiError(0, 'offline'));
    const { getByLabelText, getByRole } = render(
      <Form filing={filing} offline={false} onClipped={() => {}} onCancel={() => {}} />,
    );
    const press = async (times: number) => {
      fireEvent.click(getByRole('button', { name: 'Clip' }));
      await waitFor(() => expect(actions.clipLink).toHaveBeenCalledTimes(times));
      await waitFor(() => expect(getByRole('button', { name: 'Clip' })).toBeTruthy());
    };
    fireEvent.change(getByLabelText('Link to clip'), { target: { value: 'https://example.com/a' } });
    await press(1);
    await press(2);
    fireEvent.change(getByLabelText('Link to clip'), { target: { value: 'https://example.com/b' } });
    await press(3);
    const ids = vi.mocked(actions.clipLink).mock.calls.map(([input]) => input.id);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  /* The route's sentence for a file names the assistant's tool; the form has its own. */
  it('says a file is not a page in its own words', async () => {
    vi.mocked(actions.clipLink).mockRejectedValue(
      new ApiError(415, '415: That address is a application/pdf file, not a web page. Clipping is for web pages; a file such as a PDF is attached to a note instead (uploaded, or passed to add_attachment by an assistant).', 'NOT_A_PAGE'),
    );
    const { getByLabelText, getByRole } = render(
      <Form filing={filing} offline={false} onClipped={() => {}} onCancel={() => {}} />,
    );
    fireEvent.change(getByLabelText('Link to clip'), { target: { value: 'https://example.com/file.pdf' } });
    fireEvent.click(getByRole('button', { name: 'Clip' }));
    await waitFor(() => expect(getByRole('alert').textContent).toBe("That's a file, not a web page. Attach it to a note instead."));
  });

  it('says it is clipping while the server reads the page', async () => {
    let settle: (n: typeof note & { clip: { images: { stored: number; failed: [] } } }) => void = () => {};
    vi.mocked(actions.clipLink).mockReturnValue(new Promise((resolve) => (settle = resolve)));
    const { getByLabelText, getByRole } = render(
      <Form filing={filing} offline={false} onClipped={() => {}} onCancel={() => {}} />,
    );
    fireEvent.change(getByLabelText('Link to clip'), { target: { value: 'https://example.com/' } });
    fireEvent.click(getByRole('button', { name: 'Clip' }));
    expect(getByRole('button', { name: 'Clipping…' })).toBeTruthy();
    expect((getByLabelText('Link to clip') as HTMLInputElement).disabled).toBe(true);
    await act(async () => settle({ ...note, clip: { images: { stored: 0, failed: [] } } }));
  });

  /* The server does the fetching, so offline the button fades with the reason rather
     than queueing the address: the rule Auto-fill follows. */
  it('fades Clip offline and says why', () => {
    const { getByRole, getByLabelText } = render(
      <Form filing={filing} offline onClipped={() => {}} onCancel={() => {}} />,
    );
    fireEvent.keyDown(getByLabelText('Link to clip'), { key: 'Enter' });
    expect(getByRole('alert').textContent).toBe('Clipping needs a connection.');
    expect(actions.clipLink).not.toHaveBeenCalled();
    const clip = getByRole('button', { name: 'Clip' });
    expect(clip.hasAttribute('disabled')).toBe(true);
    expect(clip.getAttribute('data-tip')).toBe('Clipping needs a connection');
    expect(clip.getAttribute('aria-description')).toBe('Clipping needs a connection');
  });

  /* The head draws the form in another place when its layout changes, and a table row
     opening beside it is enough. It is the same form, and the note keeps the focus. */
  it('keeps the address and leaves focus alone when the layout moves it', () => {
    const props = { filing, offline: false, onClipped: () => {}, onCancel: () => {} };
    const { getByLabelText, rerender } = render(<Form {...props} place="a" />);
    fireEvent.change(getByLabelText('Link to clip'), { target: { value: 'https://example.com/' } });
    (document.activeElement as HTMLElement).blur();
    rerender(<Form {...props} place="b" />);
    const field = getByLabelText('Link to clip') as HTMLInputElement;
    expect(field.value).toBe('https://example.com/');
    expect(document.activeElement).not.toBe(field);
  });

  it('still says it is clipping when the layout moves it mid-clip, and cannot be sent twice', async () => {
    vi.mocked(actions.clipLink).mockReturnValue(new Promise(() => {}));
    const props = { filing, offline: false, onClipped: () => {}, onCancel: () => {} };
    const { getByLabelText, getByRole, rerender } = render(<Form {...props} place="a" />);
    fireEvent.change(getByLabelText('Link to clip'), { target: { value: 'https://example.com/' } });
    fireEvent.click(getByRole('button', { name: 'Clip' }));
    rerender(<Form {...props} place="b" />);
    expect((getByRole('button', { name: 'Clipping…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(actions.clipLink).toHaveBeenCalledOnce();
  });

  /* Gone to Settings while it ran: the note lands, and nobody is pulled back to it. */
  it('does not open the note once the caller has gone', async () => {
    let settle: (n: typeof note & { clip: { images: { stored: number; failed: [] } } }) => void = () => {};
    vi.mocked(actions.clipLink).mockReturnValue(new Promise((resolve) => (settle = resolve)));
    const onClipped = vi.fn();
    const { getByLabelText, getByRole, unmount } = render(
      <Form filing={filing} offline={false} onClipped={onClipped} onCancel={() => {}} />,
    );
    fireEvent.change(getByLabelText('Link to clip'), { target: { value: 'https://example.com/' } });
    fireEvent.click(getByRole('button', { name: 'Clip' }));
    unmount();
    await act(async () => settle({ ...note, clip: { images: { stored: 0, failed: [] } } }));
    expect(onClipped).not.toHaveBeenCalled();
  });

  it('leaves Cancel to the back arrow in the compact row', () => {
    const { queryByRole } = render(
      <Form filing={filing} offline={false} compact onClipped={() => {}} onCancel={() => {}} />,
    );
    expect(queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});
