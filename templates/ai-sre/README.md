# Better Stack AI SRE

These templates give Better Stack AI SRE read access to an Azure subscription, so it can search logs, metrics and changes while it investigates an incident. They create no secret: Better Stack signs in as a managed identity in your tenant that trusts only Better Stack's token issuer, and only for your integration.

They are separate from Better Stack's log and metric collection in the [main README](../../README.md), and share nothing with it.

## Deploy

Better Stack gives you a "Deploy to Azure" link with every parameter filled in except the region. Pick the subscription and region in the Azure Portal, then create the deployment. When it finishes, open its **Outputs**, copy `clientId` and paste it into the Azure integration in Better Stack.

You need the Owner role on the subscription, or Contributor with User Access Administrator or Role Based Access Control Administrator. Without the right to assign roles, the deployment fails on the role assignment, with an error that names 'Microsoft.Authorization/roleAssignments/write', possibly after creating the resource group and the identity. Deploy again once you have the role: it reuses what the first attempt created.

The same deployment from the Azure CLI, with the values Better Stack gives you:

```bash
az deployment sub create \
  --name betterstack-ai-sre-XXXXXXXX \
  --location <region> \
  --template-file templates/ai-sre/subscription.json \
  --parameters \
    identityName=betterstack-ai-sre-XXXXXXXX \
    resourceGroupName=betterstack-ai-sre-XXXXXXXX \
    issuer='<issuer>' \
    subject='<subject>' \
    audience=api://AzureADTokenExchange
```

## What it creates

`subscription.json` is a subscription deployment. In the subscription you deploy it to, it creates:

- a resource group, tagged `managed-by: betterstack-ai-sre`;
- in it, a user-assigned managed identity with one federated credential, both named after the integration. The credential trusts Better Stack's issuer, with your integration's subject and the default audience `api://AzureADTokenExchange`;
- the **Monitoring Reader** role for that identity on the subscription.

The role assignment's name is derived from the subscription, the identity's principal ID and the role, so deploying again after the identity was deleted and recreated makes a new assignment instead of failing.

`grant.json` gives the same identity Monitoring Reader on another subscription. Better Stack's "Grant access to another subscription" button opens it with `principalId` filled in. It uses the same role assignment name as `subscription.json`, so granting the first subscription again changes nothing.

## Parameters

`subscription.json`:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `identityName` | (required) | Name of the managed identity and its federated credential, `betterstack-ai-sre-<8 hex>`. |
| `resourceGroupName` | (required) | Resource group created for the identity, `betterstack-ai-sre-<8 hex>`. |
| `issuer` | (required) | Better Stack's token issuer. |
| `subject` | (required) | Your integration's subject, `ai-sre-azure:<integration ID>`. |
| `audience` | (required) | The audience of Better Stack's tokens, `api://AzureADTokenExchange`. |
| `location` | The deployment's region | Region of the resource group and the identity. Malaysia South doesn't support federated credentials on managed identities, so Azure refuses the credential there. |

`grant.json`:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `principalId` | (required) | Principal ID of the Better Stack AI SRE managed identity. |

Every value but the region comes from Better Stack. None of them has a default in this repository, so a link that is missing one stops at the portal's form instead of deploying a wrong value.

## What Monitoring Reader allows

Monitoring Reader is Azure's built-in role for reading monitoring data. It can read the configuration of every resource and query every log table in the subscriptions you grant, which can contain secrets. It also allows reading and opening Azure support requests. AI SRE only reads, and never opens support requests.

To narrow it, assign the role on resource groups instead of the subscription.

## Deploy again

Deploying the template again over an existing deployment keeps the identity and its client ID, and updates the credential's issuer, subject and audience in place. Pick the same region as the first time: Azure can't move a resource group to another region, and refuses the deployment.

A later release can add to what a deployment creates, never take something away. Azure keeps a role it already assigned until you remove it.

## Remove

Removing the integration in Better Stack stops its access at once. To remove what the templates created, run these in Azure Cloud Shell:

```bash
# The identity's role assignment: once for each subscription you granted
az role assignment delete --assignee <principal-id> --scope /subscriptions/<subscription-id> --yes
# The resource group, with the identity and its credential
az group delete --name betterstack-ai-sre-XXXXXXXX --subscription <subscription-id> --yes
```

Removing the role assignment is the fastest way to stop access from the Azure side. If you delete the identity or its credential instead, access can last up to 24 hours, because Azure keeps accepting a token it already issued until that token expires.

## Template contract

Better Stack fills in parameters by name, reads `clientId` from your paste, and asks customers to deploy again over what they have. So every release keeps:

- the parameter names `identityName`, `resourceGroupName`, `issuer`, `subject`, `audience` and `location` in `subscription.json`, and `principalId` in `grant.json`. Parameters are only ever added, always with a default. None is renamed or removed;
- no default on the binding parameters (`identityName`, `resourceGroupName`, `issuer`, `subject`, `audience`, `principalId`);
- the output `clientId`;
- the names of the resource group, the identity and the federated credential, whose name can't change once created;
- the role assignment's name, which includes the identity's principal ID and is the same in both templates;
- the role, Monitoring Reader: a redeploy can't take back a role already assigned;
- the resource group and the identity in the region of the `location` parameter, and the identity in the `resourceGroupName` group;
- exactly the resources listed above, each deployed unconditionally, once, from an inline template, in Incremental mode: a release adds no resource the contract doesn't record.

[`contract.json`](contract.json) records these fields. CI checks both templates against it with [`test/check_contract.py`](test/check_contract.py), which also catches mistakes a JSON parse doesn't (an undeclared parameter, unbalanced parentheses, `resourceId()` at subscription scope without the subscription ID first), and runs the check's own tests. Python 3, standard library only:

```bash
cd templates/ai-sre/test
python check_contract.py
python -m unittest -v
```

To release, see [Releasing](../../README.md#ai-sre-templates) in the main README.
