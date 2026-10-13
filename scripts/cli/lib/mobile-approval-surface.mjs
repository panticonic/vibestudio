function decodeXmlAttribute(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attribute(node, name) {
  const match = node.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? decodeXmlAttribute(match[1]) : "";
}

/**
 * Read the lifecycle state of the shared mobile approval surface from an
 * Android accessibility snapshot. A disabled decision button is still an
 * active approval: it means the submitted decision is landing and the caller
 * must keep ownership until the surface advances or retires.
 */
export function mobileApprovalSurfaceState(xml) {
  let visible = false;
  let canLoadRemaining = false;
  let unavailableOwners = "";
  const nodes = xml.match(/<node\b[^>]*>/g) ?? [];
  for (const node of nodes) {
    const resourceId = attribute(node, "resource-id");
    const label = attribute(node, "text") || attribute(node, "content-desc");
    if (resourceId === "approval-action-dismiss" || label === "Dismiss approval") {
      visible = true;
    }
    if (/^More reviews in .+\.$/.test(label)) unavailableOwners = label;
    if (
      label === "Load remaining reviews" &&
      attribute(node, "enabled") !== "false" &&
      attribute(node, "clickable") === "true"
    ) {
      canLoadRemaining = true;
    }
  }
  return {
    visible,
    loadRemainingKey: canLoadRemaining ? unavailableOwners || "remaining" : null,
  };
}
