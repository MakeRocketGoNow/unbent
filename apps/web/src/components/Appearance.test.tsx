import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { THEME_KEY } from '../theme.js';
import { Appearance } from './Appearance.js';

vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));

describe('Appearance', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('offers three themes by name, with Auto chosen until something else is', () => {
    render(<Appearance />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.closest('label')?.textContent)).toEqual(['Auto', 'Light', 'Dark']);
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveProperty('checked', true);
    expect(screen.getByText(/Follows this device, which is light now/)).toBeTruthy();
  });

  it('draws and keeps a choice at once', () => {
    render(<Appearance />);
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveProperty('checked', true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(screen.getByText(/Kept on this device only/)).toBeTruthy();
  });
});
