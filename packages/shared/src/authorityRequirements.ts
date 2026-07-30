import type { AuthorityRequirement, PrincipalKind } from "@vibestudio/rpc";

export function capability(
  principal: PrincipalKind,
  name: string,
  options: { codeOnly?: boolean } = {}
): AuthorityRequirement {
  return {
    kind: "capability",
    principal,
    capability: name,
    ...(options.codeOnly ? { codeOnly: true as const } : {}),
  };
}

export function allOf(...requirements: readonly AuthorityRequirement[]): AuthorityRequirement {
  if (requirements.length === 0) throw new Error("allOf requires at least one requirement");
  return { kind: "all", requirements };
}

export function anyOf(...requirements: readonly AuthorityRequirement[]): AuthorityRequirement {
  if (requirements.length === 0) throw new Error("anyOf requires at least one requirement");
  return { kind: "any", requirements };
}

export function relationship(
  name: Extract<AuthorityRequirement, { kind: "relationship" }>["name"],
  value?: string
): AuthorityRequirement {
  return { kind: "relationship", name, ...(value === undefined ? {} : { value }) };
}

export function requirementForPrincipals(
  principals: readonly PrincipalKind[],
  capabilityName: string,
  options: { codeOnly?: boolean } = {}
): AuthorityRequirement {
  const unique = [...new Set(principals)];
  if (unique.length === 0) throw new Error("An authority declaration requires a principal");
  const requirements = unique.flatMap((principal): AuthorityRequirement[] => {
    switch (principal) {
      case "host":
        return [capability("host", capabilityName)];
      case "user":
        return [allOf(capability("user", capabilityName), relationship("workspace-member"))];
      case "code": {
        const installed = allOf(
          capability("code", capabilityName),
          relationship("workspace-member")
        );
        return options.codeOnly
          ? [
              allOf(
                capability("code", capabilityName, { codeOnly: true }),
                relationship("workspace-member")
              ),
            ]
          : [
              installed,
              allOf(capability("session", capabilityName), relationship("workspace-member")),
            ];
      }
      case "session":
        return [allOf(capability("session", capabilityName), relationship("workspace-member"))];
      case "mission":
        return [allOf(capability("mission", capabilityName), relationship("workspace-member"))];
    }
  });
  return requirements.length === 1 ? requirements[0]! : anyOf(...requirements);
}
