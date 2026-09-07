import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { OverflowMenu } from './OverflowMenu.js';

/**
 * The selected state.
 *
 * The rest of this menu is dismissal and markup that has held for a while; what is new is
 * that a menu can now be a *choice* — the sort menu, where one of five is always in effect.
 * The contract worth pinning is that saying so is opt-in: a command has no "not pressed"
 * state, and announcing one to a screen reader invites the question of how to press it.
 */
describe('OverflowMenu', () => {
  afterEach(cleanup);

  const open = (container: HTMLElement) => {
    fireEvent.click(container.querySelector('.overflow-trigger') as HTMLElement);
  };

  it('says nothing about pressed state for a list of commands', () => {
    const { container } = render(
      <OverflowMenu label="More" items={[{ label: 'Settings' }, { label: 'Sign out' }]} />,
    );
    open(container);
    for (const b of container.querySelectorAll('.overflow-item')) {
      expect(b.hasAttribute('aria-pressed')).toBe(false);
    }
  });

  it('marks the item in effect, and only that one', () => {
    const { container, getByText } = render(
      <OverflowMenu
        label="Sort notes"
        items={[
          { label: 'Recently updated', selected: true },
          { label: 'Oldest first', selected: false },
        ]}
      />,
    );
    open(container);
    expect(getByText('Recently updated').getAttribute('aria-pressed')).toBe('true');
    expect(getByText('Oldest first').getAttribute('aria-pressed')).toBe('false');
    expect(getByText('Recently updated').className).toContain('selected');
    expect(getByText('Oldest first').className).not.toContain('selected');
  });

  it('still closes and runs the handler when a choice is picked', () => {
    let picked = '';
    const { container, getByText } = render(
      <OverflowMenu
        label="Sort notes"
        items={[
          { label: 'Recently updated', selected: true, onSelect: () => (picked = 'updated') },
          { label: 'Oldest first', selected: false, onSelect: () => (picked = 'oldest') },
        ]}
      />,
    );
    open(container);
    fireEvent.click(getByText('Oldest first'));
    expect(picked).toBe('oldest');
    expect(container.querySelector('.overflow-list')).toBeNull();
  });
});
