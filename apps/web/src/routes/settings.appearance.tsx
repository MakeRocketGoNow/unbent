import { createFileRoute } from '@tanstack/react-router';
import { Appearance } from '../components/Appearance.js';

/** Light, dark, or the device's; see `theme.ts`. */
export const Route = createFileRoute('/settings/appearance')({
  component: Appearance,
});
