#!/usr/bin/env python3
"""Checks the AI SRE templates (subscription.json and grant.json) against their contract, recorded in contract.json.

Fails when a parameter is removed or renamed, a recorded parameter's type or default changes, a binding parameter gains a
default, a new parameter has no default or isn't recorded yet, the clientId output goes, the scope changes, the name of
the resource group, the identity, its federated credential or the role assignment changes, the role assignment is named
differently in the two templates, the federated credential stops taking its issuer, subject and audience from their
parameters, the role assignment stops naming the identity's principal or grants another role, the resource group or
the identity moves away from the location and resourceGroupName parameters, or a resource is added, removed, made
conditional, looped, linked from another template or deployed in a mode other than Incremental. A change to any of these
is a change of contract: make it on purpose, in contract.json, in the same pull request.

It also lints what a JSON parse doesn't catch and Azure only refuses at deployment time: an expression whose
parentheses don't balance, a parameter or variable that isn't declared in its scope, a nested deployment whose
expressions are evaluated in the outer scope, and resourceId() at subscription scope without the subscription ID first.

Standard library only. Usage: check_contract.py [--templates DIR] [--contract CONTRACT]
"""

import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_DIR = os.path.normpath(os.path.join(HERE, ".."))
DEFAULT_CONTRACT = os.path.join(TEMPLATE_DIR, "contract.json")

DEPLOYMENTS = "Microsoft.Resources/deployments"
ROLE_ASSIGNMENTS = "Microsoft.Authorization/roleAssignments"
IDENTITIES = "Microsoft.ManagedIdentity/userAssignedIdentities"
FEDERATED_CREDENTIALS = "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials"
RECORDED_PARAMETER_FIELDS = ("type", "defaultValue")
REFERENCE = re.compile(r"(?<![A-Za-z])(parameters|variables)\('([^']*)'\)")
RESOURCE_ID = re.compile(r"(?<![A-Za-z])resourceId\(")
ONLY_PARAMETER = re.compile(r"\[parameters\('([^']*)'\)\]")


# --- Walking a template ---------------------------------------------------------------------------------------------


class Scope:
    """One template body and the nested deployments that lead to it, outermost first."""

    def __init__(self, template, chain):
        self.template = template
        self.chain = chain

    @property
    def at_subscription(self):
        return "subscriptionDeploymentTemplate" in self.template.get("$schema", "")

    def declared(self, kind):
        return self.template.get(kind) or {}


def scopes(template, chain=()):
    yield Scope(template, list(chain))
    for resource in template.get("resources", []):
        nested = resource.get("properties", {}).get("template") if resource.get("type") == DEPLOYMENTS else None
        if isinstance(nested, dict):
            yield from scopes(nested, list(chain) + [resource])


def full_type(child_type, parent_type):
    """A child resource's type as ARM resolves it: a short type is appended to its parent's."""
    if parent_type is None or child_type.lower().startswith(parent_type.split("/")[0].lower() + "/"):
        return child_type
    return f"{parent_type}/{child_type}"


def with_children(resource_list, parent_type=None):
    """(resource, full type) for each resource in RESOURCE_LIST and, recursively, its child resources."""
    for resource in resource_list if isinstance(resource_list, list) else []:
        if not isinstance(resource, dict):
            continue
        resource_type = full_type(str(resource.get("type", "")), parent_type)
        yield resource, resource_type
        yield from with_children(resource.get("resources", []), resource_type)


def resources(template):
    """(resource, scope, full type) for every resource: child resources and nested deployments' resources included."""
    for scope in scopes(template):
        for resource, resource_type in with_children(scope.template.get("resources", [])):
            yield resource, scope, resource_type


