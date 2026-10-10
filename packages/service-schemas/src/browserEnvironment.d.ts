import { z } from "zod";
import type { CapabilityPresentation } from "@vibestudio/shared/authorityPresentation";
export declare const BROWSER_ENVIRONMENT_BROKER_AUTHORITY_PREFIX = "browserEnvironment.broker";
export declare const BROWSER_ENVIRONMENT_DOWNLOAD_AUTHORITY_PREFIX = "browserEnvironment.download";
export declare const BrowserPublicImportDataTypeSchema: z.ZodEnum<["bookmarks", "history", "searchEngines", "favicons"]>;
export declare const BrowserSensitiveImportDataTypeSchema: z.ZodEnum<["cookies", "passwords", "formFill"]>;
export declare const browserEnvironmentMethods: {
    readonly applyCookies: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            principals: ("code" | "host")[];
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.control";
            readonly rationale: "Applies canonical cookies on the authenticated browser host without returning protected records.";
        };
        readonly access: {
            readonly sensitivity: "write";
        };
        readonly description: "Apply canonical cookies to the authenticated browser environment.";
        readonly website: {
            readonly kind: "closed";
            readonly reason: "Cookie application belongs to the authenticated browser host.";
        };
        readonly args: z.ZodTuple<[], null>;
        readonly returns: z.ZodObject<{
            revision: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            revision: number;
        }, {
            revision: number;
        }>;
    };
    readonly listImportHosts: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            requirement: import("@vibestudio/rpc").AuthorityRequirement;
            resource: {
                kind: "literal";
                key: string;
            };
            prepared: {
                resolver: string;
                leaves: {
                    capability: string;
                    requirement: import("@vibestudio/shared/typedServiceClient").SelectedPreparedAuthorityRequirement;
                    tier: "gated";
                }[];
            };
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.read";
            readonly rationale: "Host/code read of the browser-import host descriptor; per-method authority principals gate callers.";
        };
        readonly description: "List browser-import providers available to the initiating device.";
        readonly args: z.ZodTuple<[], null>;
        readonly returns: z.ZodArray<z.ZodObject<{
            hostId: z.ZodString;
            displayName: z.ZodString;
            platform: z.ZodEnum<["darwin", "linux", "win32", "ios", "android"]>;
            location: z.ZodEnum<["device", "server"]>;
            connected: z.ZodBoolean;
        }, "strict", z.ZodTypeAny, {
            hostId: string;
            displayName: string;
            platform: "android" | "darwin" | "ios" | "linux" | "win32";
            location: "device" | "server";
            connected: boolean;
        }, {
            hostId: string;
            displayName: string;
            platform: "android" | "darwin" | "ios" | "linux" | "win32";
            location: "device" | "server";
            connected: boolean;
        }>, "many">;
        readonly access: {
            readonly sensitivity: "read";
        };
    };
    readonly listImportAcquisitionOptions: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            requirement: import("@vibestudio/rpc").AuthorityRequirement;
            resource: {
                kind: "literal";
                key: string;
            };
            prepared: {
                resolver: string;
                leaves: {
                    capability: string;
                    requirement: import("@vibestudio/shared/typedServiceClient").SelectedPreparedAuthorityRequirement;
                    tier: "gated";
                }[];
            };
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.read";
            readonly rationale: "Lists host-owned ways to enroll a transient browser export without opening platform UI.";
        };
        readonly description: "List ways the selected device can enroll a browser export.";
        readonly args: z.ZodTuple<[z.ZodString], null>;
        readonly returns: z.ZodArray<z.ZodObject<{
            acquisitionId: z.ZodString;
            browser: z.ZodEnum<["firefox", "zen", "chrome", "chrome-beta", "chrome-dev", "chrome-canary", "chromium", "edge", "edge-beta", "edge-dev", "brave", "vivaldi", "opera", "opera-gx", "arc", "safari"]>;
            displayName: z.ZodString;
            description: z.ZodString;
            kind: z.ZodEnum<["system-export", "external-export", "file-picker"]>;
            primary: z.ZodBoolean;
        }, "strict", z.ZodTypeAny, {
            acquisitionId: string;
            browser: "arc" | "brave" | "chrome" | "chrome-beta" | "chrome-canary" | "chrome-dev" | "chromium" | "edge" | "edge-beta" | "edge-dev" | "firefox" | "opera" | "opera-gx" | "safari" | "vivaldi" | "zen";
            displayName: string;
            description: string;
            kind: "external-export" | "file-picker" | "system-export";
            primary: boolean;
        }, {
            acquisitionId: string;
            browser: "arc" | "brave" | "chrome" | "chrome-beta" | "chrome-canary" | "chrome-dev" | "chromium" | "edge" | "edge-beta" | "edge-dev" | "firefox" | "opera" | "opera-gx" | "safari" | "vivaldi" | "zen";
            displayName: string;
            description: string;
            kind: "external-export" | "file-picker" | "system-export";
            primary: boolean;
        }>, "many">;
        readonly access: {
            readonly sensitivity: "read";
        };
    };
    readonly beginImportAcquisition: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            requirement: import("@vibestudio/rpc").AuthorityRequirement;
            resource: {
                kind: "literal";
                key: string;
            };
            prepared: {
                resolver: string;
                leaves: {
                    capability: string;
                    requirement: import("@vibestudio/shared/typedServiceClient").SelectedPreparedAuthorityRequirement;
                    tier: "gated";
                }[];
            };
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.create";
            readonly rationale: "Presents trusted platform UI and stages only the browser export explicitly selected by the user.";
        };
        readonly description: "Run a host-owned browser export or file-selection action.";
        readonly args: z.ZodTuple<[z.ZodString, z.ZodString], null>;
        readonly returns: z.ZodDiscriminatedUnion<"state", [z.ZodObject<{
            state: z.ZodLiteral<"presented">;
            message: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            state: "presented";
            message: string;
        }, {
            state: "presented";
            message: string;
        }>, z.ZodObject<{
            state: z.ZodLiteral<"selected">;
            source: z.ZodLazy<z.ZodObject<{
                sourceId: z.ZodString;
                browser: z.ZodEnum<["firefox", "zen", "chrome", "chrome-beta", "chrome-dev", "chrome-canary", "chromium", "edge", "edge-beta", "edge-dev", "brave", "vivaldi", "opera", "opera-gx", "arc", "safari"]>;
                displayName: z.ZodString;
                status: z.ZodEnum<["readable", "blocked", "unsupported"]>;
                localDataSetCount: z.ZodNumber;
                supportedDataTypes: z.ZodArray<z.ZodEnum<["bookmarks", "history", "cookies", "passwords", "formFill", "searchEngines", "favicons"]>, "many">;
                lastActivityAt: z.ZodOptional<z.ZodNumber>;
                transient: z.ZodOptional<z.ZodBoolean>;
                warnings: z.ZodArray<z.ZodString, "many">;
            }, "strict", z.ZodTypeAny, {
                sourceId: string;
                browser: "arc" | "brave" | "chrome" | "chrome-beta" | "chrome-canary" | "chrome-dev" | "chromium" | "edge" | "edge-beta" | "edge-dev" | "firefox" | "opera" | "opera-gx" | "safari" | "vivaldi" | "zen";
                displayName: string;
                status: "blocked" | "readable" | "unsupported";
                localDataSetCount: number;
                supportedDataTypes: ("bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines")[];
                lastActivityAt?: number | undefined;
                transient?: boolean | undefined;
                warnings: string[];
            }, {
                sourceId: string;
                browser: "arc" | "brave" | "chrome" | "chrome-beta" | "chrome-canary" | "chrome-dev" | "chromium" | "edge" | "edge-beta" | "edge-dev" | "firefox" | "opera" | "opera-gx" | "safari" | "vivaldi" | "zen";
                displayName: string;
                status: "blocked" | "readable" | "unsupported";
                localDataSetCount: number;
                supportedDataTypes: ("bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines")[];
                lastActivityAt?: number | undefined;
                transient?: boolean | undefined;
                warnings: string[];
            }>>;
        }, "strict", z.ZodTypeAny, {
            state: "selected";
            source: {
                sourceId: string;
                browser: "arc" | "brave" | "chrome" | "chrome-beta" | "chrome-canary" | "chrome-dev" | "chromium" | "edge" | "edge-beta" | "edge-dev" | "firefox" | "opera" | "opera-gx" | "safari" | "vivaldi" | "zen";
                displayName: string;
                status: "blocked" | "readable" | "unsupported";
                localDataSetCount: number;
                supportedDataTypes: ("bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines")[];
                lastActivityAt?: number | undefined;
                transient?: boolean | undefined;
                warnings: string[];
            };
        }, {
            state: "selected";
            source: {
                sourceId: string;
                browser: "arc" | "brave" | "chrome" | "chrome-beta" | "chrome-canary" | "chrome-dev" | "chromium" | "edge" | "edge-beta" | "edge-dev" | "firefox" | "opera" | "opera-gx" | "safari" | "vivaldi" | "zen";
                displayName: string;
                status: "blocked" | "readable" | "unsupported";
                localDataSetCount: number;
                supportedDataTypes: ("bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines")[];
                lastActivityAt?: number | undefined;
                transient?: boolean | undefined;
                warnings: string[];
            };
        }>, z.ZodObject<{
            state: z.ZodLiteral<"cancelled">;
        }, "strict", z.ZodTypeAny, {
            state: "cancelled";
        }, {
            state: "cancelled";
        }>]>;
        readonly access: {
            readonly sensitivity: "read";
        };
    };
    readonly releaseImportSource: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            requirement: import("@vibestudio/rpc").AuthorityRequirement;
            resource: {
                kind: "literal";
                key: string;
            };
            prepared: {
                resolver: string;
                leaves: {
                    capability: string;
                    requirement: import("@vibestudio/shared/typedServiceClient").SelectedPreparedAuthorityRequirement;
                    tier: "gated";
                }[];
            };
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.retire";
            readonly rationale: "Deletes transient host-owned staging for a completed or abandoned browser export.";
        };
        readonly description: "Release a transient browser export source and its staging data.";
        readonly args: z.ZodTuple<[z.ZodString, z.ZodString], null>;
        readonly returns: z.ZodVoid;
        readonly access: {
            readonly sensitivity: "write";
        };
    };
    readonly listImportSources: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            requirement: import("@vibestudio/rpc").AuthorityRequirement;
            resource: {
                kind: "literal";
                key: string;
            };
            prepared: {
                resolver: string;
                leaves: {
                    capability: string;
                    requirement: import("@vibestudio/shared/typedServiceClient").SelectedPreparedAuthorityRequirement;
                    tier: "gated";
                }[];
            };
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.read";
            readonly rationale: "Enumerates importable external browser profiles; read-only discovery gated by authority principals.";
        };
        readonly description: "List opaque browser sources discoverable by this trusted host.";
        readonly args: z.ZodTuple<[z.ZodString], null>;
        readonly returns: z.ZodArray<z.ZodObject<{
            sourceId: z.ZodString;
            browser: z.ZodEnum<["firefox", "zen", "chrome", "chrome-beta", "chrome-dev", "chrome-canary", "chromium", "edge", "edge-beta", "edge-dev", "brave", "vivaldi", "opera", "opera-gx", "arc", "safari"]>;
            displayName: z.ZodString;
            status: z.ZodEnum<["readable", "blocked", "unsupported"]>;
            localDataSetCount: z.ZodNumber;
            supportedDataTypes: z.ZodArray<z.ZodEnum<["bookmarks", "history", "cookies", "passwords", "formFill", "searchEngines", "favicons"]>, "many">;
            lastActivityAt: z.ZodOptional<z.ZodNumber>;
            transient: z.ZodOptional<z.ZodBoolean>;
            warnings: z.ZodArray<z.ZodString, "many">;
        }, "strict", z.ZodTypeAny, {
            sourceId: string;
            browser: "arc" | "brave" | "chrome" | "chrome-beta" | "chrome-canary" | "chrome-dev" | "chromium" | "edge" | "edge-beta" | "edge-dev" | "firefox" | "opera" | "opera-gx" | "safari" | "vivaldi" | "zen";
            displayName: string;
            status: "blocked" | "readable" | "unsupported";
            localDataSetCount: number;
            supportedDataTypes: ("bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines")[];
            lastActivityAt?: number | undefined;
            transient?: boolean | undefined;
            warnings: string[];
        }, {
            sourceId: string;
            browser: "arc" | "brave" | "chrome" | "chrome-beta" | "chrome-canary" | "chrome-dev" | "chromium" | "edge" | "edge-beta" | "edge-dev" | "firefox" | "opera" | "opera-gx" | "safari" | "vivaldi" | "zen";
            displayName: string;
            status: "blocked" | "readable" | "unsupported";
            localDataSetCount: number;
            supportedDataTypes: ("bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines")[];
            lastActivityAt?: number | undefined;
            transient?: boolean | undefined;
            warnings: string[];
        }>, "many">;
        readonly access: {
            readonly sensitivity: "read";
        };
    };
    readonly previewImportSource: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            requirement: import("@vibestudio/rpc").AuthorityRequirement;
            resource: {
                kind: "literal";
                key: string;
            };
            prepared: {
                resolver: string;
                leaves: {
                    capability: string;
                    requirement: import("@vibestudio/shared/typedServiceClient").SelectedPreparedAuthorityRequirement;
                    tier: "gated";
                }[];
            };
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.control";
            readonly rationale: "Read-only preview of an external browser profile import; gated by authority principals.";
        };
        readonly description: "Preview normalized import counts without exposing browser secrets.";
        readonly args: z.ZodTuple<[z.ZodString, z.ZodString, z.ZodArray<z.ZodEnum<["bookmarks", "history", "cookies", "passwords", "formFill", "searchEngines", "favicons"]>, "many">], null>;
        readonly returns: z.ZodObject<{
            dataTypes: z.ZodArray<z.ZodObject<{
                dataType: z.ZodEnum<["bookmarks", "history", "cookies", "passwords", "formFill", "searchEngines", "favicons"]>;
                itemsProcessed: z.ZodNumber;
                totalItems: z.ZodOptional<z.ZodNumber>;
                stored: z.ZodNumber;
                skipped: z.ZodNumber;
                errors: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }, {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }>, "many">;
            warnings: z.ZodArray<z.ZodString, "many">;
        } & {
            breakdowns: z.ZodArray<z.ZodObject<{
                dataType: z.ZodEnum<["bookmarks", "history", "cookies", "passwords", "formFill", "searchEngines", "favicons"]>;
                groupedBy: z.ZodEnum<["site", "kind"]>;
                total: z.ZodNumber;
                groups: z.ZodArray<z.ZodObject<{
                    label: z.ZodString;
                    count: z.ZodNumber;
                }, "strip", z.ZodTypeAny, {
                    label: string;
                    count: number;
                }, {
                    label: string;
                    count: number;
                }>, "many">;
                otherGroups: z.ZodNumber;
                otherItems: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                groupedBy: "kind" | "site";
                total: number;
                groups: {
                    label: string;
                    count: number;
                }[];
                otherGroups: number;
                otherItems: number;
            }, {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                groupedBy: "kind" | "site";
                total: number;
                groups: {
                    label: string;
                    count: number;
                }[];
                otherGroups: number;
                otherItems: number;
            }>, "many">;
            openTabCount: z.ZodNumber;
            localDataSetCount: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            dataTypes: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            warnings: string[];
            breakdowns: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                groupedBy: "kind" | "site";
                total: number;
                groups: {
                    label: string;
                    count: number;
                }[];
                otherGroups: number;
                otherItems: number;
            }[];
            openTabCount: number;
            localDataSetCount: number;
        }, {
            dataTypes: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            warnings: string[];
            breakdowns: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                groupedBy: "kind" | "site";
                total: number;
                groups: {
                    label: string;
                    count: number;
                }[];
                otherGroups: number;
                otherItems: number;
            }[];
            openTabCount: number;
            localDataSetCount: number;
        }>;
        readonly access: {
            readonly sensitivity: "read";
        };
    };
    readonly previewSensitiveImport: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            principals: ("code" | "host")[];
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.control";
            readonly rationale: "Returns aggregate review counts for protected browser categories without returning records or values.";
        };
        readonly description: "Preview selected sensitive browser categories using aggregate counts only.";
        readonly args: z.ZodTuple<[z.ZodString, z.ZodString, z.ZodEffects<z.ZodArray<z.ZodEnum<["cookies", "passwords", "formFill"]>, "many">, ("cookies" | "formFill" | "passwords")[], ("cookies" | "formFill" | "passwords")[]>], null>;
        readonly returns: z.ZodObject<{
            dataTypes: z.ZodArray<z.ZodObject<{
                dataType: z.ZodEnum<["bookmarks", "history", "cookies", "passwords", "formFill", "searchEngines", "favicons"]>;
                itemsProcessed: z.ZodNumber;
                totalItems: z.ZodOptional<z.ZodNumber>;
                stored: z.ZodNumber;
                skipped: z.ZodNumber;
                errors: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }, {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }>, "many">;
            warnings: z.ZodArray<z.ZodString, "many">;
        } & {
            breakdowns: z.ZodArray<z.ZodObject<{
                dataType: z.ZodEnum<["bookmarks", "history", "cookies", "passwords", "formFill", "searchEngines", "favicons"]>;
                groupedBy: z.ZodEnum<["site", "kind"]>;
                total: z.ZodNumber;
                groups: z.ZodArray<z.ZodObject<{
                    label: z.ZodString;
                    count: z.ZodNumber;
                }, "strip", z.ZodTypeAny, {
                    label: string;
                    count: number;
                }, {
                    label: string;
                    count: number;
                }>, "many">;
                otherGroups: z.ZodNumber;
                otherItems: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                groupedBy: "kind" | "site";
                total: number;
                groups: {
                    label: string;
                    count: number;
                }[];
                otherGroups: number;
                otherItems: number;
            }, {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                groupedBy: "kind" | "site";
                total: number;
                groups: {
                    label: string;
                    count: number;
                }[];
                otherGroups: number;
                otherItems: number;
            }>, "many">;
            openTabCount: z.ZodNumber;
            localDataSetCount: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            dataTypes: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            warnings: string[];
            breakdowns: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                groupedBy: "kind" | "site";
                total: number;
                groups: {
                    label: string;
                    count: number;
                }[];
                otherGroups: number;
                otherItems: number;
            }[];
            openTabCount: number;
            localDataSetCount: number;
        }, {
            dataTypes: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            warnings: string[];
            breakdowns: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                groupedBy: "kind" | "site";
                total: number;
                groups: {
                    label: string;
                    count: number;
                }[];
                otherGroups: number;
                otherItems: number;
            }[];
            openTabCount: number;
            localDataSetCount: number;
        }>;
        readonly access: {
            readonly sensitivity: "read";
        };
    };
    readonly startImportRead: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            requirement: import("@vibestudio/rpc").AuthorityRequirement;
            resource: {
                kind: "literal";
                key: string;
            };
            prepared: {
                resolver: string;
                leaves: {
                    capability: string;
                    requirement: import("@vibestudio/shared/typedServiceClient").SelectedPreparedAuthorityRequirement;
                    tier: "gated";
                }[];
            };
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.create";
            readonly rationale: "Starts a streamed read of an external browser profile for import; gated by authority principals.";
        };
        readonly description: "Start a bounded, cancellable read of non-sensitive browser data.";
        readonly args: z.ZodTuple<[z.ZodString, z.ZodString, z.ZodArray<z.ZodEnum<["bookmarks", "history", "searchEngines", "favicons"]>, "many">], null>;
        readonly returns: z.ZodString;
        readonly access: {
            readonly sensitivity: "read";
        };
    };
    readonly startSensitiveImport: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            principals: ("code" | "host")[];
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.create";
            readonly rationale: "Runs credential-bearing browser import entirely in the trusted host and returns aggregate counts only; gated by authority principals.";
        };
        readonly description: "Import selected sensitive browser data directly into the host vault without exposing plaintext frames.";
        readonly args: z.ZodTuple<[z.ZodString, z.ZodString, z.ZodEffects<z.ZodArray<z.ZodEnum<["cookies", "passwords", "formFill"]>, "many">, ("cookies" | "formFill" | "passwords")[], ("cookies" | "formFill" | "passwords")[]>, z.ZodString], null>;
        readonly returns: z.ZodObject<{
            operationId: z.ZodString;
            state: z.ZodEnum<["running", "applying", "application_failed", "complete", "cancelled", "failed"]>;
            counts: z.ZodArray<z.ZodObject<{
                dataType: z.ZodEnum<["cookies", "passwords", "formFill"]>;
                read: z.ZodNumber;
                stored: z.ZodNumber;
                skipped: z.ZodNumber;
                errors: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                dataType: "cookies" | "formFill" | "passwords";
                read: number;
                stored: number;
                skipped: number;
                errors: number;
            }, {
                dataType: "cookies" | "formFill" | "passwords";
                read: number;
                stored: number;
                skipped: number;
                errors: number;
            }>, "many">;
            error: z.ZodOptional<z.ZodString>;
            /** Opaque status version; pass it back as `afterVersion` to await the next change. */
            version: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            operationId: string;
            state: "application_failed" | "applying" | "cancelled" | "complete" | "failed" | "running";
            counts: {
                dataType: "cookies" | "formFill" | "passwords";
                read: number;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            error?: string | undefined;
            version: string;
        }, {
            operationId: string;
            state: "application_failed" | "applying" | "cancelled" | "complete" | "failed" | "running";
            counts: {
                dataType: "cookies" | "formFill" | "passwords";
                read: number;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            error?: string | undefined;
            version: string;
        }>;
        readonly access: {
            readonly sensitivity: "write";
        };
    };
    readonly observeSensitiveImport: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            principals: ("code" | "host")[];
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.read";
            readonly rationale: "Reads aggregate progress from the durable host import ledger.";
        };
        readonly description: "Observe aggregate progress or the terminal receipt for a sensitive import. With `afterVersion`, a running or applying import resolves on its next status change; any other state, or a different version, returns immediately.";
        readonly args: z.ZodTuple<[z.ZodString, z.ZodOptional<z.ZodObject<{
            afterVersion: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            afterVersion: string;
        }, {
            afterVersion: string;
        }>>], null>;
        readonly returns: z.ZodObject<{
            operationId: z.ZodString;
            state: z.ZodEnum<["running", "applying", "application_failed", "complete", "cancelled", "failed"]>;
            counts: z.ZodArray<z.ZodObject<{
                dataType: z.ZodEnum<["cookies", "passwords", "formFill"]>;
                read: z.ZodNumber;
                stored: z.ZodNumber;
                skipped: z.ZodNumber;
                errors: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                dataType: "cookies" | "formFill" | "passwords";
                read: number;
                stored: number;
                skipped: number;
                errors: number;
            }, {
                dataType: "cookies" | "formFill" | "passwords";
                read: number;
                stored: number;
                skipped: number;
                errors: number;
            }>, "many">;
            error: z.ZodOptional<z.ZodString>;
            /** Opaque status version; pass it back as `afterVersion` to await the next change. */
            version: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            operationId: string;
            state: "application_failed" | "applying" | "cancelled" | "complete" | "failed" | "running";
            counts: {
                dataType: "cookies" | "formFill" | "passwords";
                read: number;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            error?: string | undefined;
            version: string;
        }, {
            operationId: string;
            state: "application_failed" | "applying" | "cancelled" | "complete" | "failed" | "running";
            counts: {
                dataType: "cookies" | "formFill" | "passwords";
                read: number;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            error?: string | undefined;
            version: string;
        }>;
        readonly access: {
            readonly sensitivity: "read";
        };
    };
    readonly cancelSensitiveImport: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            principals: ("code" | "host")[];
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.retire";
            readonly rationale: "Records durable cancellation and stops the active host import reader.";
        };
        readonly description: "Cancel a sensitive import and return its durable terminal status.";
        readonly args: z.ZodTuple<[z.ZodString], null>;
        readonly returns: z.ZodObject<{
            operationId: z.ZodString;
            state: z.ZodEnum<["running", "applying", "application_failed", "complete", "cancelled", "failed"]>;
            counts: z.ZodArray<z.ZodObject<{
                dataType: z.ZodEnum<["cookies", "passwords", "formFill"]>;
                read: z.ZodNumber;
                stored: z.ZodNumber;
                skipped: z.ZodNumber;
                errors: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                dataType: "cookies" | "formFill" | "passwords";
                read: number;
                stored: number;
                skipped: number;
                errors: number;
            }, {
                dataType: "cookies" | "formFill" | "passwords";
                read: number;
                stored: number;
                skipped: number;
                errors: number;
            }>, "many">;
            error: z.ZodOptional<z.ZodString>;
            /** Opaque status version; pass it back as `afterVersion` to await the next change. */
            version: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            operationId: string;
            state: "application_failed" | "applying" | "cancelled" | "complete" | "failed" | "running";
            counts: {
                dataType: "cookies" | "formFill" | "passwords";
                read: number;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            error?: string | undefined;
            version: string;
        }, {
            operationId: string;
            state: "application_failed" | "applying" | "cancelled" | "complete" | "failed" | "running";
            counts: {
                dataType: "cookies" | "formFill" | "passwords";
                read: number;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            error?: string | undefined;
            version: string;
        }>;
        readonly access: {
            readonly sensitivity: "write";
        };
    };
    readonly nextImportFrame: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            requirement: import("@vibestudio/rpc").AuthorityRequirement;
            resource: {
                kind: "literal";
                key: string;
            };
            prepared: {
                resolver: string;
                leaves: {
                    capability: string;
                    requirement: import("@vibestudio/shared/typedServiceClient").SelectedPreparedAuthorityRequirement;
                    tier: "gated";
                }[];
            };
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.control";
            readonly rationale: "Continues a streamed browser-profile import read; gated by authority principals.";
        };
        readonly description: "Read the next bounded progress or data frame from an import operation.";
        readonly args: z.ZodTuple<[z.ZodString], null>;
        readonly returns: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
            type: z.ZodLiteral<"heartbeat">;
        }, "strip", z.ZodTypeAny, {
            type: "heartbeat";
        }, {
            type: "heartbeat";
        }>, z.ZodObject<{
            type: z.ZodLiteral<"batch">;
            dataType: z.ZodEnum<["bookmarks", "history", "searchEngines", "favicons"]>;
            batchIndex: z.ZodNumber;
            items: z.ZodArray<z.ZodUnknown, "many">;
        }, "strip", z.ZodTypeAny, {
            type: "batch";
            dataType: "bookmarks" | "favicons" | "history" | "searchEngines";
            batchIndex: number;
            items: unknown[];
        }, {
            type: "batch";
            dataType: "bookmarks" | "favicons" | "history" | "searchEngines";
            batchIndex: number;
            items: unknown[];
        }>, z.ZodObject<{
            type: z.ZodLiteral<"progress">;
            progress: z.ZodObject<{
                itemsProcessed: z.ZodNumber;
                totalItems: z.ZodOptional<z.ZodNumber>;
                stored: z.ZodNumber;
                skipped: z.ZodNumber;
                errors: z.ZodNumber;
            } & {
                dataType: z.ZodEnum<["bookmarks", "history", "searchEngines", "favicons"]>;
            }, "strict", z.ZodTypeAny, {
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
                dataType: "bookmarks" | "favicons" | "history" | "searchEngines";
            }, {
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
                dataType: "bookmarks" | "favicons" | "history" | "searchEngines";
            }>;
        }, "strip", z.ZodTypeAny, {
            type: "progress";
            progress: {
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
                dataType: "bookmarks" | "favicons" | "history" | "searchEngines";
            };
        }, {
            type: "progress";
            progress: {
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
                dataType: "bookmarks" | "favicons" | "history" | "searchEngines";
            };
        }>, z.ZodObject<{
            type: z.ZodLiteral<"complete">;
            summary: z.ZodObject<{
                dataTypes: z.ZodArray<z.ZodObject<{
                    itemsProcessed: z.ZodNumber;
                    totalItems: z.ZodOptional<z.ZodNumber>;
                    stored: z.ZodNumber;
                    skipped: z.ZodNumber;
                    errors: z.ZodNumber;
                } & {
                    dataType: z.ZodEnum<["bookmarks", "history", "searchEngines", "favicons"]>;
                }, "strict", z.ZodTypeAny, {
                    itemsProcessed: number;
                    totalItems?: number | undefined;
                    stored: number;
                    skipped: number;
                    errors: number;
                    dataType: "bookmarks" | "favicons" | "history" | "searchEngines";
                }, {
                    itemsProcessed: number;
                    totalItems?: number | undefined;
                    stored: number;
                    skipped: number;
                    errors: number;
                    dataType: "bookmarks" | "favicons" | "history" | "searchEngines";
                }>, "many">;
                warnings: z.ZodArray<z.ZodString, "many">;
            }, "strict", z.ZodTypeAny, {
                dataTypes: {
                    itemsProcessed: number;
                    totalItems?: number | undefined;
                    stored: number;
                    skipped: number;
                    errors: number;
                    dataType: "bookmarks" | "favicons" | "history" | "searchEngines";
                }[];
                warnings: string[];
            }, {
                dataTypes: {
                    itemsProcessed: number;
                    totalItems?: number | undefined;
                    stored: number;
                    skipped: number;
                    errors: number;
                    dataType: "bookmarks" | "favicons" | "history" | "searchEngines";
                }[];
                warnings: string[];
            }>;
        }, "strip", z.ZodTypeAny, {
            type: "complete";
            summary: {
                dataTypes: {
                    itemsProcessed: number;
                    totalItems?: number | undefined;
                    stored: number;
                    skipped: number;
                    errors: number;
                    dataType: "bookmarks" | "favicons" | "history" | "searchEngines";
                }[];
                warnings: string[];
            };
        }, {
            type: "complete";
            summary: {
                dataTypes: {
                    itemsProcessed: number;
                    totalItems?: number | undefined;
                    stored: number;
                    skipped: number;
                    errors: number;
                    dataType: "bookmarks" | "favicons" | "history" | "searchEngines";
                }[];
                warnings: string[];
            };
        }>, z.ZodObject<{
            type: z.ZodLiteral<"error">;
            message: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "error";
            message: string;
        }, {
            type: "error";
            message: string;
        }>]>;
        readonly access: {
            readonly sensitivity: "read";
        };
    };
    readonly cancelImportRead: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            requirement: import("@vibestudio/rpc").AuthorityRequirement;
            resource: {
                kind: "literal";
                key: string;
            };
            prepared: {
                resolver: string;
                leaves: {
                    capability: string;
                    requirement: import("@vibestudio/shared/typedServiceClient").SelectedPreparedAuthorityRequirement;
                    tier: "gated";
                }[];
            };
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.retire";
            readonly rationale: "Cancels a streamed browser-profile import read; gated by authority principals.";
        };
        readonly description: "Cancel an active trusted-host browser import read.";
        readonly args: z.ZodTuple<[z.ZodString], null>;
        readonly returns: z.ZodVoid;
        readonly access: {
            readonly sensitivity: "write";
        };
    };
    readonly listImportOpenTabs: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            requirement: import("@vibestudio/rpc").AuthorityRequirement;
            resource: {
                kind: "literal";
                key: string;
            };
            prepared: {
                resolver: string;
                leaves: {
                    capability: string;
                    requirement: import("@vibestudio/shared/typedServiceClient").SelectedPreparedAuthorityRequirement;
                    tier: "gated";
                }[];
            };
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.read";
            readonly rationale: "Reads open tabs from an external browser profile for import; gated by authority principals.";
        };
        readonly description: "List importable HTTP(S) tabs without exposing source filesystem paths.";
        readonly args: z.ZodTuple<[z.ZodString, z.ZodString], null>;
        readonly returns: z.ZodArray<z.ZodObject<{
            tabId: z.ZodString;
            url: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
            active: z.ZodBoolean;
            pinned: z.ZodOptional<z.ZodBoolean>;
            lastAccessed: z.ZodOptional<z.ZodNumber>;
            windowId: z.ZodString;
            windowOrdinal: z.ZodNumber;
            sessionState: z.ZodEnum<["open", "restores", "saved"]>;
        }, "strip", z.ZodTypeAny, {
            tabId: string;
            url: string;
            title?: string | undefined;
            active: boolean;
            pinned?: boolean | undefined;
            lastAccessed?: number | undefined;
            windowId: string;
            windowOrdinal: number;
            sessionState: "open" | "restores" | "saved";
        }, {
            tabId: string;
            url: string;
            title?: string | undefined;
            active: boolean;
            pinned?: boolean | undefined;
            lastAccessed?: number | undefined;
            windowId: string;
            windowOrdinal: number;
            sessionState: "open" | "restores" | "saved";
        }>, "many">;
        readonly access: {
            readonly sensitivity: "read";
        };
    };
    readonly listDownloads: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            requirement: import("@vibestudio/rpc").AuthorityRequirement;
            resource: {
                kind: "literal";
                key: string;
            };
            prepared: {
                resolver: string;
                leaves: {
                    capability: string;
                    requirement: import("@vibestudio/shared/typedServiceClient").SelectedPreparedAuthorityRequirement;
                    tier: "gated";
                }[];
            };
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.read";
            readonly rationale: "Host reads proceed directly; installed code requires the method's gated browser-environment capability.";
        };
        readonly description: "List current and recent downloads for this browser host.";
        readonly args: z.ZodTuple<[], null>;
        readonly returns: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            environmentKey: z.ZodString;
            hostId: z.ZodString;
            panelId: z.ZodOptional<z.ZodString>;
            origin: z.ZodOptional<z.ZodString>;
            url: z.ZodString;
            filename: z.ZodString;
            savePath: z.ZodString;
            receivedBytes: z.ZodNumber;
            totalBytes: z.ZodNumber;
            state: z.ZodEnum<["progressing", "paused", "completed", "cancelled", "interrupted"]>;
            startedAt: z.ZodNumber;
            updatedAt: z.ZodNumber;
            canResume: z.ZodOptional<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            id: string;
            environmentKey: string;
            hostId: string;
            panelId?: string | undefined;
            origin?: string | undefined;
            url: string;
            filename: string;
            savePath: string;
            receivedBytes: number;
            totalBytes: number;
            state: "cancelled" | "completed" | "interrupted" | "paused" | "progressing";
            startedAt: number;
            updatedAt: number;
            canResume?: boolean | undefined;
        }, {
            id: string;
            environmentKey: string;
            hostId: string;
            panelId?: string | undefined;
            origin?: string | undefined;
            url: string;
            filename: string;
            savePath: string;
            receivedBytes: number;
            totalBytes: number;
            state: "cancelled" | "completed" | "interrupted" | "paused" | "progressing";
            startedAt: number;
            updatedAt: number;
            canResume?: boolean | undefined;
        }>, "many">;
        readonly access: {
            readonly sensitivity: "read";
        };
    };
    readonly pauseDownload: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            requirement: import("@vibestudio/rpc").AuthorityRequirement;
            resource: {
                kind: "literal";
                key: string;
            };
            prepared: {
                resolver: string;
                leaves: {
                    capability: string;
                    requirement: import("@vibestudio/shared/typedServiceClient").SelectedPreparedAuthorityRequirement;
                    tier: "gated";
                }[];
            };
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.control";
            readonly rationale: "Host control proceeds directly; installed code requires the method's gated browser-environment capability.";
        };
        readonly description: "Pause an active browser download.";
        readonly args: z.ZodTuple<[z.ZodString], null>;
        readonly returns: z.ZodVoid;
        readonly access: {
            readonly sensitivity: "write";
        };
    };
    readonly resumeDownload: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            requirement: import("@vibestudio/rpc").AuthorityRequirement;
            resource: {
                kind: "literal";
                key: string;
            };
            prepared: {
                resolver: string;
                leaves: {
                    capability: string;
                    requirement: import("@vibestudio/shared/typedServiceClient").SelectedPreparedAuthorityRequirement;
                    tier: "gated";
                }[];
            };
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.control";
            readonly rationale: "Host control proceeds directly; installed code requires the method's gated browser-environment capability.";
        };
        readonly description: "Resume a paused or resumable interrupted browser download.";
        readonly args: z.ZodTuple<[z.ZodString], null>;
        readonly returns: z.ZodVoid;
        readonly access: {
            readonly sensitivity: "write";
        };
    };
    readonly cancelDownload: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            requirement: import("@vibestudio/rpc").AuthorityRequirement;
            resource: {
                kind: "literal";
                key: string;
            };
            prepared: {
                resolver: string;
                leaves: {
                    capability: string;
                    requirement: import("@vibestudio/shared/typedServiceClient").SelectedPreparedAuthorityRequirement;
                    tier: "gated";
                }[];
            };
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.retire";
            readonly rationale: "Host control proceeds directly; installed code requires the method's gated browser-environment capability.";
        };
        readonly description: "Cancel an active browser download.";
        readonly args: z.ZodTuple<[z.ZodString], null>;
        readonly returns: z.ZodVoid;
        readonly access: {
            readonly sensitivity: "destructive";
        };
    };
    readonly openDownload: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            requirement: import("@vibestudio/rpc").AuthorityRequirement;
            resource: {
                kind: "literal";
                key: string;
            };
            prepared: {
                resolver: string;
                leaves: {
                    capability: string;
                    requirement: import("@vibestudio/shared/typedServiceClient").SelectedPreparedAuthorityRequirement;
                    tier: "gated";
                }[];
            };
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.create";
            readonly rationale: "Host open proceeds directly; installed code requires the method's gated browser-environment capability.";
        };
        readonly description: "Open a completed browser download with the operating system.";
        readonly args: z.ZodTuple<[z.ZodString], null>;
        readonly returns: z.ZodVoid;
        readonly access: {
            readonly sensitivity: "write";
        };
    };
    readonly revealDownload: {
        readonly capability: string;
        readonly presentation: CapabilityPresentation;
        readonly authority: {
            requirement: import("@vibestudio/rpc").AuthorityRequirement;
            resource: {
                kind: "literal";
                key: string;
            };
            prepared: {
                resolver: string;
                leaves: {
                    capability: string;
                    requirement: import("@vibestudio/shared/typedServiceClient").SelectedPreparedAuthorityRequirement;
                    tier: "gated";
                }[];
            };
        };
        readonly website: {
            readonly kind: "closed";
            readonly reason: "The browserEnvironment receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.";
        };
        readonly tier: {
            readonly tier: "open";
            readonly session: "family";
            readonly residency: "native-effect";
            readonly family: "browserEnvironment.control";
            readonly rationale: "Host reveal proceeds directly; installed code requires the method's gated browser-environment capability.";
        };
        readonly description: "Reveal a browser download in the operating system file manager.";
        readonly args: z.ZodTuple<[z.ZodString], null>;
        readonly returns: z.ZodVoid;
        readonly access: {
            readonly sensitivity: "write";
        };
    };
};
