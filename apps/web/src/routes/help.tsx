import { createFileRoute } from '@tanstack/react-router';
import { HelpPage } from '../components/HelpPage.js';

/**
 * Help (MAK-116): behind the session like every route `shellFor` does not list, since it
 * explains the app to someone using it. Reached from the account menu.
 */
export const Route = createFileRoute('/help')({
  component: () => <HelpPage />,
});
