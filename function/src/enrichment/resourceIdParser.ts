// The function only needs the subscription ID to look up subscription friendly
// names; the full resource-ID destructuring (resource group, provider, type,
// name) is performed by the ingester-side AzureMapper.
export function parseSubscriptionId(resourceId: string | undefined): string | undefined {
  if (!resourceId) return undefined;

  const parts = resourceId.split("/").filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i].toLowerCase() === "subscriptions") {
      return parts[i + 1].toLowerCase();
    }
  }
  return undefined;
}
