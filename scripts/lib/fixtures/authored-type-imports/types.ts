// Declaration generation must parse this file without evaluating any body.
throw new Error("Authored type source must never execute during declaration generation");
export type OwnedValue = {id:string; actual:string};
