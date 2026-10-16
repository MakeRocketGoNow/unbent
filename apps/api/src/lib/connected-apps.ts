import type { D1Database } from '@cloudflare/workers-types';

/**
 * Connected apps: the OAuth grants a user has handed out, and how to take one back.
 *
 * Better Auth's provider has endpoints for listing and deleting a *consent* record, but a
 * consent is only the note that permission was given. Deleting it does not touch the tokens
 * issued under it, and access tokens here are verified by signature alone (no database read
 * on the hot path), which is what keeps a tool call cheap. So a deleted consent leaves the
 * app working exactly as before, and its refresh token can still mint new access tokens.
 * Measured, not assumed: revoking through the plugin's own endpoint and then calling the
 * MCP endpoint still answered 200.
 *
 * A "Disconnect" button that does not disconnect is worse than no button, so revocation
 * happens here instead: delete the client's tokens for this user, then the consent. Access
 * tokens already minted stay valid until they expire, which is an hour by default: the
 * unavoidable cost of stateless verification, and the reason the confirmation says access
 * ends rather than that every request stops this second.
 *
 * Written as SQL against the provider's tables rather than through the adapter because the
 * API has no typed handle on them; the table and column names come from the same schema
 * migration 0012 was generated from.
 */
export class ConnectedAppsRepo {
  constructor(
    private db: D1Database,
    private userId: string,
  ) {
    if (!userId) throw new Error('ConnectedAppsRepo requires a user id');
  }

  /**
   * Withdraw one app's access.
   *
   * Scoped by user id on every statement, so a consent id belonging to someone else matches
   * nothing rather than revoking their grant: the same rule the note repos follow, and it
   * matters more here because the id arrives from the browser.
   *
   * Refresh tokens go first. They are what lets a client mint new access tokens, so if only
   * one of the three deletes were to land, that is the one worth having.
   */
  async disconnect(consentId: string): Promise<boolean> {
    const consent = await this.db
      .prepare(`SELECT clientId FROM oauthConsent WHERE id = ?1 AND userId = ?2`)
      .bind(consentId, this.userId)
      .first<{ clientId: string }>();
    if (!consent) return false;

    await this.db
      .prepare(`DELETE FROM oauthRefreshToken WHERE clientId = ?1 AND userId = ?2`)
      .bind(consent.clientId, this.userId)
      .run();
    await this.db
      .prepare(`DELETE FROM oauthAccessToken WHERE clientId = ?1 AND userId = ?2`)
      .bind(consent.clientId, this.userId)
      .run();
    await this.db
      .prepare(`DELETE FROM oauthConsent WHERE id = ?1 AND userId = ?2`)
      .bind(consentId, this.userId)
      .run();
    return true;
  }
}
