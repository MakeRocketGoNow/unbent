import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Import } from '../components/Import.js';

/** Evernote import. A route so a long import is not lost to an accidental toggle. */
export const Route = createFileRoute('/import')({
  component: ImportRoute,
});

function ImportRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return (
    <Import
      onClose={() => void navigate({ to: '/notes' })}
      onImported={() => {
        // An import creates notes, notebooks, and tags, so nothing cached is still true.
        void queryClient.invalidateQueries();
      }}
    />
  );
}
