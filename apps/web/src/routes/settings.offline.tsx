import { createFileRoute } from '@tanstack/react-router';
import { OfflineStorage } from '../components/OfflineStorage.js';

/** What this device keeps of the account's files, and how to give the room back. */
export const Route = createFileRoute('/settings/offline')({
  component: OfflineStorage,
});
