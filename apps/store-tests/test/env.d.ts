import type { UserStore } from '@unbent/api/store';

/**
 * What `env` from `cloudflare:test` holds: the plugin types it as the global
 * `Cloudflare.Env`, which the API declares nowhere (its `Env` is an exported interface in
 * types.ts), so the two bindings the tests reach are declared here.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      USER_STORE: DurableObjectNamespace<UserStore>;
      DB: D1Database;
    }
  }
}