def strings(value):
    """Every string in VALUE. A deployment resource's own template is another scope, so it is skipped."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)
    elif isinstance(value, dict):
        is_deployment = value.get("type") == DEPLOYMENTS
        for key, item in value.items():
            if is_deployment and key == "properties" and isinstance(item, dict):
                item = {k: v for k, v in item.items() if k != "template"}
            yield from strings(item)


def scope_strings(scope):
    body = {k: v for k, v in scope.template.items() if k in ("variables", "resources", "outputs")}
    params = {name: {k: v for k, v in p.items() if k == "defaultValue"} for name, p in scope.declared("parameters").items()}
    return list(strings(body)) + list(strings(params))


def trace(expression, chain):
    """The top-level parameter EXPRESSION comes from, through the nested deployments in CHAIN, or None."""
    match = ONLY_PARAMETER.fullmatch(expression) if isinstance(expression, str) else None
    if not match:
        return None
    if not chain:
        return match.group(1)
    passed = chain[-1].get("properties", {}).get("parameters", {}).get(match.group(1), {}).get("value")
    return trace(passed, chain[:-1])


def substitute_variables(expression, scope):
    variables = scope.declared("variables")

    def value(match):
        found = variables.get(match.group(2))
        return f"'{found}'" if match.group(1) == "variables" and isinstance(found, str) else match.group(0)

    return REFERENCE.sub(value, expression)


# --- Lint -----------------------------------------------------------------------------------------------------------


def balanced(expression):
    depth, quoted = 0, False
    for char in expression[1:-1]:
        if char == "'":
            quoted = not quoted
        elif not quoted and char == "(":
            depth += 1
        elif not quoted and char == ")":
            depth -= 1
            if depth < 0:
                return False
    return depth == 0 and not quoted


def first_argument(expression, start):
    depth, quoted, i = 0, False, start
    while i < len(expression):
        char = expression[i]
        if char == "'":
            quoted = not quoted
        elif not quoted and char == "(":
            depth += 1
        elif not quoted and char in ",)" and depth == 0:
            return expression[start:i].strip()
        elif not quoted and char == ")":
            depth -= 1
        i += 1
    return expression[start:].strip()


def lint(template):
    errors = []
    for scope in scopes(template):
        for resource in scope.template.get("resources", []):
            if resource.get("type") == DEPLOYMENTS and "template" in resource.get("properties", {}):
                evaluation = resource["properties"].get("expressionEvaluationOptions", {}).get("scope", "outer")
                if evaluation.lower() != "inner":
                    errors.append(
                        f"the nested deployment {resource.get('name')} evaluates its expressions in the outer scope: "
                        "set expressionEvaluationOptions.scope to inner"
                    )
        for expression in scope_strings(scope):
            if not expression.startswith("[") or expression.startswith("[["):
                continue
            if not expression.endswith("]") or not balanced(expression):
                errors.append(f"unbalanced parentheses in {expression}")
                continue
            for kind, name in REFERENCE.findall(expression):
                if name not in scope.declared(kind):
                    errors.append(f"{kind}('{name}') isn't declared in its scope, in {expression}")
            if scope.at_subscription:
                for match in RESOURCE_ID.finditer(expression):
                    first = first_argument(expression, match.end())
                    if first != "subscription().subscriptionId" and not re.fullmatch(r"'[^']*/[^']*'", first):
                        errors.append(
                            f"resourceId({first}, ...) at subscription scope reads {first} as a subscription ID: "
                            "pass subscription().subscriptionId first"
                        )
    return errors


# --- Contract -------------------------------------------------------------------------------------------------------


def check_parameters(template, contract):
    errors = []
    parameters = template.get("parameters", {})
    recorded = contract["parameters"]
    binding = set(contract.get("binding_parameters", []))
    for name, fields in recorded.items():
        if name not in parameters:
            errors.append(f"parameter {name} was removed or renamed: Better Stack patches it by name")
            continue
        for field in RECORDED_PARAMETER_FIELDS:
            if parameters[name].get(field) != fields.get(field):
                errors.append(
                    f"parameter {name}: {field} is {json.dumps(parameters[name].get(field))}, "
                    f"the contract records {json.dumps(fields.get(field))}"
                )
    for name, fields in parameters.items():
        if name in binding:
            if "defaultValue" in fields:
                errors.append(
                    f"parameter {name} must have no defaultValue: a link Better Stack didn't patch would deploy it"
                )
            continue
        if "defaultValue" not in fields:
            errors.append(f"parameter {name} has no defaultValue: every link and redeploy already made would stop on it")
        if name not in recorded:
            errors.append(f"parameter {name} is not recorded in contract.json: add it there, with its fields")
    return errors


def check_wiring(template):
    """A nested deployment passes each parameter of its parent's on under the same name, unchanged."""
    errors = []
    for scope in scopes(template):
        declared = scope.declared("parameters")
        for resource in scope.template.get("resources", []):
            if resource.get("type") != DEPLOYMENTS:
                continue
            for name, passed in resource.get("properties", {}).get("parameters", {}).items():
                value = passed.get("value") if isinstance(passed, dict) else None
                if name in declared and value != f"[parameters('{name}')]":
                    errors.append(f"the nested deployment passes {value} as {name}, not the {name} parameter")
    return errors


def find(template, resource_type):
    return [(r, s) for r, s, t in resources(template) if t.lower() == resource_type.lower()]


