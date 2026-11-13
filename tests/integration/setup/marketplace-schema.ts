/**
 * schema.prisma as production had it before marketplace-generic.migration.sql:
 * without Organization.source and MarketplaceUsageDay. The two migration
 * specs build their "before" schemas from it.
 */
export function withoutGenericMarketplace(schema: string): string {
  const out = schema
    .replace(/\n  \/\/\/ Where the customer came from[\s\S]*?\n  source +String +@default\("DIRECT"\)/, '')
    .replace(/\n\/\/ Calls through the marketplace gateway[\s\S]*?\nmodel MarketplaceUsageDay \{[\s\S]*?\n\}\n?/, '\n');
  if (/MarketplaceUsageDay|@default\("DIRECT"\)/.test(out)) {
    throw new Error('schema.prisma changed: update withoutGenericMarketplace');
  }
  return out;
}
