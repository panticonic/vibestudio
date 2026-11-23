import { expect, it } from "vitest";
import { readWorkspacePreparationTemplates } from "./workspacePreparationTemplates.js";
const pin = {
  url: "git+https://example.test/template.git",
  ref: "refs/tags/v1",
  commit: "a".repeat(40),
};
const defaults = {
  base: pin,
  personal: { ...pin, commit: "b".repeat(40) },
  system: { ...pin, commit: "c".repeat(40) },
};
it("keeps creation defaults separate from exhaustive selected-template preparation", () => {
  const selected = { ...defaults, news: { ...pin, commit: "d".repeat(40) } };
  const env = {
    VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES: JSON.stringify(defaults),
    VIBESTUDIO_PREPARE_WORKSPACE_TEMPLATES: JSON.stringify(selected),
  };
  expect(readWorkspacePreparationTemplates("unused", env)).toEqual(selected);
  expect(
    readWorkspacePreparationTemplates("unused", {
      VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES: JSON.stringify(defaults),
    })
  ).toEqual(defaults);
  expect(() =>
    readWorkspacePreparationTemplates("unused", {
      ...env,
      VIBESTUDIO_PREPARE_WORKSPACE_TEMPLATES: JSON.stringify({ ...selected, base: selected.news }),
    })
  ).toThrow("differs");
  expect(() =>
    readWorkspacePreparationTemplates("unused", {
      ...env,
      VIBESTUDIO_PREPARE_WORKSPACE_TEMPLATES: JSON.stringify({ ...selected, "../escaped": pin }),
    })
  ).toThrow();
});
