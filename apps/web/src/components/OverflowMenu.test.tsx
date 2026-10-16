import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { OverflowMenu } from './OverflowMenu.js';

/**
 * The selected state.
 *
 * The rest of this menu is dismissal and markup that has held for a while; what is new is
 * that a menu can now be a *choice*: the sort menu, where one of five is always in effect.
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

  /*
   * The third kind of item. `href` renders a download and `to` renders a route, so a
   * document an operator hosts on their own site had nowhere to go before this: handed to
   * `to` it became a route this app does not have.
   */
  it('renders a document hosted elsewhere as a plain anchor', () => {
    const { container, getByText } = render(
      <OverflowMenu
        label="Account"
        items={[{ label: 'Privacy', external: 'https://example.com/privacy' }]}
      />,
    );
    open(container);
    const item = getByText('Privacy');
    expect(item.tagName).toBe('A');
    expect(item.getAttribute('href')).toBe('https://example.com/privacy');
    // Not a download: this is a page to read, not a file to save.
    expect(item.hasAttribute('download')).toBe(false);
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
