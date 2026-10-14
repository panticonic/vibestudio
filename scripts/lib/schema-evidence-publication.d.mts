export function schemaProbeComponentPath(root: string): string;
export function schemaProbeStagingPath(root: string): string;
export function assertSchemaProbeStagingPath(staging: string, root: string): string;
export function publishSchemaProbeComponent(staging: string, root: string): Promise<void>;
export function retireSchemaProbeStaging(staging: string, root: string): Promise<void>;
