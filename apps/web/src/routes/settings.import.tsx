import { createFileRoute } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Import } from '../components/Import.js';

export const Route = createFileRoute('/settings/import')({
  component: ImportRoute,
});

function ImportRoute() {
  const queryClient = useQueryClient();

  return (
    <Import
      onImported={() => {
        // An import creates notes, notebooks, and tags, so nothing cached is still true.
        void queryClient.invalidateQueries();
      }}
    />
  );
}
