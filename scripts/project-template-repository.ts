import {
  applyReviewedTemplateRepositoryExchange,
  parseTemplateExchangeArguments,
  planTemplateRepositoryExchange,
} from "@vibestudio/workspace/templateRepositoryExchange";

const args = parseTemplateExchangeArguments(process.argv.slice(2));
const plan = planTemplateRepositoryExchange(args);
process.stdout.write(
  `${JSON.stringify(
    args.apply ? applyReviewedTemplateRepositoryExchange(plan, args.operationId!) : plan,
    null,
    2
  )}\n`
);
