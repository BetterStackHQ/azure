"""The contract check passes on both templates and fails on each change the contract forbids, each made on a copy."""

import contextlib
import io
import os
import shutil
import tempfile
import unittest

import check_contract

TEMPLATE_DIR = check_contract.TEMPLATE_DIR


def read(name):
    with open(os.path.join(TEMPLATE_DIR, name), encoding="utf-8") as f:
        return f.read()


SUBSCRIPTION = read("subscription.json")
GRANT = read("grant.json")

SUBJECT_PARAMETER = """    "subject": {
      "type": "string",
      "metadata": {
        "description": "The subject Better Stack uses for this integration, set by Better Stack (ai-sre-azure:<integration ID>)."
      }
    },
"""

ROLE_NAME = "\"name\": \"[guid(subscription().subscriptionId, parameters('principalId'), variables('monitoringReaderRoleId'))]\""


def replace(text, old, new):
    assert text.count(old) == 1, f"the template should contain this once: {old!r}"
    return text.replace(old, new)


def run(subscription=SUBSCRIPTION, grant=GRANT):
    """check_contract's exit code and output on copies of the templates holding these texts."""
    with tempfile.TemporaryDirectory() as tmp:
        for name, text in (("subscription.json", subscription), ("grant.json", grant)):
            with open(os.path.join(tmp, name), "w", encoding="utf-8") as f:
                f.write(text)
        shutil.copy(check_contract.DEFAULT_CONTRACT, os.path.join(tmp, "contract.json"))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = check_contract.main(["--templates", tmp])
        return code, out.getvalue()


