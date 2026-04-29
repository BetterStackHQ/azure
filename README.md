# Better Stack Azure Integration

ARM templates that connect an Azure subscription to [Better Stack](https://betterstack.com) for metric collection, activity-log forwarding, and per-resource log forwarding.

## How it works

Better Stack reads **metrics** from your subscription via the Azure Monitor REST API, authenticating as a service principal that's created in your tenant when you grant admin consent through the Better Stack dashboard.

**Logs** are routed through resources that the templates in this repo deploy: an Event Hub Namespace, an Azure Function (Node.js 22, Consumption plan), and a Storage account. Diagnostic settings — created by the template for activity logs and by Better Stack for per-resource logs — send events to the Event Hub. The Function consumes them, attaches a small amount of context (operation display name, subscription name) for downstream search, and forwards gzipped NDJSON batches to Better Stack over HTTPS.

The Function authenticates to its dependencies via system-assigned managed identity. The only secret stored in your tenant is the Better Stack source token, kept as an encrypted Function App setting.

## Quick start

[Create a new Azure source in Better Stack](https://telemetry.betterstack.com/team/t0/sources/new?platform=azure). The source-creation flow walks you through admin consent and then hands you a "Deploy to Azure" link with every template parameter pre-filled — service principal object ID, source ID, source token, and ingestion host. Click it, pick the resource group, and deploy.

You'll need an Azure account with **Owner** on the target subscription (for the recommended subscription-level deployment) or resource group (for the resource-group-only variant).

## What gets deployed

Inside the resource group:

- **Event Hub Namespace** (Standard SKU) hosting an Event Hub `logs` with 4 partitions and 1-day retention, plus a `betterstack-consumer-group` consumer group and a `DiagnosticSettingsSend` authorization rule.
- **Storage Account** required by the Functions host runtime.
- **App Service Plan** (Y1 Consumption) and **Function App** (Linux, Node.js 22) running the log forwarder.

For subscription-level deployments, three additional resources are created at subscription scope:

- An activity-log diagnostic setting routing all activity-log categories to the Event Hub.
- A role assignment giving the Better Stack SP `Monitoring Contributor` on the subscription.
- A role assignment giving the Function's managed identity `Reader` on the subscription (used for subscription-name enrichment).

## RBAC granted

| Identity | Role | Scope | Purpose |
|----------|------|-------|---------|
| Better Stack SP | Monitoring Contributor | Subscription / RG | Create and modify per-resource diagnostic settings; subsumes Monitoring Reader and Reader |
| Better Stack SP | Event Hubs Data Owner | Event Hub namespace | Resolve the `DiagnosticSettingsSend` rule when wiring per-resource diagnostic settings |
| Function MI | Event Hubs Data Receiver | Event Hub namespace | Consume from the `logs` hub |
| Function MI | Storage Blob Data Owner, Storage Queue Data Contributor, Storage Account Contributor | Function's storage account | Functions host internals (leases, key rotation, internal queues) |
| Function MI | Reader | Subscription / RG | `subscriptions.list()` for subscription-name enrichment |

Better Stack itself authenticates from outside your tenant via a multi-tenant app and client secret kept in Better Stack infrastructure. No Better Stack credentials are stored in your tenant.

## Verifying the deployment

The Function App begins consuming events almost immediately after deployment. To watch it:

```bash
az functionapp log tail --resource-group rg-betterstack --name <function-app-name>
```

Activity-log events typically begin flowing within a few minutes. Per-resource logs and metrics begin once Better Stack registers the integration on our side.

## Uninstall

```bash
# Remove the resource group and every regional Event Hub / Function inside it
az group delete --name rg-betterstack
```

For subscription-level deployments, the subscription-scope resources are not removed by deleting the resource group — clean them up explicitly:

```bash
# Activity-log diagnostic setting (substitute your sourceId and home region)
az monitor diagnostic-settings subscription delete \
  --name betterstack-activity-logs-<sourceId>-<region>

# Role assignment for the Better Stack SP
az role assignment delete \
  --assignee <service-principal-object-id> \
  --role "Monitoring Contributor"
```

The Function MI's `Reader` role assignment is cleaned up automatically when the Function App is deleted with the resource group.

## Deploying manually

If you'd rather skip the Better Stack dashboard's pre-filled portal link, you can deploy any of the templates directly. You'll need to fill in each parameter yourself; the values still come from the source you create at https://telemetry.betterstack.com/team/t0/sources/new?platform=azure.

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `servicePrincipalObjectId` | Yes | — | Object ID of the Better Stack service principal (created in your tenant during admin consent) |
| `location` | Yes | — | Azure region for all resources |
| `betterStackSourceId` | Yes | — | Better Stack source ID with 's' prefix (e.g. `s12345`) |
| `betterStackSourceToken` | Yes | — | Better Stack source token for log ingestion |
| `betterStackIngestingHost` | Yes | — | Better Stack log ingestion endpoint |
| `functionPackageUri` | No | Pinned release URL | Override to point the Function at a custom deployment zip |

### Subscription-level deployment

Deploys into a resource group of your choice, then creates the subscription-scope role assignments and the activity-log diagnostic setting via a nested cross-scope deployment.

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FBetterStackHQ%2Fazure%2Fmain%2Fsubscription.json)

```bash
az group create --name rg-betterstack --location <region>
az deployment group create \
  --resource-group rg-betterstack \
  --template-file subscription.json \
  --parameters \
    servicePrincipalObjectId='<object-id>' \
    betterStackSourceId='<source-id>' \
    betterStackSourceToken='<source-token>' \
    betterStackIngestingHost='<ingesting-host>'
```

### Resource-group-level deployment

Use this to limit Better Stack to a single resource group. Activity-log forwarding is not available in this mode — activity logs are subscription-scope.

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FBetterStackHQ%2Fazure%2Fmain%2FresourceGroup.json)

```bash
az group create --name rg-betterstack --location <region>
az deployment group create \
  --resource-group rg-betterstack \
  --template-file resourceGroup.json \
  --parameters \
    servicePrincipalObjectId='<object-id>' \
    betterStackSourceId='<source-id>' \
    betterStackSourceToken='<source-token>' \
    betterStackIngestingHost='<ingesting-host>'
```

### Adding more regions

Azure requires resource-log diagnostic settings to target an Event Hub in the same region as the resource. If you have resources outside your home region, run `region.json` once per additional region into the same resource group:

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FBetterStackHQ%2Fazure%2Fmain%2Fregion.json)

```bash
az deployment group create \
  --resource-group rg-betterstack \
  --template-file region.json \
  --parameters \
    location='<region>' \
    betterStackSourceId='<source-id>' \
    betterStackSourceToken='<source-token>' \
    betterStackIngestingHost='<ingesting-host>'
```

`region.json` creates only a regional Event Hub and Function. It reuses the role assignments and the activity-log diagnostic setting from your subscription-level deployment, which always stays tied to a single home region.

## Releasing

To release a new version of the Function:

1. Update the version in the `functionPackageUri` default value in `subscription.json`, `resourceGroup.json`, and `region.json` (the URL ends with `function-v<version>/function.zip`).
2. Commit and push the changes.
3. Tag the commit with `function-v<version>` and push the tag:

   ```bash
   git tag function-v<version>
   git push origin function-v<version>
   ```

The tag triggers the release workflow, which builds and publishes `function.zip` to the matching GitHub release.

## License

[MIT](LICENSE)
