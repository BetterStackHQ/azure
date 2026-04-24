import { ResourceIdParts } from "../types.js";

export function parseResourceId(resourceId: string | undefined): ResourceIdParts {
  if (!resourceId) return {};

  const parts = resourceId.split("/").filter(Boolean);
  const result: ResourceIdParts = {};

  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i].toLowerCase();
    const next = parts[i + 1];
    if (!next) continue;

    if (segment === "subscriptions") {
      result.subscriptionId = next.toLowerCase();
      i++;
    } else if (segment === "resourcegroups") {
      result.resourceGroupName = next;
      i++;
    } else if (segment === "providers") {
      result.resourceProvider = next;
      const typeSegments: string[] = [];
      let nameSegment: string | undefined;
      let j = i + 2;
      while (j < parts.length) {
        typeSegments.push(parts[j]);
        nameSegment = parts[j + 1];
        j += 2;
      }
      if (typeSegments.length > 0) {
        result.resourceType = typeSegments.join("/");
        result.resourceName = nameSegment;
      }
      break;
    }
  }

  return result;
}
