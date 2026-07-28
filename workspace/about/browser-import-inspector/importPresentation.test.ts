import { describe, expect, it } from "vitest";
import type { ImportJobSnapshot } from "@vibestudio/browser-data/client";
import {
  categoryProgressPresentation,
  importStatusPresentation,
  isMigrationStepComplete,
  isSuccessfulImportPhase,
  isTerminalImportPhase,
  shouldShowImportOptions,
} from "./importPresentation";

type CategoryProgress = ImportJobSnapshot["progress"][number];

const progress = (overrides: Partial<CategoryProgress> = {}): CategoryProgress => ({
  dataType: "formFill",
  itemsProcessed: 0,
  totalItems: 0,
  stored: 0,
  skipped: 0,
  errors: 0,
  ...overrides,
});

describe("categoryProgressPresentation", () => {
  it("treats skipped records as processed outcomes for a completed import", () => {
    expect(
      categoryProgressPresentation(
        progress({
          itemsProcessed: 29,
          totalItems: 29,
          stored: 29,
          skipped: 1_057,
        }),
        "complete"
      )
    ).toEqual({
      value: 100,
      processed: 1_086,
      total: 1_086,
      label: "1086 records considered",
    });
  });

  it("shows work processed rather than records stored while running", () => {
    expect(
      categoryProgressPresentation(
        progress({
          itemsProcessed: 543,
          totalItems: 1_086,
          stored: 29,
          skipped: 514,
        }),
        "storing"
      )
    ).toEqual({
      value: 50,
      processed: 543,
      total: 1_086,
      label: "543 of 1086 processed",
    });
  });

  it("leaves progress indeterminate when a running job has no total", () => {
    expect(
      categoryProgressPresentation(
        progress({
          itemsProcessed: 7,
          totalItems: undefined,
          stored: 4,
          skipped: 3,
        }),
        "reading"
      )
    ).toEqual({
      value: undefined,
      processed: 7,
      label: "7 processed",
    });
  });
});

describe("import state presentation", () => {
  it("makes a completed import explicit", () => {
    expect(importStatusPresentation("complete")).toMatchObject({
      heading: "Import complete",
      badge: "complete",
      color: "green",
    });
    expect(importStatusPresentation("complete").note).toContain("not work left to finish");
  });

  it("distinguishes terminal and successful phases", () => {
    expect(isTerminalImportPhase("complete")).toBe(true);
    expect(isTerminalImportPhase("failed")).toBe(true);
    expect(isTerminalImportPhase("storing")).toBe(false);
    expect(isSuccessfulImportPhase("partial")).toBe(true);
    expect(isSuccessfulImportPhase("cancelled")).toBe(false);
  });

  it("replaces the chooser with the result until the user asks to import again", () => {
    expect(shouldShowImportOptions(null, false)).toBe(true);
    expect(shouldShowImportOptions("storing", false)).toBe(false);
    expect(shouldShowImportOptions("complete", false)).toBe(false);
    expect(shouldShowImportOptions("complete", true)).toBe(true);
    expect(shouldShowImportOptions("failed", false)).toBe(true);
  });

  it("keeps the data step checked even while it remains selected", () => {
    expect(isMigrationStepComplete("data", true)).toBe(true);
    expect(isMigrationStepComplete("tabs", true)).toBe(false);
  });
});
