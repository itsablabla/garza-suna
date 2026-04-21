import { eq } from 'drizzle-orm';
import { accounts, accountMembers, accountUser } from '@kortix/db';
import { db } from './db';
import { config } from '../config';

async function syncLegacySubscription(accountId: string): Promise<void> {
  // Self-hosted / billing-disabled deployments have no Stripe customers and no
  // basejump.billing_customers table, so the sync query fails on every account
  // resolution. Under dashboard polling load this saturates the API container
  // and surfaces as upstream 502/EOFs at the edge proxy. Gate the call on the
  // same flag the rest of the billing code uses.
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) return;

  const { syncLegacyStripeSubscription } = await import('../billing/services/legacy-stripe-sync');
  const result = await syncLegacyStripeSubscription(accountId);
  if (result.status === 'error') {
    console.warn(`[resolve-account] Stripe sync error for ${accountId}: ${result.error}`);
  }
}

export async function resolveAccountId(userId: string): Promise<string> {
  try {
    const [membership] = await db
      .select({ accountId: accountMembers.accountId })
      .from(accountMembers)
      .where(eq(accountMembers.userId, userId))
      .limit(1);

    if (membership) {
      await syncLegacySubscription(membership.accountId);
      return membership.accountId;
    }
  } catch { }

  try {
    const [legacy] = await db
      .select({ accountId: accountUser.accountId })
      .from(accountUser)
      .where(eq(accountUser.userId, userId))
      .limit(1);

    if (legacy) {
      try {
        await db.insert(accounts).values({
          accountId: legacy.accountId,
          name: 'Personal',
          personalAccount: true,
        }).onConflictDoNothing();

        await db.insert(accountMembers).values({
          userId,
          accountId: legacy.accountId,
          accountRole: 'owner',
        }).onConflictDoNothing();

        console.log(`[resolve-account] Lazy-migrated basejump account ${legacy.accountId} for user ${userId}`);
      } catch (migErr) {
        console.warn(`[resolve-account] Lazy migration failed for ${legacy.accountId}:`, migErr);
      }

      await syncLegacySubscription(legacy.accountId);

      return legacy.accountId;
    }
  } catch { }

  try {
    await db.insert(accounts).values({
      accountId: userId,
      name: 'Personal',
      personalAccount: true,
    }).onConflictDoNothing();

    await db.insert(accountMembers).values({
      userId,
      accountId: userId,
      accountRole: 'owner',
    }).onConflictDoNothing();
  } catch { }

  return userId;
}
