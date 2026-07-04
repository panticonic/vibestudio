export const PDF_INGEST_EXTENSION = "@workspace-extensions/pdf-ingest" as const;

export interface PdfIngestionDefaults {
  preserveLayout: true;
  ocrFallback: true;
  pageImages: "on-ocr";
  ocrLanguages: ["eng"];
}

export const POETRY_PDF_DEFAULTS: PdfIngestionDefaults = {
  preserveLayout: true,
  ocrFallback: true,
  pageImages: "on-ocr",
  ocrLanguages: ["eng"],
};
