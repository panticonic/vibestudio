import { JSON_FLAG, type CliCommand, type ParsedInvocation } from "./commandTable.js";
import { jsonMode, printError, printResult, UsageError } from "./output.js";

export interface ModelConnectResult {
  providerId: string;
  credential: {
    id: string;
    label: string;
    lifecycle: {
      state: "active" | "expired" | "revoked";
      canRefresh: boolean;
    };
  };
}

export interface ModelCommandDependencies {
  /**
   * Run the canonical provider connection flow. The CLI owns browser/callback
   * handoff, but never token exchange or storage, and renders only this view.
   */
  connect(providerId: string): Promise<ModelConnectResult>;
}

/** Copy the public result field-by-field so an adapter cannot leak extras. */
function publicConnectResult(result: ModelConnectResult): ModelConnectResult {
  return {
    providerId: result.providerId,
    credential: {
      id: result.credential.id,
      label: result.credential.label,
      lifecycle: {
        state: result.credential.lifecycle.state,
        canRefresh: result.credential.lifecycle.canRefresh,
      },
    },
  };
}

function requireProvider(invocation: ParsedInvocation): string {
  if (invocation.positionals.length !== 1) {
    throw new UsageError("model connect requires exactly one provider");
  }
  const providerId = invocation.positionals[0]?.trim() ?? "";
  if (!providerId) throw new UsageError("model connect requires exactly one provider");
  return providerId;
}

export function createModelCommands(dependencies: ModelCommandDependencies): CliCommand[] {
  return [
    {
      group: "model",
      name: "connect",
      summary: "Connect or renew a model-provider credential",
      usage: "vibestudio model connect <provider>",
      flags: [JSON_FLAG],
      run: async (invocation) => {
        const json = jsonMode(invocation.flags["json"] === true);
        try {
          const providerId = requireProvider(invocation);
          const result = publicConnectResult(await dependencies.connect(providerId));
          printResult(result, {
            json,
            human: () => {
              console.log(`connected ${result.providerId}: ${result.credential.label}`);
              console.log(
                `future refresh: ${
                  result.credential.lifecycle.canRefresh ? "available" : "not available"
                }`
              );
            },
          });
          return 0;
        } catch (error) {
          return printError(error, { json });
        }
      },
    },
  ];
}