class ContractTest(unittest.TestCase):
    def assertFails(self, message, **texts):
        code, out = run(**texts)
        self.assertEqual(code, 1, out)
        self.assertIn(message, out)

    def test_the_templates_keep_their_contract(self):
        code, out = run()
        self.assertEqual(code, 0, out)

    # Parameters: Better Stack patches defaults by name, and setup links already sent pass them.

    def test_a_removed_parameter_fails(self):
        self.assertFails(
            "subscription.json: parameter subject was removed or renamed",
            subscription=replace(SUBSCRIPTION, SUBJECT_PARAMETER, ""),
        )

    def test_a_renamed_parameter_fails(self):
        self.assertFails(
            "subscription.json: parameter resourceGroupName was removed or renamed",
            subscription=SUBSCRIPTION.replace("resourceGroupName", "groupName"),
        )

    def test_a_renamed_grant_parameter_fails(self):
        self.assertFails("grant.json: parameter principalId was removed or renamed", grant=GRANT.replace("principalId", "objectId"))

    def test_a_new_parameter_without_a_default_fails(self):
        self.assertFails(
            "subscription.json: parameter extraTag has no defaultValue",
            subscription=replace(SUBSCRIPTION, SUBJECT_PARAMETER, SUBJECT_PARAMETER + '    "extraTag": { "type": "string" },\n'),
        )

    def test_a_new_parameter_must_be_recorded_in_the_contract(self):
        self.assertFails(
            "subscription.json: parameter extraTag is not recorded in contract.json",
            subscription=replace(
                SUBSCRIPTION, SUBJECT_PARAMETER, SUBJECT_PARAMETER + '    "extraTag": { "type": "string", "defaultValue": "" },\n'
            ),
        )

    def test_a_changed_default_fails(self):
        self.assertFails(
            "subscription.json: parameter location: defaultValue is \"eastus\"",
            subscription=replace(SUBSCRIPTION, '"defaultValue": "[deployment().location]"', '"defaultValue": "eastus"'),
        )

    def test_a_binding_parameter_with_a_default_fails(self):
        # A link Better Stack didn't patch must stop at the portal form, not deploy the template's own value.
        self.assertFails(
            "subscription.json: parameter audience must have no defaultValue",
            subscription=replace(
                SUBSCRIPTION, '"audience": {\n      "type": "string",', '"audience": {\n      "type": "string",\n      "defaultValue": "api://AzureADTokenExchange",'
            ),
        )

    def test_a_grant_principal_with_a_default_fails(self):
        self.assertFails(
            "grant.json: parameter principalId must have no defaultValue",
            grant=replace(GRANT, '"principalId": {\n      "type": "string",', '"principalId": {\n      "type": "string",\n      "defaultValue": "",'),
        )

    def test_a_changed_type_fails(self):
        self.assertFails(
            "subscription.json: parameter subject: type is \"securestring\"",
            subscription=replace(
                SUBSCRIPTION, '"subject": {\n      "type": "string"', '"subject": {\n      "type": "securestring"'
            ),
        )

    # The templates' scope: the Deploy to Azure link opens a subscription deployment.

    def test_a_changed_scope_fails(self):
        self.assertFails(
            "grant.json: $schema is",
            grant=GRANT.replace("2018-05-01/subscriptionDeploymentTemplate", "2019-04-01/deploymentTemplate"),
        )

    # Names: a credential's name can't change, and a new name makes a second resource next to the old one.

    def test_a_changed_resource_group_name_fails(self):
        self.assertFails(
            "subscription.json: Microsoft.Resources/resourceGroups is named",
            subscription=replace(
                SUBSCRIPTION,
                "\"name\": \"[parameters('resourceGroupName')]\"",
                "\"name\": \"[concat(parameters('resourceGroupName'), '-rg')]\"",
            ),
        )

    def test_a_changed_identity_name_fails(self):
        self.assertFails(
            "subscription.json: Microsoft.ManagedIdentity/userAssignedIdentities is named",
            subscription=replace(
                SUBSCRIPTION,
                "\"name\": \"[parameters('identityName')]\",\n              \"location\"",
                "\"name\": \"[concat('id-', parameters('identityName'))]\",\n              \"location\"",
            ),
        )

    def test_a_changed_federated_credential_name_fails(self):
        self.assertFails(
            "subscription.json: Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials is named",
            subscription=replace(
                SUBSCRIPTION,
                "concat(parameters('identityName'), '/', parameters('identityName'))",
                "concat(parameters('identityName'), '/betterstack')",
            ),
        )

    def test_a_role_assignment_named_without_the_principal_fails(self):
        # An earlier draft's name: deploying again after the identity was deleted fails with RoleAssignmentUpdateNotPermitted.
        self.assertFails(
            "subscription.json: Microsoft.Authorization/roleAssignments is named",
            subscription=replace(
                SUBSCRIPTION,
                ROLE_NAME,
                "\"name\": \"[guid(subscription().id, parameters('principalId'), variables('monitoringReaderRoleId'))]\"",
            ),
        )

    def test_role_assignment_names_that_differ_between_the_templates_fail(self):
        self.assertFails(
            "the role assignment is named differently in subscription.json and grant.json",
            grant=replace(
                GRANT,
                ROLE_NAME,
                "\"name\": \"[guid(parameters('principalId'), subscription().subscriptionId, variables('monitoringReaderRoleId'))]\"",
            ),
        )

    # What the names and the credential are made of.

    def test_a_nested_deployment_that_passes_another_value_fails(self):
        self.assertFails(
            "subscription.json: the nested deployment passes [parameters('resourceGroupName')] as identityName",
            subscription=replace(
                SUBSCRIPTION,
                "\"identityName\": { \"value\": \"[parameters('identityName')]\" }",
                "\"identityName\": { \"value\": \"[parameters('resourceGroupName')]\" }",
            ),
        )

    def test_an_issuer_not_from_its_parameter_fails(self):
        self.assertFails(
            "subscription.json: the federated credential's issuer doesn't come from the issuer parameter",
            subscription=replace(SUBSCRIPTION, "\"issuer\": \"[parameters('issuer')]\"", '"issuer": "https://example.com"'),
        )

    def test_a_role_assignment_not_on_the_identity_fails(self):
        self.assertFails(
            "subscription.json: the role assignment's principalId doesn't come from the identity's principalId",
            subscription=replace(SUBSCRIPTION, ".outputs.principalId.value]", ".outputs.clientId.value]"),
        )

    def test_another_role_fails(self):
        reader = "acdd72a7-3385-48ef-bd42-f606fba81ae7"
        self.assertFails(
            "grant.json: the role assignment grants " + reader,
            grant=GRANT.replace("43d0d8ad-25c7-4714-9337-8ba259a9fe05", reader),
        )

    def test_a_removed_output_fails(self):
        self.assertFails(
            "subscription.json: output clientId was removed",
            subscription=replace(SUBSCRIPTION, '"outputs": {\n    "clientId"', '"outputs": {\n    "identityClientId"'),
        )

    def test_a_client_id_output_that_reads_another_value_fails(self):
        self.assertFails(
            "subscription.json: output clientId doesn't come from the identity's clientId",
            subscription=replace(SUBSCRIPTION, ".outputs.clientId.value]", ".outputs.principalId.value]"),
        )

    def test_an_identity_deployment_whose_client_id_output_reads_another_value_fails(self):
        self.assertFails(
            "subscription.json: output clientId doesn't come from the identity's clientId",
            subscription=replace(
                SUBSCRIPTION,
                "parameters('identityName')), '2023-01-31').clientId]",
                "parameters('identityName')), '2023-01-31').principalId]",
            ),
        )

    def test_a_role_deployment_in_a_resource_group_fails(self):
        # Monitoring Reader would then cover only the identity's own resource group.
        self.assertFails(
            "subscription.json: the role assignment is narrowed by resourceGroup",
            subscription=replace(
                SUBSCRIPTION,
                "\"name\": \"[concat(parameters('identityName'), '-role')]\",",
                "\"name\": \"[concat(parameters('identityName'), '-role')]\",\n      \"resourceGroup\": \"[parameters('resourceGroupName')]\",",
            ),
        )

    def test_a_role_deployment_in_another_subscription_fails(self):
        self.assertFails(
            "subscription.json: the role assignment is narrowed by subscriptionId",
            subscription=replace(
                SUBSCRIPTION,
                "\"name\": \"[concat(parameters('identityName'), '-role')]\",",
                "\"name\": \"[concat(parameters('identityName'), '-role')]\",\n      \"subscriptionId\": \"00000000-0000-0000-0000-000000000000\",",
            ),
        )

    def test_a_role_assignment_with_a_scope_fails(self):
        self.assertFails(
            "grant.json: the role assignment is narrowed by scope",
            grant=replace(
                GRANT,
                "\"apiVersion\": \"2022-04-01\",",
                "\"apiVersion\": \"2022-04-01\",\n      \"scope\": \"[concat('resourceGroups/', 'x')]\",",
            ),
        )

    # Closed world: a release adds no resource, no second trust and no wider grant the contract doesn't record.

    def test_a_second_federated_credential_as_a_child_resource_fails(self):
        child = (
            '"tags": "[parameters(\'tags\')]",\n              "resources": [{"type": "federatedIdentityCredentials", '
            '"apiVersion": "2023-01-31", "name": "second", "dependsOn": ["[parameters(\'identityName\')]"], '
            '"properties": {"issuer": "https://issuer.example.net", "subject": "anyone", '
            '"audiences": ["api://AzureADTokenExchange"]}}]'
        )
        self.assertFails(
            "subscription.json: 2 resources of type Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials, "
            "the contract records 1",
            subscription=replace(SUBSCRIPTION, "\"tags\": \"[parameters('tags')]\"", child),
        )

    def test_a_linked_template_deployment_fails(self):
        linked = (
            '"tags": "[variables(\'tags\')]"\n    },\n    {"type": "Microsoft.Resources/deployments", "apiVersion": "2024-03-01", '
            '"name": "extra", "location": "[parameters(\'location\')]", '
            '"properties": {"mode": "Incremental", "templateLink": {"uri": "https://example.com/template.json"}}},'
        )
        self.assertFails(
            "subscription.json: the deployment extra uses templateLink",
            subscription=replace(SUBSCRIPTION, "\"tags\": \"[variables('tags')]\"\n    },", linked),
        )

    def test_a_resource_of_an_unrecorded_type_fails(self):
        lock = (
            '"tags": "[variables(\'tags\')]"\n    },\n    {"type": "Microsoft.Authorization/locks", "apiVersion": "2020-05-01", '
            '"name": "lock", "properties": {"level": "CanNotDelete"}},'
        )
        self.assertFails(
            "subscription.json: resource type Microsoft.Authorization/locks is not recorded in contract.json",
            subscription=replace(SUBSCRIPTION, "\"tags\": \"[variables('tags')]\"\n    },", lock),
        )

    def test_a_condition_on_the_role_assignment_fails(self):
        self.assertFails(
            "subscription.json: Microsoft.Authorization/roleAssignments has a condition",
            subscription=replace(
                SUBSCRIPTION,
                '"type": "Microsoft.Authorization/roleAssignments",',
                '"type": "Microsoft.Authorization/roleAssignments",\n              "condition": false,',
            ),
        )

    def test_a_condition_on_the_federated_credential_fails(self):
        self.assertFails(
            "subscription.json: Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials has a condition",
            subscription=replace(
                SUBSCRIPTION,
                '"type": "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials",',
                '"type": "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials",\n              "condition": false,',
            ),
        )

    def test_a_condition_on_the_grant_role_assignment_fails(self):
        self.assertFails(
            "grant.json: Microsoft.Authorization/roleAssignments has a condition",
            grant=replace(
                GRANT,
                '"type": "Microsoft.Authorization/roleAssignments",',
                '"type": "Microsoft.Authorization/roleAssignments",\n      "condition": "[equals(1, 2)]",',
            ),
        )

    def test_a_copy_loop_fails(self):
        self.assertFails(
            "grant.json: Microsoft.Authorization/roleAssignments has a copy loop",
            grant=replace(
                GRANT,
                '"type": "Microsoft.Authorization/roleAssignments",',
                '"type": "Microsoft.Authorization/roleAssignments",\n      "copy": {"name": "grants", "count": 2},',
            ),
        )

    def test_a_complete_mode_deployment_fails(self):
        self.assertFails(
            "subscription.json: the deployment [parameters('identityName')] runs in mode Complete",
            subscription=replace(
                SUBSCRIPTION,
                '"mode": "Incremental",\n        "expressionEvaluationOptions": {\n          "scope": "inner"\n        },\n        "parameters": {\n          "identityName"',
                '"mode": "Complete",\n        "expressionEvaluationOptions": {\n          "scope": "inner"\n        },\n        "parameters": {\n          "identityName"',
            ),
        )

    # Where the resource group and the identity land: a redeploy must find them where the first deployment put them.

    def test_a_resource_group_location_not_from_its_parameter_fails(self):
        self.assertFails(
            "subscription.json: Microsoft.Resources/resourceGroups's location doesn't come from the location parameter",
            subscription=replace(
                SUBSCRIPTION,
                "\"location\": \"[parameters('location')]\",\n      \"tags\": \"[variables('tags')]\"",
                "\"location\": \"[deployment().location]\",\n      \"tags\": \"[variables('tags')]\"",
            ),
        )

    def test_an_identity_location_not_from_its_parameter_fails(self):
        self.assertFails(
            "subscription.json: Microsoft.ManagedIdentity/userAssignedIdentities's location doesn't come from the location parameter",
            subscription=replace(
                SUBSCRIPTION,
                "\"location\": \"[parameters('location')]\",\n              \"tags\": \"[parameters('tags')]\"",
                "\"location\": \"westeurope\",\n              \"tags\": \"[parameters('tags')]\"",
            ),
        )

    def test_an_identity_in_another_resource_group_fails(self):
        self.assertFails(
            "subscription.json: Microsoft.ManagedIdentity/userAssignedIdentities isn't deployed into the resourceGroupName resource group",
            subscription=replace(
                SUBSCRIPTION,
                "\"resourceGroup\": \"[parameters('resourceGroupName')]\"",
                "\"resourceGroup\": \"[parameters('identityName')]\"",
            ),
        )

    def test_an_identity_in_another_subscription_fails(self):
        self.assertFails(
            "subscription.json: Microsoft.ManagedIdentity/userAssignedIdentities is deployed with a subscriptionId",
            subscription=replace(
                SUBSCRIPTION,
                "\"resourceGroup\": \"[parameters('resourceGroupName')]\"",
                "\"resourceGroup\": \"[parameters('resourceGroupName')]\",\n      \"subscriptionId\": \"00000000-0000-0000-0000-000000000000\"",
            ),
        )

    # The lint: what a JSON parse doesn't catch and Azure refuses at deployment time.

    def test_a_resource_group_resource_id_without_the_subscription_fails(self):
        # As an earlier draft had it: at subscription scope, the first argument is read as a subscription ID.
        broken = SUBSCRIPTION.replace(
            "resourceId(subscription().subscriptionId, parameters('resourceGroupName'), 'Microsoft.Resources/deployments'",
            "resourceId(parameters('resourceGroupName'), 'Microsoft.Resources/deployments'",
        )
        self.assertFails("subscription.json: resourceId(parameters('resourceGroupName'), ...) at subscription scope", subscription=broken)

    def test_an_undeclared_parameter_fails(self):
        self.assertFails(
            "subscription.json: parameters('identityNam') isn't declared",
            subscription=replace(SUBSCRIPTION, "\"tags\": \"[parameters('tags')]\"", "\"tags\": \"[parameters('identityNam')]\""),
        )

    def test_an_undeclared_variable_fails(self):
        self.assertFails(
            "grant.json: variables('readerRoleId') isn't declared",
            grant=replace(
                GRANT,
                "\"roleDefinitionId\": \"[subscriptionResourceId('Microsoft.Authorization/roleDefinitions', variables('monitoringReaderRoleId'))]\"",
                "\"roleDefinitionId\": \"[subscriptionResourceId('Microsoft.Authorization/roleDefinitions', variables('readerRoleId'))]\"",
            ),
        )

    def test_unbalanced_parentheses_fail(self):
        self.assertFails(
            "grant.json: unbalanced parentheses in",
            grant=replace(GRANT, "\"principalId\": \"[parameters('principalId')]\"", "\"principalId\": \"[parameters('principalId']\""),
        )

    def test_invalid_json_fails(self):
        self.assertFails("grant.json: not valid JSON", grant=GRANT.replace('"resources": [', '"resources": ', 1))


if __name__ == "__main__":
    unittest.main()