def check_inventory(template, contract):
    """Closed world: exactly the recorded resources, each deployed unconditionally, once, from an inline template."""
    errors = []
    counts = {}
    for resource, scope, resource_type in resources(template):
        counts[resource_type] = counts.get(resource_type, 0) + 1
        if "condition" in resource:
            errors.append(f"{resource_type} has a condition: a release must not drop it for some deployments")
        if "copy" in resource or "copy" in (resource.get("properties") or {}):
            errors.append(f"{resource_type} has a copy loop: the contract records how many of each resource there are")
        if resource_type == DEPLOYMENTS:
            props = resource.get("properties") or {}
            name = resource.get("name")
            if "templateLink" in props or "template" not in props:
                errors.append(f"the deployment {name} uses templateLink: the check can only read an inline template")
            if props.get("mode") != "Incremental":
                errors.append(
                    f"the deployment {name} runs in mode {props.get('mode')}, not Incremental: "
                    "Complete mode deletes what it doesn't list"
                )
    recorded = {t.lower(): (t, n) for t, n in contract["resources"].items()}
    found = {t.lower(): (t, n) for t, n in counts.items()}
    for key, (resource_type, count) in found.items():
        if key not in recorded:
            errors.append(f"resource type {resource_type} is not recorded in contract.json: a release adds nothing unrecorded")
    for key, (resource_type, count) in recorded.items():
        actual = found.get(key, (resource_type, 0))[1]
        if actual != count:
            errors.append(f"{actual} resources of type {resource_type}, the contract records {count}")
    return errors


def check_placement(template, contract):
    """The resource group and the identity land where the parameters say, so a redeploy finds them again."""
    errors = []
    for resource_type, expected in contract.get("placement", {}).items():
        found = find(template, resource_type)
        if len(found) != 1:
            continue
        (resource, scope), = found
        if "location" in expected and trace(resource.get("location"), scope.chain) != expected["location"]:
            errors.append(f"{resource_type}'s location doesn't come from the {expected['location']} parameter")
        if "resourceGroup" in expected:
            holder = scope.chain[-1] if scope.chain else {}
            if trace(holder.get("resourceGroup"), scope.chain[:-1]) != expected["resourceGroup"]:
                errors.append(f"{resource_type} isn't deployed into the {expected['resourceGroup']} resource group")
            if any("subscriptionId" in deployment for deployment in scope.chain):
                errors.append(f"{resource_type} is deployed with a subscriptionId: it belongs in the subscription deployed to")
    return errors


def check_names(template, contract):
    errors = []
    for resource_type, expected in contract["names"].items():
        found = find(template, resource_type)
        if len(found) != 1:
            continue
        name = found[0][0].get("name")
        if name != expected:
            errors.append(
                f"{resource_type} is named {json.dumps(name)}, the contract records {json.dumps(expected)}: "
                "what customers deployed carries the recorded name, so a redeploy would add a second one or fail"
            )
    return errors


def check_federated_credential(template, contract):
    expected = contract.get("federated_credential")
    found = find(template, FEDERATED_CREDENTIALS)
    if not expected or len(found) != 1:
        return []
    (credential, scope), = found
    props = credential.get("properties", {})
    errors = []
    for field, parameter in expected.items():
        values = props.get(field)
        if isinstance(parameter, list):
            ok = isinstance(values, list) and len(values) == len(parameter) and all(
                trace(v, scope.chain) == p for v, p in zip(values, parameter)
            )
            parameter = ", ".join(parameter)
        else:
            ok = trace(values, scope.chain) == parameter
        if not ok:
            errors.append(f"the federated credential's {field} doesn't come from the {parameter} parameter")
    return errors


