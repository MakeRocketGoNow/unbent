import { hc } from 'hono/client';
import type { AppType } from '@unbent/api';

/**
 * Typed API client. Requests are same-origin in both development (via the Vite proxy)
 * and production (Pages routes /api to the Worker), so cookies travel without CORS.
 */
export const api = hc<AppType>('/');
