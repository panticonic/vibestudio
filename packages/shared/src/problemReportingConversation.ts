/** Launch a reporting conversation by reference; keep evidence in the draft service. */
export function problemReportingConversation(report?: {
  reportId: string;
  revision: number;
}): string {
  return report
    ? `Help me investigate and report the problem in saved draft ${report.reportId}, revision ${report.revision}. Preserve its selected evidence and help me prepare a report for my approval, using the problem-reporting skill.`
    : "Help me report a problem with Vibestudio. Ask me what went wrong and help me prepare a report for my approval, using the problem-reporting skill.";
}
