import { createFileRoute } from '@tanstack/react-router';
import { Import } from '../components/Import.js';

// The cache is refreshed when a run ends by the app shell, not here: a run outlives this
// page, so it can end while nothing of it is on screen. See `AppShell`.
export const Route = createFileRoute('/settings/import')({
  component: Import,
});