def check_role(template, contract):
    errors = []
    for assignment, scope in find(template, ROLE_ASSIGNMENTS):
        props = assignment.get("properties", {})
        role = substitute_variables(props.get("roleDefinitionId", ""), scope)
        name = substitute_variables(assignment.get("name", ""), scope)
        if contract_role(contract) not in role or contract_role(contract) not in name:
            granted = re.findall(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", role) or [role]
            errors.append(
                f"the role assignment grants {granted[0]}, the contract records Monitoring Reader "
                f"({contract_role(contract)}): a redeploy can't take a role back"
            )
        narrowing = [("scope", assignment)] + [(key, d) for d in scope.chain for key in ("resourceGroup", "subscriptionId")]
        for key, holder in narrowing:
            if key in holder:
                errors.append(
                    f"the role assignment is narrowed by {key} {json.dumps(holder[key])}: "
                    "Monitoring Reader must land on the whole subscription the template is deployed to"
                )
        if props.get("principalType") != "ServicePrincipal":
            errors.append("the role assignment needs principalType ServicePrincipal, for an identity this new")
        source = contract.get("principal_id_from")
        principal = props.get("principalId")
        if source:
            passed = None
            if ONLY_PARAMETER.fullmatch(principal or "") and scope.chain:
                parameter = ONLY_PARAMETER.fullmatch(principal).group(1)
                passed = scope.chain[-1].get("properties", {}).get("parameters", {}).get(parameter, {}).get("value")
            if not (
                isinstance(passed, str)
                and passed.endswith(f".{source}]")
                and DEPLOYMENTS in passed
                and from_identity(identity_output(template, "principalId"), "principalId")
            ):
                errors.append("the role assignment's principalId doesn't come from the identity's principalId output")
        elif trace(principal, scope.chain) != "principalId":
            errors.append("the role assignment's principalId doesn't come from the principalId parameter")
    return errors


def contract_role(contract):
    return contract["role_definition_id"]


def identity_output(template, name):
    """The value the scope holding the managed identity outputs as NAME, or None."""
    for identity, scope in find(template, IDENTITIES):
        return (scope.template.get("outputs", {}).get(name) or {}).get("value")
    return None


def from_identity(expression, field):
    """Whether EXPRESSION reads the managed identity's FIELD."""
    return (
        isinstance(expression, str)
        and IDENTITIES in expression
        and expression.startswith("[reference(")
        and expression.endswith(f").{field}]")
    )


def check_outputs(template, contract):
    errors = [f"output {name} was removed" for name in contract["outputs"] if name not in template.get("outputs", {})]
    source = contract.get("client_id_from")
    if source and "clientId" in template.get("outputs", {}):
        value = template["outputs"]["clientId"].get("value")
        if not (
            isinstance(value, str)
            and DEPLOYMENTS in value
            and value.endswith(f".{source}]")
            and from_identity(identity_output(template, "clientId"), "clientId")
        ):
            errors.append("output clientId doesn't come from the identity's clientId: customers paste it into Better Stack")
    return errors


def check_template(template, contract):
    errors = []
    if template.get("$schema") != contract["schema"]:
        errors.append(
            f"$schema is {json.dumps(template.get('$schema'))}, the contract records {json.dumps(contract['schema'])}: "
            "the Deploy to Azure link opens a subscription deployment"
        )
    return (
        errors
        + check_parameters(template, contract)
        + check_outputs(template, contract)
        + check_inventory(template, contract)
        + check_names(template, contract)
        + check_placement(template, contract)
        + check_wiring(template)
        + check_federated_credential(template, contract)
        + check_role(template, contract)
        + lint(template)
    )


def role_assignment_names(templates):
    names = {}
    for name, template in templates.items():
        found = find(template, ROLE_ASSIGNMENTS)
        if len(found) == 1:
            names[name] = found[0][0].get("name")
    return names


def check(templates, contract):
    """Every contract violation, each prefixed with its template's file name, for the parsed TEMPLATES."""
    errors = []
    for name, recorded in contract["templates"].items():
        if name in templates:
            recorded = dict(recorded, role_definition_id=contract["role_definition_id"])
            errors += [f"{name}: {error}" for error in check_template(templates[name], recorded)]
    names = role_assignment_names(templates)
    if len(set(names.values())) > 1:
        errors.append(
            "the role assignment is named differently in "
            + " and ".join(sorted(names, reverse=True))
            + ": granting the home subscription again would fail with RoleAssignmentExists instead of doing nothing"
        )
    return errors


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--templates", default=TEMPLATE_DIR, help="directory holding the templates")
    parser.add_argument("--contract", help="contract.json (default: the one in --templates)")
    args = parser.parse_args(argv)
    contract = load(args.contract or os.path.join(args.templates, "contract.json"))

    errors, templates = [], {}
    for name in contract["templates"]:
        path = os.path.join(args.templates, name)
        try:
            templates[name] = load(path)
        except FileNotFoundError:
            errors.append(f"{name}: missing")
        except json.JSONDecodeError as e:
            errors.append(f"{name}: not valid JSON ({e})")
    errors += check(templates, contract)

    for error in errors:
        print(f"FAIL {error}")
    if errors:
        print(f"{len(errors)} contract violation(s). If the change is intended, change contract.json on purpose.")
        return 1
    print(f"{', '.join(contract['templates'])} keep their contract")
    return 0


if __name__ == "__main__":
    sys.exit(main())
