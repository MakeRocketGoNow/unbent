import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Confirm } from './Confirm.js';

/**
 * The confirm primitive replaced three `confirm()` calls and two hand-rolled panels, so
 * its branching is now the only thing standing between a stray click and an irreversible
 * delete. These are the branches worth pinning: the typed gate, and the rule that decides
 * which button looks like the one you are meant to press.
 */
describe('Confirm', () => {
  // Vitest runs without `globals`, so testing-library never registers its own auto
  // cleanup and renders would otherwise pile up across cases in one document.
  afterEach(cleanup);

  const cancel = () => {};

  it('keeps every action locked until the token matches exactly', () => {
    const onConfirm = vi.fn();
    render(
      <Confirm
        label="Confirm delete everything"
        question="Delete every note?"
        requireTyped="DELETE"
        actions={[{ label: 'Delete everything', tone: 'danger', onConfirm }]}
        onCancel={cancel}
      />,
    );

    const button = screen.getByRole('button', {
      name: 'Delete everything',
    }) as HTMLButtonElement;
    const input = screen.getByLabelText('Type DELETE to confirm');
    expect(button.disabled).toBe(true);

    // A near-miss is still a miss: the gate is exact, not case-insensitive.
    fireEvent.change(input, { target: { value: 'delete' } });
    expect(button.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'DELETE' } });
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('demotes a destructive action that follows a safe one', () => {
    render(
      <Confirm
        label="Confirm delete notebook"
        question="Delete the notebook Recipes?"
        actions={[
          { label: 'Delete notebook', tone: 'primary', onConfirm: () => {} },
          { label: 'Delete notebook and move 47 notes to Trash', tone: 'danger', onConfirm: () => {} },
        ]}
        onCancel={cancel}
      />,
    );

    // The safe outcome is the filled one; the cascade is demoted to an outlined danger
    // button (bordered and the same height, quieter than the fill it must not be mistaken
    // for), dropped onto its own line by its wrapper. Asserted by variant class rather than
    // the whole className, so adding a layout class to either one is not a test failure.
    const safe = screen.getByRole('button', { name: 'Delete notebook' });
    expect(safe.classList.contains('btn-primary')).toBe(true);
    const cascade = screen.getByRole('button', {
      name: 'Delete notebook and move 47 notes to Trash',
    });
    expect(cascade.classList.contains('btn-secondary')).toBe(true);
    expect(cascade.classList.contains('btn-danger')).toBe(true);
    expect(cascade.classList.contains('btn-primary')).toBe(false);
    // Its own line is the wrapper's job, not a full-width button that spans the panel.
    expect(cascade.parentElement?.classList.contains('confirm-action-own-line')).toBe(true);
  });

  it('fills a lone destructive action, since destroying is the point', () => {
    render(
      <Confirm
        label="Confirm empty trash"
        question="Permanently delete 12 notes?"
        actions={[{ label: 'Empty trash', tone: 'danger', onConfirm: () => {} }]}
        onCancel={cancel}
      />,
    );

    const button = screen.getByRole('button', { name: 'Empty trash' });
    expect(button.classList.contains('btn-primary')).toBe(true);
    expect(button.classList.contains('btn-danger')).toBe(true);
  });

  it('cancels on Escape, the way confirm() did', () => {
    const onCancel = vi.fn();
    render(
      <Confirm
        label="Confirm delete note"
        question="Delete this note?"
        actions={[{ label: 'Delete', tone: 'danger', onConfirm: () => {} }]}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(screen.getByRole('group', { name: 'Confirm delete note' }), {
      key: 'Escape',
    });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('disables everything and swaps in the busy label while running', () => {
    render(
      <Confirm
        label="Confirm delete notebook"
        question="Delete the notebook Recipes?"
        busy
        actions={[
          { label: 'Delete notebook', busyLabel: 'Deleting…', tone: 'primary', onConfirm: () => {} },
        ]}
        onCancel={cancel}
      />,
    );

    expect((screen.getByRole('button', { name: 'Deleting…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  });

  describe('border tone', () => {
    const root = (actions: Parameters<typeof Confirm>[0]['actions']) => {
      render(<Confirm label="Confirm it" question="Sure?" actions={actions} onCancel={cancel} />);
      return screen.getByRole('group', { name: 'Confirm it' });
    };
    const act = (tone: 'primary' | 'neutral' | 'danger') => ({ label: tone, tone, onConfirm: () => {} });

    it('is red when the action offered is destructive', () => {
      expect(root([act('danger')]).className).toContain('confirm-danger');
    });

    it('is green when the action offered is the primary', () => {
      const el = root([act('primary')]);
      expect(el.className).toContain('confirm-primary');
      expect(el.className).not.toContain('confirm-danger');
    });

    it('is plain for a neutral action, or none at all', () => {
      expect(root([act('neutral'), { ...act('danger'), label: 'also' }]).className).toContain('confirm-neutral');
      cleanup();
      expect(root([]).className).toContain('confirm-neutral');
    });
  });
});
