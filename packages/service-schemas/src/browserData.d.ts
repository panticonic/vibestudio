import { z } from "zod";
/**
 * Canonical wire table for the product-owned browser data store. Native import,
 * download-control, cookie-projection, and export orchestration deliberately do
 * not appear here; those remain native brokerage concerns.
 */
export declare const browserDataMethods: {
    readonly upsertDownloadRecord: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
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
        }, "strict", z.ZodTypeAny, {
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
        }>], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listDownloadRecords: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodArray<z.ZodObject<{
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
        }, "strict", z.ZodTypeAny, {
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
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getSitePreferences: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodObject<{
            origin: z.ZodString;
            zoomFactor: z.ZodNumber;
            updatedAt: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            origin: string;
            zoomFactor: number;
            updatedAt?: number | undefined;
        }, {
            origin: string;
            zoomFactor: number;
            updatedAt?: number | undefined;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly setSiteZoom: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString, z.ZodNumber], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getBookmarks: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodOptional<z.ZodString>], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            title: z.ZodString;
            url: z.ZodNullable<z.ZodString>;
            folder_path: z.ZodString;
            date_added: z.ZodNumber;
            date_modified: z.ZodNullable<z.ZodNumber>;
            position: z.ZodNumber;
            source_id: z.ZodNullable<z.ZodString>;
            import_key: z.ZodNullable<z.ZodString>;
            tags: z.ZodNullable<z.ZodString>;
            keyword: z.ZodNullable<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            id: number;
            title: string;
            url: string | null;
            folder_path: string;
            date_added: number;
            date_modified: number | null;
            position: number;
            source_id: string | null;
            import_key: string | null;
            tags: string | null;
            keyword: string | null;
        }, {
            id: number;
            title: string;
            url: string | null;
            folder_path: string;
            date_added: number;
            date_modified: number | null;
            position: number;
            source_id: string | null;
            import_key: string | null;
            tags: string | null;
            keyword: string | null;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getAllBookmarks: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            title: z.ZodString;
            url: z.ZodNullable<z.ZodString>;
            folder_path: z.ZodString;
            date_added: z.ZodNumber;
            date_modified: z.ZodNullable<z.ZodNumber>;
            position: z.ZodNumber;
            source_id: z.ZodNullable<z.ZodString>;
            import_key: z.ZodNullable<z.ZodString>;
            tags: z.ZodNullable<z.ZodString>;
            keyword: z.ZodNullable<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            id: number;
            title: string;
            url: string | null;
            folder_path: string;
            date_added: number;
            date_modified: number | null;
            position: number;
            source_id: string | null;
            import_key: string | null;
            tags: string | null;
            keyword: string | null;
        }, {
            id: number;
            title: string;
            url: string | null;
            folder_path: string;
            date_added: number;
            date_modified: number | null;
            position: number;
            source_id: string | null;
            import_key: string | null;
            tags: string | null;
            keyword: string | null;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addBookmark: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            title: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
            folderPath: z.ZodOptional<z.ZodString>;
            dateAdded: z.ZodOptional<z.ZodNumber>;
            tags: z.ZodOptional<z.ZodString>;
            keyword: z.ZodOptional<z.ZodString>;
            position: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            title: string;
            url?: string | undefined;
            folderPath?: string | undefined;
            dateAdded?: number | undefined;
            tags?: string | undefined;
            keyword?: string | undefined;
            position?: number | undefined;
        }, {
            title: string;
            url?: string | undefined;
            folderPath?: string | undefined;
            dateAdded?: number | undefined;
            tags?: string | undefined;
            keyword?: string | undefined;
            position?: number | undefined;
        }>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly updateBookmark: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodObject<{
            title: z.ZodOptional<z.ZodString>;
            url: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            folderPath: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            dateAdded: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
            tags: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            keyword: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            position: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        }, "strict", z.ZodTypeAny, {
            title?: string | undefined;
            url?: string | undefined;
            folderPath?: string | undefined;
            dateAdded?: number | undefined;
            tags?: string | undefined;
            keyword?: string | undefined;
            position?: number | undefined;
        }, {
            title?: string | undefined;
            url?: string | undefined;
            folderPath?: string | undefined;
            dateAdded?: number | undefined;
            tags?: string | undefined;
            keyword?: string | undefined;
            position?: number | undefined;
        }>], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly deleteBookmark: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly moveBookmark: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodString, z.ZodNumber], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly searchBookmarks: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            title: z.ZodString;
            url: z.ZodNullable<z.ZodString>;
            folder_path: z.ZodString;
            date_added: z.ZodNumber;
            date_modified: z.ZodNullable<z.ZodNumber>;
            position: z.ZodNumber;
            source_id: z.ZodNullable<z.ZodString>;
            import_key: z.ZodNullable<z.ZodString>;
            tags: z.ZodNullable<z.ZodString>;
            keyword: z.ZodNullable<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            id: number;
            title: string;
            url: string | null;
            folder_path: string;
            date_added: number;
            date_modified: number | null;
            position: number;
            source_id: string | null;
            import_key: string | null;
            tags: string | null;
            keyword: string | null;
        }, {
            id: number;
            title: string;
            url: string | null;
            folder_path: string;
            date_added: number;
            date_modified: number | null;
            position: number;
            source_id: string | null;
            import_key: string | null;
            tags: string | null;
            keyword: string | null;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getHistory: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            search: z.ZodOptional<z.ZodString>;
            startTime: z.ZodOptional<z.ZodNumber>;
            endTime: z.ZodOptional<z.ZodNumber>;
            limit: z.ZodOptional<z.ZodNumber>;
            offset: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            search?: string | undefined;
            startTime?: number | undefined;
            endTime?: number | undefined;
            limit?: number | undefined;
            offset?: number | undefined;
        }, {
            search?: string | undefined;
            startTime?: number | undefined;
            endTime?: number | undefined;
            limit?: number | undefined;
            offset?: number | undefined;
        }>], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            url: z.ZodString;
            title: z.ZodNullable<z.ZodString>;
            visit_count: z.ZodNumber;
            typed_count: z.ZodNumber;
            first_visit: z.ZodNullable<z.ZodNumber>;
            last_visit: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            id: number;
            url: string;
            title: string | null;
            visit_count: number;
            typed_count: number;
            first_visit: number | null;
            last_visit: number;
        }, {
            id: number;
            url: string;
            title: string | null;
            visit_count: number;
            typed_count: number;
            first_visit: number | null;
            last_visit: number;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly searchHistory: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString, z.ZodOptional<z.ZodNumber>], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            url: z.ZodString;
            title: z.ZodNullable<z.ZodString>;
            visit_count: z.ZodNumber;
            typed_count: z.ZodNumber;
            first_visit: z.ZodNullable<z.ZodNumber>;
            last_visit: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            id: number;
            url: string;
            title: string | null;
            visit_count: number;
            typed_count: number;
            first_visit: number | null;
            last_visit: number;
        }, {
            id: number;
            url: string;
            title: string | null;
            visit_count: number;
            typed_count: number;
            first_visit: number | null;
            last_visit: number;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly searchHistoryForAutocomplete: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            query: z.ZodString;
            limit: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            query: string;
            limit?: number | undefined;
        }, {
            query: string;
            limit?: number | undefined;
        }>], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            url: z.ZodString;
            title: z.ZodNullable<z.ZodString>;
            visit_count: z.ZodNumber;
            typed_count: z.ZodNumber;
            first_visit: z.ZodNullable<z.ZodNumber>;
            last_visit: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            id: number;
            url: string;
            title: string | null;
            visit_count: number;
            typed_count: number;
            first_visit: number | null;
            last_visit: number;
        }, {
            id: number;
            url: string;
            title: string | null;
            visit_count: number;
            typed_count: number;
            first_visit: number | null;
            last_visit: number;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly recordHistoryVisit: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            url: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
            transition: z.ZodOptional<z.ZodString>;
            visitTime: z.ZodOptional<z.ZodNumber>;
            typed: z.ZodOptional<z.ZodBoolean>;
            source: z.ZodOptional<z.ZodEnum<["vibestudio", "import"]>>;
            panelId: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            url: string;
            title?: string | undefined;
            transition?: string | undefined;
            visitTime?: number | undefined;
            typed?: boolean | undefined;
            source?: "import" | "vibestudio" | undefined;
            panelId?: string | undefined;
        }, {
            url: string;
            title?: string | undefined;
            transition?: string | undefined;
            visitTime?: number | undefined;
            typed?: boolean | undefined;
            source?: "import" | "vibestudio" | undefined;
            panelId?: string | undefined;
        }>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly updateHistoryTitle: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            url: z.ZodString;
            title: z.ZodString;
            observedAt: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            url: string;
            title: string;
            observedAt?: number | undefined;
        }, {
            url: string;
            title: string;
            observedAt?: number | undefined;
        }>], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly deleteHistoryEntry: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly deleteHistoryRange: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly clearAllHistory: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listPasswordSummaries: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodArray<z.ZodObject<Omit<{
            id: z.ZodNumber;
            origin_url: z.ZodString;
            username: z.ZodString;
            password: z.ZodString;
            action_url: z.ZodString;
            realm: z.ZodString;
            date_created: z.ZodNullable<z.ZodNumber>;
            date_last_used: z.ZodNullable<z.ZodNumber>;
            date_password_changed: z.ZodNullable<z.ZodNumber>;
            times_used: z.ZodNumber;
        }, "password">, "strict", z.ZodTypeAny, {
            id: number;
            origin_url: string;
            username: string;
            action_url: string;
            realm: string;
            date_created: number | null;
            date_last_used: number | null;
            date_password_changed: number | null;
            times_used: number;
        }, {
            id: number;
            origin_url: string;
            username: string;
            action_url: string;
            realm: string;
            date_created: number | null;
            date_last_used: number | null;
            date_password_changed: number | null;
            times_used: number;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listPasswordSummariesPage: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
        returns: z.ZodObject<{
            items: z.ZodArray<z.ZodObject<Omit<{
                id: z.ZodNumber;
                origin_url: z.ZodString;
                username: z.ZodString;
                password: z.ZodString;
                action_url: z.ZodString;
                realm: z.ZodString;
                date_created: z.ZodNullable<z.ZodNumber>;
                date_last_used: z.ZodNullable<z.ZodNumber>;
                date_password_changed: z.ZodNullable<z.ZodNumber>;
                times_used: z.ZodNumber;
            }, "password">, "strict", z.ZodTypeAny, {
                id: number;
                origin_url: string;
                username: string;
                action_url: string;
                realm: string;
                date_created: number | null;
                date_last_used: number | null;
                date_password_changed: number | null;
                times_used: number;
            }, {
                id: number;
                origin_url: string;
                username: string;
                action_url: string;
                realm: string;
                date_created: number | null;
                date_last_used: number | null;
                date_password_changed: number | null;
                times_used: number;
            }>, "many">;
            total: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            items: {
                id: number;
                origin_url: string;
                username: string;
                action_url: string;
                realm: string;
                date_created: number | null;
                date_last_used: number | null;
                date_password_changed: number | null;
                times_used: number;
            }[];
            total: number;
        }, {
            items: {
                id: number;
                origin_url: string;
                username: string;
                action_url: string;
                realm: string;
                date_created: number | null;
                date_last_used: number | null;
                date_password_changed: number | null;
                times_used: number;
            }[];
            total: number;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getPasswordForSite: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            origin_url: z.ZodString;
            username: z.ZodString;
            password: z.ZodString;
            action_url: z.ZodString;
            realm: z.ZodString;
            date_created: z.ZodNullable<z.ZodNumber>;
            date_last_used: z.ZodNullable<z.ZodNumber>;
            date_password_changed: z.ZodNullable<z.ZodNumber>;
            times_used: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            id: number;
            origin_url: string;
            username: string;
            password: string;
            action_url: string;
            realm: string;
            date_created: number | null;
            date_last_used: number | null;
            date_password_changed: number | null;
            times_used: number;
        }, {
            id: number;
            origin_url: string;
            username: string;
            password: string;
            action_url: string;
            realm: string;
            date_created: number | null;
            date_last_used: number | null;
            date_password_changed: number | null;
            times_used: number;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listPasswordsPage: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
        returns: z.ZodObject<{
            items: z.ZodArray<z.ZodObject<{
                id: z.ZodNumber;
                origin_url: z.ZodString;
                username: z.ZodString;
                password: z.ZodString;
                action_url: z.ZodString;
                realm: z.ZodString;
                date_created: z.ZodNullable<z.ZodNumber>;
                date_last_used: z.ZodNullable<z.ZodNumber>;
                date_password_changed: z.ZodNullable<z.ZodNumber>;
                times_used: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                id: number;
                origin_url: string;
                username: string;
                password: string;
                action_url: string;
                realm: string;
                date_created: number | null;
                date_last_used: number | null;
                date_password_changed: number | null;
                times_used: number;
            }, {
                id: number;
                origin_url: string;
                username: string;
                password: string;
                action_url: string;
                realm: string;
                date_created: number | null;
                date_last_used: number | null;
                date_password_changed: number | null;
                times_used: number;
            }>, "many">;
            total: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            items: {
                id: number;
                origin_url: string;
                username: string;
                password: string;
                action_url: string;
                realm: string;
                date_created: number | null;
                date_last_used: number | null;
                date_password_changed: number | null;
                times_used: number;
            }[];
            total: number;
        }, {
            items: {
                id: number;
                origin_url: string;
                username: string;
                password: string;
                action_url: string;
                realm: string;
                date_created: number | null;
                date_last_used: number | null;
                date_password_changed: number | null;
                times_used: number;
            }[];
            total: number;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addPassword: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            url: z.ZodString;
            actionUrl: z.ZodOptional<z.ZodString>;
            username: z.ZodString;
            password: z.ZodString;
            realm: z.ZodOptional<z.ZodString>;
            dateCreated: z.ZodOptional<z.ZodNumber>;
            dateLastUsed: z.ZodOptional<z.ZodNumber>;
            datePasswordChanged: z.ZodOptional<z.ZodNumber>;
            timesUsed: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            url: string;
            actionUrl?: string | undefined;
            username: string;
            password: string;
            realm?: string | undefined;
            dateCreated?: number | undefined;
            dateLastUsed?: number | undefined;
            datePasswordChanged?: number | undefined;
            timesUsed?: number | undefined;
        }, {
            url: string;
            actionUrl?: string | undefined;
            username: string;
            password: string;
            realm?: string | undefined;
            dateCreated?: number | undefined;
            dateLastUsed?: number | undefined;
            datePasswordChanged?: number | undefined;
            timesUsed?: number | undefined;
        }>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly updatePassword: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodObject<{
            url: z.ZodOptional<z.ZodString>;
            actionUrl: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            username: z.ZodOptional<z.ZodString>;
            password: z.ZodOptional<z.ZodString>;
            realm: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            dateCreated: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
            dateLastUsed: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
            datePasswordChanged: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
            timesUsed: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        }, "strict", z.ZodTypeAny, {
            url?: string | undefined;
            actionUrl?: string | undefined;
            username?: string | undefined;
            password?: string | undefined;
            realm?: string | undefined;
            dateCreated?: number | undefined;
            dateLastUsed?: number | undefined;
            datePasswordChanged?: number | undefined;
            timesUsed?: number | undefined;
        }, {
            url?: string | undefined;
            actionUrl?: string | undefined;
            username?: string | undefined;
            password?: string | undefined;
            realm?: string | undefined;
            dateCreated?: number | undefined;
            dateLastUsed?: number | undefined;
            datePasswordChanged?: number | undefined;
            timesUsed?: number | undefined;
        }>], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly deletePassword: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addNeverSave: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly isNeverSave: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodBoolean;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getNeverSaveOrigins: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodArray<z.ZodString, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getNeverSaveOriginsPage: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
        returns: z.ZodObject<{
            items: z.ZodArray<z.ZodString, "many">;
            total: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            items: string[];
            total: number;
        }, {
            items: string[];
            total: number;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly removeNeverSave: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly updateLastUsed: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getFormFillSuggestions: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            fieldName: z.ZodOptional<z.ZodString>;
            type: z.ZodOptional<z.ZodEnum<["name", "given-name", "additional-name", "family-name", "honorific-prefix", "honorific-suffix", "nickname", "username", "new-password", "current-password", "one-time-code", "organization-title", "email", "tel", "tel-country-code", "tel-national", "tel-area-code", "tel-local", "tel-local-prefix", "tel-local-suffix", "tel-extension", "impp", "organization", "street-address", "address-line1", "address-line2", "address-line3", "address-level1", "address-level2", "address-level3", "address-level4", "postal-code", "country", "country-name", "cc-name", "cc-given-name", "cc-additional-name", "cc-family-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-type", "transaction-currency", "transaction-amount", "language", "bday", "bday-day", "bday-month", "bday-year", "sex", "url", "photo"]>>;
            prefix: z.ZodOptional<z.ZodString>;
            limit: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            fieldName?: string | undefined;
            type?: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | undefined;
            prefix?: string | undefined;
            limit?: number | undefined;
        }, {
            fieldName?: string | undefined;
            type?: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | undefined;
            prefix?: string | undefined;
            limit?: number | undefined;
        }>], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            fieldName: z.ZodString;
            type: z.ZodNullable<z.ZodEnum<["name", "given-name", "additional-name", "family-name", "honorific-prefix", "honorific-suffix", "nickname", "username", "new-password", "current-password", "one-time-code", "organization-title", "email", "tel", "tel-country-code", "tel-national", "tel-area-code", "tel-local", "tel-local-prefix", "tel-local-suffix", "tel-extension", "impp", "organization", "street-address", "address-line1", "address-line2", "address-line3", "address-level1", "address-level2", "address-level3", "address-level4", "postal-code", "country", "country-name", "cc-name", "cc-given-name", "cc-additional-name", "cc-family-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-type", "transaction-currency", "transaction-amount", "language", "bday", "bday-day", "bday-month", "bday-year", "sex", "url", "photo"]>>;
            value: z.ZodString;
            displayLabel: z.ZodNullable<z.ZodString>;
            aliases: z.ZodArray<z.ZodString, "many">;
            createdAt: z.ZodNumber;
            updatedAt: z.ZodNumber;
            useCount: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            id: number;
            fieldName: string;
            type: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | null;
            value: string;
            displayLabel: string | null;
            aliases: string[];
            createdAt: number;
            updatedAt: number;
            useCount: number;
        }, {
            id: number;
            fieldName: string;
            type: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | null;
            value: string;
            displayLabel: string | null;
            aliases: string[];
            createdAt: number;
            updatedAt: number;
            useCount: number;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listFormFillValues: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            fieldName: z.ZodString;
            type: z.ZodNullable<z.ZodEnum<["name", "given-name", "additional-name", "family-name", "honorific-prefix", "honorific-suffix", "nickname", "username", "new-password", "current-password", "one-time-code", "organization-title", "email", "tel", "tel-country-code", "tel-national", "tel-area-code", "tel-local", "tel-local-prefix", "tel-local-suffix", "tel-extension", "impp", "organization", "street-address", "address-line1", "address-line2", "address-line3", "address-level1", "address-level2", "address-level3", "address-level4", "postal-code", "country", "country-name", "cc-name", "cc-given-name", "cc-additional-name", "cc-family-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-type", "transaction-currency", "transaction-amount", "language", "bday", "bday-day", "bday-month", "bday-year", "sex", "url", "photo"]>>;
            value: z.ZodString;
            displayLabel: z.ZodNullable<z.ZodString>;
            aliases: z.ZodArray<z.ZodString, "many">;
            createdAt: z.ZodNumber;
            updatedAt: z.ZodNumber;
            useCount: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            id: number;
            fieldName: string;
            type: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | null;
            value: string;
            displayLabel: string | null;
            aliases: string[];
            createdAt: number;
            updatedAt: number;
            useCount: number;
        }, {
            id: number;
            fieldName: string;
            type: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | null;
            value: string;
            displayLabel: string | null;
            aliases: string[];
            createdAt: number;
            updatedAt: number;
            useCount: number;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listFormFillValuesPage: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
        returns: z.ZodObject<{
            items: z.ZodArray<z.ZodObject<{
                id: z.ZodNumber;
                fieldName: z.ZodString;
                type: z.ZodNullable<z.ZodEnum<["name", "given-name", "additional-name", "family-name", "honorific-prefix", "honorific-suffix", "nickname", "username", "new-password", "current-password", "one-time-code", "organization-title", "email", "tel", "tel-country-code", "tel-national", "tel-area-code", "tel-local", "tel-local-prefix", "tel-local-suffix", "tel-extension", "impp", "organization", "street-address", "address-line1", "address-line2", "address-line3", "address-level1", "address-level2", "address-level3", "address-level4", "postal-code", "country", "country-name", "cc-name", "cc-given-name", "cc-additional-name", "cc-family-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-type", "transaction-currency", "transaction-amount", "language", "bday", "bday-day", "bday-month", "bday-year", "sex", "url", "photo"]>>;
                value: z.ZodString;
                displayLabel: z.ZodNullable<z.ZodString>;
                aliases: z.ZodArray<z.ZodString, "many">;
                createdAt: z.ZodNumber;
                updatedAt: z.ZodNumber;
                useCount: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                id: number;
                fieldName: string;
                type: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | null;
                value: string;
                displayLabel: string | null;
                aliases: string[];
                createdAt: number;
                updatedAt: number;
                useCount: number;
            }, {
                id: number;
                fieldName: string;
                type: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | null;
                value: string;
                displayLabel: string | null;
                aliases: string[];
                createdAt: number;
                updatedAt: number;
                useCount: number;
            }>, "many">;
            total: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            items: {
                id: number;
                fieldName: string;
                type: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | null;
                value: string;
                displayLabel: string | null;
                aliases: string[];
                createdAt: number;
                updatedAt: number;
                useCount: number;
            }[];
            total: number;
        }, {
            items: {
                id: number;
                fieldName: string;
                type: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | null;
                value: string;
                displayLabel: string | null;
                aliases: string[];
                createdAt: number;
                updatedAt: number;
                useCount: number;
            }[];
            total: number;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addFormFillValue: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            fieldName: z.ZodString;
            type: z.ZodOptional<z.ZodEnum<["name", "given-name", "additional-name", "family-name", "honorific-prefix", "honorific-suffix", "nickname", "username", "new-password", "current-password", "one-time-code", "organization-title", "email", "tel", "tel-country-code", "tel-national", "tel-area-code", "tel-local", "tel-local-prefix", "tel-local-suffix", "tel-extension", "impp", "organization", "street-address", "address-line1", "address-line2", "address-line3", "address-level1", "address-level2", "address-level3", "address-level4", "postal-code", "country", "country-name", "cc-name", "cc-given-name", "cc-additional-name", "cc-family-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-type", "transaction-currency", "transaction-amount", "language", "bday", "bday-day", "bday-month", "bday-year", "sex", "url", "photo"]>>;
            value: z.ZodString;
            displayLabel: z.ZodOptional<z.ZodString>;
            aliases: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            createdAt: z.ZodOptional<z.ZodNumber>;
            updatedAt: z.ZodOptional<z.ZodNumber>;
            useCount: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            fieldName: string;
            type?: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | undefined;
            value: string;
            displayLabel?: string | undefined;
            aliases?: string[] | undefined;
            createdAt?: number | undefined;
            updatedAt?: number | undefined;
            useCount?: number | undefined;
        }, {
            fieldName: string;
            type?: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | undefined;
            value: string;
            displayLabel?: string | undefined;
            aliases?: string[] | undefined;
            createdAt?: number | undefined;
            updatedAt?: number | undefined;
            useCount?: number | undefined;
        }>, z.ZodOptional<z.ZodString>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly updateFormFillValue: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodObject<{
            value: z.ZodOptional<z.ZodString>;
            displayLabel: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            aliases: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
        }, "strict", z.ZodTypeAny, {
            value?: string | undefined;
            displayLabel?: string | undefined;
            aliases?: string[] | undefined;
        }, {
            value?: string | undefined;
            displayLabel?: string | undefined;
            aliases?: string[] | undefined;
        }>], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly markFormFillValueUsed: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly deleteFormFillValue: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly clearFormFillValues: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly applyCookieMutations: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            mutations: z.ZodArray<z.ZodDiscriminatedUnion<"op", [z.ZodObject<{
                op: z.ZodLiteral<"put">;
                cookie: z.ZodObject<{
                    name: z.ZodString;
                    domain: z.ZodString;
                    path: z.ZodString;
                    partitionKey: z.ZodOptional<z.ZodObject<{
                        topLevelSite: z.ZodString;
                        hasCrossSiteAncestor: z.ZodBoolean;
                    }, "strict", z.ZodTypeAny, {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    }, {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    }>>;
                } & {
                    value: z.ZodString;
                    hostOnly: z.ZodBoolean;
                    secure: z.ZodBoolean;
                    httpOnly: z.ZodBoolean;
                    sameSite: z.ZodEnum<["unspecified", "no_restriction", "lax", "strict"]>;
                    expirationDate: z.ZodOptional<z.ZodNumber>;
                    sourceScheme: z.ZodOptional<z.ZodString>;
                    sourcePort: z.ZodOptional<z.ZodNumber>;
                    createdAt: z.ZodOptional<z.ZodNumber>;
                    lastAccessed: z.ZodOptional<z.ZodNumber>;
                }, "strict", z.ZodTypeAny, {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                    value: string;
                    hostOnly: boolean;
                    secure: boolean;
                    httpOnly: boolean;
                    sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                    expirationDate?: number | undefined;
                    sourceScheme?: string | undefined;
                    sourcePort?: number | undefined;
                    createdAt?: number | undefined;
                    lastAccessed?: number | undefined;
                }, {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                    value: string;
                    hostOnly: boolean;
                    secure: boolean;
                    httpOnly: boolean;
                    sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                    expirationDate?: number | undefined;
                    sourceScheme?: string | undefined;
                    sourcePort?: number | undefined;
                    createdAt?: number | undefined;
                    lastAccessed?: number | undefined;
                }>;
                mutationId: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                op: "put";
                cookie: {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                    value: string;
                    hostOnly: boolean;
                    secure: boolean;
                    httpOnly: boolean;
                    sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                    expirationDate?: number | undefined;
                    sourceScheme?: string | undefined;
                    sourcePort?: number | undefined;
                    createdAt?: number | undefined;
                    lastAccessed?: number | undefined;
                };
                mutationId: string;
            }, {
                op: "put";
                cookie: {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                    value: string;
                    hostOnly: boolean;
                    secure: boolean;
                    httpOnly: boolean;
                    sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                    expirationDate?: number | undefined;
                    sourceScheme?: string | undefined;
                    sourcePort?: number | undefined;
                    createdAt?: number | undefined;
                    lastAccessed?: number | undefined;
                };
                mutationId: string;
            }>, z.ZodObject<{
                op: z.ZodLiteral<"delete">;
                key: z.ZodObject<{
                    name: z.ZodString;
                    domain: z.ZodString;
                    path: z.ZodString;
                    partitionKey: z.ZodOptional<z.ZodObject<{
                        topLevelSite: z.ZodString;
                        hasCrossSiteAncestor: z.ZodBoolean;
                    }, "strict", z.ZodTypeAny, {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    }, {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    }>>;
                }, "strict", z.ZodTypeAny, {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                }, {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                }>;
                mutationId: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                op: "delete";
                key: {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                };
                mutationId: string;
            }, {
                op: "delete";
                key: {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                };
                mutationId: string;
            }>]>, "many">;
        }, "strict", z.ZodTypeAny, {
            mutations: ({
                op: "put";
                cookie: {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                    value: string;
                    hostOnly: boolean;
                    secure: boolean;
                    httpOnly: boolean;
                    sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                    expirationDate?: number | undefined;
                    sourceScheme?: string | undefined;
                    sourcePort?: number | undefined;
                    createdAt?: number | undefined;
                    lastAccessed?: number | undefined;
                };
                mutationId: string;
            } | {
                op: "delete";
                key: {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                };
                mutationId: string;
            })[];
        }, {
            mutations: ({
                op: "put";
                cookie: {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                    value: string;
                    hostOnly: boolean;
                    secure: boolean;
                    httpOnly: boolean;
                    sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                    expirationDate?: number | undefined;
                    sourceScheme?: string | undefined;
                    sourcePort?: number | undefined;
                    createdAt?: number | undefined;
                    lastAccessed?: number | undefined;
                };
                mutationId: string;
            } | {
                op: "delete";
                key: {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                };
                mutationId: string;
            })[];
        }>], null>;
        returns: z.ZodObject<{
            revision: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            revision: number;
        }, {
            revision: number;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listCookieOrigins: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodObject<{
            revision: z.ZodNumber;
            origins: z.ZodArray<z.ZodString, "many">;
        }, "strict", z.ZodTypeAny, {
            revision: number;
            origins: string[];
        }, {
            revision: number;
            origins: string[];
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listCookieOriginsPage: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
        returns: z.ZodObject<{
            items: z.ZodArray<z.ZodString, "many">;
            total: z.ZodNumber;
            revision: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            items: string[];
            total: number;
            revision: number;
        }, {
            items: string[];
            total: number;
            revision: number;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getCookiesForOrigin: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            domain: z.ZodString;
            path: z.ZodString;
            partitionKey: z.ZodOptional<z.ZodObject<{
                topLevelSite: z.ZodString;
                hasCrossSiteAncestor: z.ZodBoolean;
            }, "strict", z.ZodTypeAny, {
                topLevelSite: string;
                hasCrossSiteAncestor: boolean;
            }, {
                topLevelSite: string;
                hasCrossSiteAncestor: boolean;
            }>>;
            value: z.ZodString;
            hostOnly: z.ZodBoolean;
            secure: z.ZodBoolean;
            httpOnly: z.ZodBoolean;
            sameSite: z.ZodEnum<["unspecified", "no_restriction", "lax", "strict"]>;
            expirationDate: z.ZodOptional<z.ZodNumber>;
            sourceScheme: z.ZodOptional<z.ZodString>;
            sourcePort: z.ZodOptional<z.ZodNumber>;
            lastAccessed: z.ZodOptional<z.ZodNumber>;
        } & {
            encryptedValue: z.ZodString;
            contentHash: z.ZodString;
            createdAt: z.ZodNumber;
            revision: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            name: string;
            domain: string;
            path: string;
            partitionKey?: {
                topLevelSite: string;
                hasCrossSiteAncestor: boolean;
            } | undefined;
            value: string;
            hostOnly: boolean;
            secure: boolean;
            httpOnly: boolean;
            sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
            expirationDate?: number | undefined;
            sourceScheme?: string | undefined;
            sourcePort?: number | undefined;
            lastAccessed?: number | undefined;
            encryptedValue: string;
            contentHash: string;
            createdAt: number;
            revision: number;
        }, {
            name: string;
            domain: string;
            path: string;
            partitionKey?: {
                topLevelSite: string;
                hasCrossSiteAncestor: boolean;
            } | undefined;
            value: string;
            hostOnly: boolean;
            secure: boolean;
            httpOnly: boolean;
            sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
            expirationDate?: number | undefined;
            sourceScheme?: string | undefined;
            sourcePort?: number | undefined;
            lastAccessed?: number | undefined;
            encryptedValue: string;
            contentHash: string;
            createdAt: number;
            revision: number;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listCookiesPage: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
        returns: z.ZodObject<{
            items: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                domain: z.ZodString;
                path: z.ZodString;
                partitionKey: z.ZodOptional<z.ZodObject<{
                    topLevelSite: z.ZodString;
                    hasCrossSiteAncestor: z.ZodBoolean;
                }, "strict", z.ZodTypeAny, {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                }, {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                }>>;
                value: z.ZodString;
                hostOnly: z.ZodBoolean;
                secure: z.ZodBoolean;
                httpOnly: z.ZodBoolean;
                sameSite: z.ZodEnum<["unspecified", "no_restriction", "lax", "strict"]>;
                expirationDate: z.ZodOptional<z.ZodNumber>;
                sourceScheme: z.ZodOptional<z.ZodString>;
                sourcePort: z.ZodOptional<z.ZodNumber>;
                lastAccessed: z.ZodOptional<z.ZodNumber>;
            } & {
                encryptedValue: z.ZodString;
                contentHash: z.ZodString;
                createdAt: z.ZodNumber;
                revision: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                name: string;
                domain: string;
                path: string;
                partitionKey?: {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                } | undefined;
                value: string;
                hostOnly: boolean;
                secure: boolean;
                httpOnly: boolean;
                sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                expirationDate?: number | undefined;
                sourceScheme?: string | undefined;
                sourcePort?: number | undefined;
                lastAccessed?: number | undefined;
                encryptedValue: string;
                contentHash: string;
                createdAt: number;
                revision: number;
            }, {
                name: string;
                domain: string;
                path: string;
                partitionKey?: {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                } | undefined;
                value: string;
                hostOnly: boolean;
                secure: boolean;
                httpOnly: boolean;
                sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                expirationDate?: number | undefined;
                sourceScheme?: string | undefined;
                sourcePort?: number | undefined;
                lastAccessed?: number | undefined;
                encryptedValue: string;
                contentHash: string;
                createdAt: number;
                revision: number;
            }>, "many">;
            total: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            items: {
                name: string;
                domain: string;
                path: string;
                partitionKey?: {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                } | undefined;
                value: string;
                hostOnly: boolean;
                secure: boolean;
                httpOnly: boolean;
                sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                expirationDate?: number | undefined;
                sourceScheme?: string | undefined;
                sourcePort?: number | undefined;
                lastAccessed?: number | undefined;
                encryptedValue: string;
                contentHash: string;
                createdAt: number;
                revision: number;
            }[];
            total: number;
        }, {
            items: {
                name: string;
                domain: string;
                path: string;
                partitionKey?: {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                } | undefined;
                value: string;
                hostOnly: boolean;
                secure: boolean;
                httpOnly: boolean;
                sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                expirationDate?: number | undefined;
                sourceScheme?: string | undefined;
                sourcePort?: number | undefined;
                lastAccessed?: number | undefined;
                encryptedValue: string;
                contentHash: string;
                createdAt: number;
                revision: number;
            }[];
            total: number;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly clearCookiesForOrigin: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly clearAllCookies: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly endBrowserSession: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getCookieSiteSummary: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodObject<{
            origin: z.ZodString;
            cookieCount: z.ZodNumber;
            revision: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            origin: string;
            cookieCount: number;
            revision: number;
        }, {
            origin: string;
            cookieCount: number;
            revision: number;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getSearchEngines: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            name: z.ZodString;
            keyword: z.ZodNullable<z.ZodString>;
            search_url: z.ZodString;
            suggest_url: z.ZodNullable<z.ZodString>;
            favicon_url: z.ZodNullable<z.ZodString>;
            is_default: z.ZodNumber;
            source_id: z.ZodNullable<z.ZodString>;
            import_key: z.ZodNullable<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            id: number;
            name: string;
            keyword: string | null;
            search_url: string;
            suggest_url: string | null;
            favicon_url: string | null;
            is_default: number;
            source_id: string | null;
            import_key: string | null;
        }, {
            id: number;
            name: string;
            keyword: string | null;
            search_url: string;
            suggest_url: string | null;
            favicon_url: string | null;
            is_default: number;
            source_id: string | null;
            import_key: string | null;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly setDefaultEngine: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly saveSearchEngine: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<Omit<{
            name: z.ZodString;
            keyword: z.ZodOptional<z.ZodString>;
            searchUrl: z.ZodString;
            suggestUrl: z.ZodOptional<z.ZodString>;
            faviconUrl: z.ZodOptional<z.ZodString>;
            isDefault: z.ZodBoolean;
            sourceId: z.ZodOptional<z.ZodString>;
        }, "faviconUrl" | "sourceId"> & {
            id: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            name: string;
            keyword?: string | undefined;
            searchUrl: string;
            suggestUrl?: string | undefined;
            isDefault: boolean;
            id?: number | undefined;
        }, {
            name: string;
            keyword?: string | undefined;
            searchUrl: string;
            suggestUrl?: string | undefined;
            isDefault: boolean;
            id?: number | undefined;
        }>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getSearchSuggestions: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodArray<z.ZodObject<{
            url: z.ZodString;
            title: z.ZodString;
            source: z.ZodLiteral<"search-suggestion">;
            completionQuery: z.ZodString;
            engineId: z.ZodNumber;
            engineName: z.ZodString;
            searchTemplate: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            url: string;
            title: string;
            source: "search-suggestion";
            completionQuery: string;
            engineId: number;
            engineName: string;
            searchTemplate: string;
        }, {
            url: string;
            title: string;
            source: "search-suggestion";
            completionQuery: string;
            engineId: number;
            engineName: string;
            searchTemplate: string;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly putPageFavicon: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            pageUrl: z.ZodString;
            origin: z.ZodString;
            sourceUrl: z.ZodOptional<z.ZodString>;
            data: z.ZodString;
            mimeType: z.ZodEnum<["image/png", "image/jpeg", "image/gif", "image/webp", "image/x-icon", "image/svg+xml", "image/bmp", "image/avif"]>;
            updatedAt: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            pageUrl: string;
            origin: string;
            sourceUrl?: string | undefined;
            data: string;
            mimeType: "image/avif" | "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/svg+xml" | "image/webp" | "image/x-icon";
            updatedAt: number;
        }, {
            pageUrl: string;
            origin: string;
            sourceUrl?: string | undefined;
            data: string;
            mimeType: "image/avif" | "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/svg+xml" | "image/webp" | "image/x-icon";
            updatedAt: number;
        }>], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getPageFavicon: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodNullable<z.ZodObject<{
            page_url: z.ZodString;
            origin: z.ZodString;
            source_url: z.ZodNullable<z.ZodString>;
            image_data: z.ZodString;
            mime_type: z.ZodEnum<["image/png", "image/jpeg", "image/gif", "image/webp", "image/x-icon", "image/svg+xml", "image/bmp", "image/avif"]>;
            updated_at: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            page_url: string;
            origin: string;
            source_url: string | null;
            image_data: string;
            mime_type: "image/avif" | "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/svg+xml" | "image/webp" | "image/x-icon";
            updated_at: number;
        }, {
            page_url: string;
            origin: string;
            source_url: string | null;
            image_data: string;
            mime_type: "image/avif" | "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/svg+xml" | "image/webp" | "image/x-icon";
            updated_at: number;
        }>>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly upsertImportJob: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            jobId: z.ZodString;
            hostId: z.ZodString;
            hostLabel: z.ZodString;
            sourceId: z.ZodString;
            browser: z.ZodString;
            phase: z.ZodEnum<["queued", "discovering", "copying", "reading", "decrypting", "normalizing", "storing", "reconciling", "complete", "cancelled", "failed", "partial"]>;
            startedAt: z.ZodNumber;
            updatedAt: z.ZodNumber;
            finishedAt: z.ZodOptional<z.ZodNumber>;
            dataTypes: z.ZodArray<z.ZodEnum<["bookmarks", "history", "cookies", "passwords", "formFill", "searchEngines", "favicons"]>, "many">;
            progress: z.ZodArray<z.ZodObject<{
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
            error: z.ZodOptional<z.ZodString>;
            resumable: z.ZodBoolean;
        }, "strict", z.ZodTypeAny, {
            jobId: string;
            hostId: string;
            hostLabel: string;
            sourceId: string;
            browser: string;
            phase: "cancelled" | "complete" | "copying" | "decrypting" | "discovering" | "failed" | "normalizing" | "partial" | "queued" | "reading" | "reconciling" | "storing";
            startedAt: number;
            updatedAt: number;
            finishedAt?: number | undefined;
            dataTypes: ("bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines")[];
            progress: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            warnings: string[];
            error?: string | undefined;
            resumable: boolean;
        }, {
            jobId: string;
            hostId: string;
            hostLabel: string;
            sourceId: string;
            browser: string;
            phase: "cancelled" | "complete" | "copying" | "decrypting" | "discovering" | "failed" | "normalizing" | "partial" | "queued" | "reading" | "reconciling" | "storing";
            startedAt: number;
            updatedAt: number;
            finishedAt?: number | undefined;
            dataTypes: ("bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines")[];
            progress: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            warnings: string[];
            error?: string | undefined;
            resumable: boolean;
        }>], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getImportJob: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodNullable<z.ZodObject<{
            jobId: z.ZodString;
            hostId: z.ZodString;
            hostLabel: z.ZodOptional<z.ZodString>;
            sourceId: z.ZodString;
            browser: z.ZodOptional<z.ZodString>;
            phase: z.ZodEnum<["queued", "discovering", "copying", "reading", "decrypting", "normalizing", "storing", "reconciling", "complete", "cancelled", "failed", "partial"]>;
            requestedDataTypes: z.ZodArray<z.ZodEnum<["bookmarks", "history", "cookies", "passwords", "formFill", "searchEngines", "favicons"]>, "many">;
            startedAt: z.ZodNumber;
            updatedAt: z.ZodNumber;
            finishedAt: z.ZodOptional<z.ZodNumber>;
            progress: z.ZodArray<z.ZodObject<{
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
            error: z.ZodOptional<z.ZodString>;
            resumable: z.ZodBoolean;
        }, "strict", z.ZodTypeAny, {
            jobId: string;
            hostId: string;
            hostLabel?: string | undefined;
            sourceId: string;
            browser?: string | undefined;
            phase: "cancelled" | "complete" | "copying" | "decrypting" | "discovering" | "failed" | "normalizing" | "partial" | "queued" | "reading" | "reconciling" | "storing";
            requestedDataTypes: ("bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines")[];
            startedAt: number;
            updatedAt: number;
            finishedAt?: number | undefined;
            progress: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            warnings: string[];
            error?: string | undefined;
            resumable: boolean;
        }, {
            jobId: string;
            hostId: string;
            hostLabel?: string | undefined;
            sourceId: string;
            browser?: string | undefined;
            phase: "cancelled" | "complete" | "copying" | "decrypting" | "discovering" | "failed" | "normalizing" | "partial" | "queued" | "reading" | "reconciling" | "storing";
            requestedDataTypes: ("bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines")[];
            startedAt: number;
            updatedAt: number;
            finishedAt?: number | undefined;
            progress: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            warnings: string[];
            error?: string | undefined;
            resumable: boolean;
        }>>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listImportJobs: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodArray<z.ZodObject<{
            jobId: z.ZodString;
            hostId: z.ZodString;
            hostLabel: z.ZodOptional<z.ZodString>;
            sourceId: z.ZodString;
            browser: z.ZodOptional<z.ZodString>;
            phase: z.ZodEnum<["queued", "discovering", "copying", "reading", "decrypting", "normalizing", "storing", "reconciling", "complete", "cancelled", "failed", "partial"]>;
            requestedDataTypes: z.ZodArray<z.ZodEnum<["bookmarks", "history", "cookies", "passwords", "formFill", "searchEngines", "favicons"]>, "many">;
            startedAt: z.ZodNumber;
            updatedAt: z.ZodNumber;
            finishedAt: z.ZodOptional<z.ZodNumber>;
            progress: z.ZodArray<z.ZodObject<{
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
            error: z.ZodOptional<z.ZodString>;
            resumable: z.ZodBoolean;
        }, "strict", z.ZodTypeAny, {
            jobId: string;
            hostId: string;
            hostLabel?: string | undefined;
            sourceId: string;
            browser?: string | undefined;
            phase: "cancelled" | "complete" | "copying" | "decrypting" | "discovering" | "failed" | "normalizing" | "partial" | "queued" | "reading" | "reconciling" | "storing";
            requestedDataTypes: ("bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines")[];
            startedAt: number;
            updatedAt: number;
            finishedAt?: number | undefined;
            progress: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            warnings: string[];
            error?: string | undefined;
            resumable: boolean;
        }, {
            jobId: string;
            hostId: string;
            hostLabel?: string | undefined;
            sourceId: string;
            browser?: string | undefined;
            phase: "cancelled" | "complete" | "copying" | "decrypting" | "discovering" | "failed" | "normalizing" | "partial" | "queued" | "reading" | "reconciling" | "storing";
            requestedDataTypes: ("bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines")[];
            startedAt: number;
            updatedAt: number;
            finishedAt?: number | undefined;
            progress: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            warnings: string[];
            error?: string | undefined;
            resumable: boolean;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly recordImportBatch: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            jobId: z.ZodString;
            dataType: z.ZodString;
            batchIndex: z.ZodNumber;
            idempotencyKey: z.ZodString;
            itemCount: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            jobId: string;
            dataType: string;
            batchIndex: number;
            idempotencyKey: string;
            itemCount: number;
        }, {
            jobId: string;
            dataType: string;
            batchIndex: number;
            idempotencyKey: string;
            itemCount: number;
        }>], null>;
        returns: z.ZodObject<{
            stored: z.ZodBoolean;
        }, "strict", z.ZodTypeAny, {
            stored: boolean;
        }, {
            stored: boolean;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addBookmarksBatch: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodArray<z.ZodObject<{
            title: z.ZodString;
            url: z.ZodString;
            dateAdded: z.ZodNumber;
            dateModified: z.ZodOptional<z.ZodNumber>;
            folder: z.ZodArray<z.ZodString, "many">;
            tags: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            keyword: z.ZodOptional<z.ZodString>;
            sourceId: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            title: string;
            url: string;
            dateAdded: number;
            dateModified?: number | undefined;
            folder: string[];
            tags?: string[] | undefined;
            keyword?: string | undefined;
            sourceId?: string | undefined;
        }, {
            title: string;
            url: string;
            dateAdded: number;
            dateModified?: number | undefined;
            folder: string[];
            tags?: string[] | undefined;
            keyword?: string | undefined;
            sourceId?: string | undefined;
        }>, "many">, z.ZodObject<{
            sourceId: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            sourceId: string;
        }, {
            sourceId: string;
        }>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addHistoryBatch: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodArray<z.ZodObject<{
            url: z.ZodString;
            title: z.ZodString;
            visitCount: z.ZodNumber;
            lastVisitTime: z.ZodNumber;
            firstVisitTime: z.ZodOptional<z.ZodNumber>;
            typedCount: z.ZodOptional<z.ZodNumber>;
            transition: z.ZodOptional<z.ZodString>;
            visits: z.ZodOptional<z.ZodArray<z.ZodObject<{
                visitTime: z.ZodNumber;
                transition: z.ZodOptional<z.ZodString>;
                typed: z.ZodOptional<z.ZodBoolean>;
            }, "strict", z.ZodTypeAny, {
                visitTime: number;
                transition?: string | undefined;
                typed?: boolean | undefined;
            }, {
                visitTime: number;
                transition?: string | undefined;
                typed?: boolean | undefined;
            }>, "many">>;
        }, "strict", z.ZodTypeAny, {
            url: string;
            title: string;
            visitCount: number;
            lastVisitTime: number;
            firstVisitTime?: number | undefined;
            typedCount?: number | undefined;
            transition?: string | undefined;
            visits?: {
                visitTime: number;
                transition?: string | undefined;
                typed?: boolean | undefined;
            }[] | undefined;
        }, {
            url: string;
            title: string;
            visitCount: number;
            lastVisitTime: number;
            firstVisitTime?: number | undefined;
            typedCount?: number | undefined;
            transition?: string | undefined;
            visits?: {
                visitTime: number;
                transition?: string | undefined;
                typed?: boolean | undefined;
            }[] | undefined;
        }>, "many">, z.ZodObject<{
            sourceId: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            sourceId: string;
        }, {
            sourceId: string;
        }>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addCookiesBatch: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            jobId: z.ZodString;
            batchIndex: z.ZodNumber;
            cookies: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                domain: z.ZodString;
                path: z.ZodString;
                partitionKey: z.ZodOptional<z.ZodObject<{
                    topLevelSite: z.ZodString;
                    hasCrossSiteAncestor: z.ZodBoolean;
                }, "strict", z.ZodTypeAny, {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                }, {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                }>>;
            } & {
                value: z.ZodString;
                hostOnly: z.ZodBoolean;
                secure: z.ZodBoolean;
                httpOnly: z.ZodBoolean;
                sameSite: z.ZodEnum<["unspecified", "no_restriction", "lax", "strict"]>;
                expirationDate: z.ZodOptional<z.ZodNumber>;
                sourceScheme: z.ZodOptional<z.ZodString>;
                sourcePort: z.ZodOptional<z.ZodNumber>;
                createdAt: z.ZodOptional<z.ZodNumber>;
                lastAccessed: z.ZodOptional<z.ZodNumber>;
            }, "strict", z.ZodTypeAny, {
                name: string;
                domain: string;
                path: string;
                partitionKey?: {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                } | undefined;
                value: string;
                hostOnly: boolean;
                secure: boolean;
                httpOnly: boolean;
                sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                expirationDate?: number | undefined;
                sourceScheme?: string | undefined;
                sourcePort?: number | undefined;
                createdAt?: number | undefined;
                lastAccessed?: number | undefined;
            }, {
                name: string;
                domain: string;
                path: string;
                partitionKey?: {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                } | undefined;
                value: string;
                hostOnly: boolean;
                secure: boolean;
                httpOnly: boolean;
                sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                expirationDate?: number | undefined;
                sourceScheme?: string | undefined;
                sourcePort?: number | undefined;
                createdAt?: number | undefined;
                lastAccessed?: number | undefined;
            }>, "many">;
        }, "strict", z.ZodTypeAny, {
            jobId: string;
            batchIndex: number;
            cookies: {
                name: string;
                domain: string;
                path: string;
                partitionKey?: {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                } | undefined;
                value: string;
                hostOnly: boolean;
                secure: boolean;
                httpOnly: boolean;
                sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                expirationDate?: number | undefined;
                sourceScheme?: string | undefined;
                sourcePort?: number | undefined;
                createdAt?: number | undefined;
                lastAccessed?: number | undefined;
            }[];
        }, {
            jobId: string;
            batchIndex: number;
            cookies: {
                name: string;
                domain: string;
                path: string;
                partitionKey?: {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                } | undefined;
                value: string;
                hostOnly: boolean;
                secure: boolean;
                httpOnly: boolean;
                sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                expirationDate?: number | undefined;
                sourceScheme?: string | undefined;
                sourcePort?: number | undefined;
                createdAt?: number | undefined;
                lastAccessed?: number | undefined;
            }[];
        }>], null>;
        returns: z.ZodObject<{
            revision: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            revision: number;
        }, {
            revision: number;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addPasswordsBatch: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodArray<z.ZodObject<{
            url: z.ZodString;
            actionUrl: z.ZodOptional<z.ZodString>;
            username: z.ZodString;
            password: z.ZodString;
            realm: z.ZodOptional<z.ZodString>;
            dateCreated: z.ZodOptional<z.ZodNumber>;
            dateLastUsed: z.ZodOptional<z.ZodNumber>;
            datePasswordChanged: z.ZodOptional<z.ZodNumber>;
            timesUsed: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            url: string;
            actionUrl?: string | undefined;
            username: string;
            password: string;
            realm?: string | undefined;
            dateCreated?: number | undefined;
            dateLastUsed?: number | undefined;
            datePasswordChanged?: number | undefined;
            timesUsed?: number | undefined;
        }, {
            url: string;
            actionUrl?: string | undefined;
            username: string;
            password: string;
            realm?: string | undefined;
            dateCreated?: number | undefined;
            dateLastUsed?: number | undefined;
            datePasswordChanged?: number | undefined;
            timesUsed?: number | undefined;
        }>, "many">, z.ZodObject<{
            sourceId: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            sourceId: string;
        }, {
            sourceId: string;
        }>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addFormFillBatch: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodArray<z.ZodObject<{
            fieldName: z.ZodString;
            type: z.ZodOptional<z.ZodEnum<["name", "given-name", "additional-name", "family-name", "honorific-prefix", "honorific-suffix", "nickname", "username", "new-password", "current-password", "one-time-code", "organization-title", "email", "tel", "tel-country-code", "tel-national", "tel-area-code", "tel-local", "tel-local-prefix", "tel-local-suffix", "tel-extension", "impp", "organization", "street-address", "address-line1", "address-line2", "address-line3", "address-level1", "address-level2", "address-level3", "address-level4", "postal-code", "country", "country-name", "cc-name", "cc-given-name", "cc-additional-name", "cc-family-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-type", "transaction-currency", "transaction-amount", "language", "bday", "bday-day", "bday-month", "bday-year", "sex", "url", "photo"]>>;
            value: z.ZodString;
            displayLabel: z.ZodOptional<z.ZodString>;
            aliases: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            createdAt: z.ZodOptional<z.ZodNumber>;
            updatedAt: z.ZodOptional<z.ZodNumber>;
            useCount: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            fieldName: string;
            type?: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | undefined;
            value: string;
            displayLabel?: string | undefined;
            aliases?: string[] | undefined;
            createdAt?: number | undefined;
            updatedAt?: number | undefined;
            useCount?: number | undefined;
        }, {
            fieldName: string;
            type?: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | undefined;
            value: string;
            displayLabel?: string | undefined;
            aliases?: string[] | undefined;
            createdAt?: number | undefined;
            updatedAt?: number | undefined;
            useCount?: number | undefined;
        }>, "many">, z.ZodObject<{
            sourceId: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            sourceId: string;
        }, {
            sourceId: string;
        }>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addSearchEnginesBatch: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            keyword: z.ZodOptional<z.ZodString>;
            searchUrl: z.ZodString;
            suggestUrl: z.ZodOptional<z.ZodString>;
            faviconUrl: z.ZodOptional<z.ZodString>;
            isDefault: z.ZodBoolean;
            sourceId: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            name: string;
            keyword?: string | undefined;
            searchUrl: string;
            suggestUrl?: string | undefined;
            faviconUrl?: string | undefined;
            isDefault: boolean;
            sourceId?: string | undefined;
        }, {
            name: string;
            keyword?: string | undefined;
            searchUrl: string;
            suggestUrl?: string | undefined;
            faviconUrl?: string | undefined;
            isDefault: boolean;
            sourceId?: string | undefined;
        }>, "many">, z.ZodObject<{
            sourceId: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            sourceId: string;
        }, {
            sourceId: string;
        }>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addFaviconsBatch: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodArray<z.ZodObject<{
            pageUrl: z.ZodString;
            origin: z.ZodString;
            sourceUrl: z.ZodOptional<z.ZodString>;
            data: z.ZodString;
            mimeType: z.ZodEnum<["image/png", "image/jpeg", "image/gif", "image/webp", "image/x-icon", "image/svg+xml", "image/bmp", "image/avif"]>;
            updatedAt: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            pageUrl: string;
            origin: string;
            sourceUrl?: string | undefined;
            data: string;
            mimeType: "image/avif" | "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/svg+xml" | "image/webp" | "image/x-icon";
            updatedAt: number;
        }, {
            pageUrl: string;
            origin: string;
            sourceUrl?: string | undefined;
            data: string;
            mimeType: "image/avif" | "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/svg+xml" | "image/webp" | "image/x-icon";
            updatedAt: number;
        }>, "many">], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
};
declare const BROWSER_VAULT_METHOD_NAMES: readonly ["listPasswordSummaries", "listPasswordSummariesPage", "getPasswordForSite", "listPasswordsPage", "addPassword", "updatePassword", "deletePassword", "addNeverSave", "isNeverSave", "getNeverSaveOrigins", "getNeverSaveOriginsPage", "removeNeverSave", "updateLastUsed", "getFormFillSuggestions", "listFormFillValues", "listFormFillValuesPage", "addFormFillValue", "updateFormFillValue", "markFormFillValueUsed", "deleteFormFillValue", "clearFormFillValues", "applyCookieMutations", "listCookieOrigins", "listCookieOriginsPage", "getCookiesForOrigin", "listCookiesPage", "clearCookiesForOrigin", "clearAllCookies", "endBrowserSession", "getCookieSiteSummary", "addCookiesBatch", "addPasswordsBatch", "addFormFillBatch"];
type BrowserVaultMethodName = (typeof BROWSER_VAULT_METHOD_NAMES)[number];
type BrowserVaultMethod<K extends BrowserVaultMethodName> = Omit<(typeof browserDataMethods)[K], "authority" | "directEffect" | "agentFacing"> & {
    authority: {
        principals: ["host"];
    };
    directEffect: {
        kind: "host-capability";
        capability: string;
        resource: {
            kind: "receiver-object";
        };
    };
    agentFacing: false;
};
/** Host-owned protected credential and cookie effects. */
export declare const browserVaultMethods: {
    addCookiesBatch: BrowserVaultMethod<"addCookiesBatch">;
    addFormFillBatch: BrowserVaultMethod<"addFormFillBatch">;
    addFormFillValue: BrowserVaultMethod<"addFormFillValue">;
    addNeverSave: BrowserVaultMethod<"addNeverSave">;
    addPassword: BrowserVaultMethod<"addPassword">;
    addPasswordsBatch: BrowserVaultMethod<"addPasswordsBatch">;
    applyCookieMutations: BrowserVaultMethod<"applyCookieMutations">;
    clearAllCookies: BrowserVaultMethod<"clearAllCookies">;
    clearCookiesForOrigin: BrowserVaultMethod<"clearCookiesForOrigin">;
    clearFormFillValues: BrowserVaultMethod<"clearFormFillValues">;
    deleteFormFillValue: BrowserVaultMethod<"deleteFormFillValue">;
    deletePassword: BrowserVaultMethod<"deletePassword">;
    endBrowserSession: BrowserVaultMethod<"endBrowserSession">;
    getCookieSiteSummary: BrowserVaultMethod<"getCookieSiteSummary">;
    getCookiesForOrigin: BrowserVaultMethod<"getCookiesForOrigin">;
    getFormFillSuggestions: BrowserVaultMethod<"getFormFillSuggestions">;
    getNeverSaveOrigins: BrowserVaultMethod<"getNeverSaveOrigins">;
    getNeverSaveOriginsPage: BrowserVaultMethod<"getNeverSaveOriginsPage">;
    getPasswordForSite: BrowserVaultMethod<"getPasswordForSite">;
    isNeverSave: BrowserVaultMethod<"isNeverSave">;
    listCookieOrigins: BrowserVaultMethod<"listCookieOrigins">;
    listCookieOriginsPage: BrowserVaultMethod<"listCookieOriginsPage">;
    listCookiesPage: BrowserVaultMethod<"listCookiesPage">;
    listFormFillValues: BrowserVaultMethod<"listFormFillValues">;
    listFormFillValuesPage: BrowserVaultMethod<"listFormFillValuesPage">;
    listPasswordSummaries: BrowserVaultMethod<"listPasswordSummaries">;
    listPasswordSummariesPage: BrowserVaultMethod<"listPasswordSummariesPage">;
    listPasswordsPage: BrowserVaultMethod<"listPasswordsPage">;
    markFormFillValueUsed: BrowserVaultMethod<"markFormFillValueUsed">;
    removeNeverSave: BrowserVaultMethod<"removeNeverSave">;
    updateFormFillValue: BrowserVaultMethod<"updateFormFillValue">;
    updateLastUsed: BrowserVaultMethod<"updateLastUsed">;
    updatePassword: BrowserVaultMethod<"updatePassword">;
};
/** Workspace-owned durable browser product state. */
export declare const browserProductMethods: Omit<{
    readonly upsertDownloadRecord: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
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
        }, "strict", z.ZodTypeAny, {
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
        }>], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listDownloadRecords: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodArray<z.ZodObject<{
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
        }, "strict", z.ZodTypeAny, {
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
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getSitePreferences: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodObject<{
            origin: z.ZodString;
            zoomFactor: z.ZodNumber;
            updatedAt: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            origin: string;
            zoomFactor: number;
            updatedAt?: number | undefined;
        }, {
            origin: string;
            zoomFactor: number;
            updatedAt?: number | undefined;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly setSiteZoom: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString, z.ZodNumber], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getBookmarks: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodOptional<z.ZodString>], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            title: z.ZodString;
            url: z.ZodNullable<z.ZodString>;
            folder_path: z.ZodString;
            date_added: z.ZodNumber;
            date_modified: z.ZodNullable<z.ZodNumber>;
            position: z.ZodNumber;
            source_id: z.ZodNullable<z.ZodString>;
            import_key: z.ZodNullable<z.ZodString>;
            tags: z.ZodNullable<z.ZodString>;
            keyword: z.ZodNullable<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            id: number;
            title: string;
            url: string | null;
            folder_path: string;
            date_added: number;
            date_modified: number | null;
            position: number;
            source_id: string | null;
            import_key: string | null;
            tags: string | null;
            keyword: string | null;
        }, {
            id: number;
            title: string;
            url: string | null;
            folder_path: string;
            date_added: number;
            date_modified: number | null;
            position: number;
            source_id: string | null;
            import_key: string | null;
            tags: string | null;
            keyword: string | null;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getAllBookmarks: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            title: z.ZodString;
            url: z.ZodNullable<z.ZodString>;
            folder_path: z.ZodString;
            date_added: z.ZodNumber;
            date_modified: z.ZodNullable<z.ZodNumber>;
            position: z.ZodNumber;
            source_id: z.ZodNullable<z.ZodString>;
            import_key: z.ZodNullable<z.ZodString>;
            tags: z.ZodNullable<z.ZodString>;
            keyword: z.ZodNullable<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            id: number;
            title: string;
            url: string | null;
            folder_path: string;
            date_added: number;
            date_modified: number | null;
            position: number;
            source_id: string | null;
            import_key: string | null;
            tags: string | null;
            keyword: string | null;
        }, {
            id: number;
            title: string;
            url: string | null;
            folder_path: string;
            date_added: number;
            date_modified: number | null;
            position: number;
            source_id: string | null;
            import_key: string | null;
            tags: string | null;
            keyword: string | null;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addBookmark: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            title: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
            folderPath: z.ZodOptional<z.ZodString>;
            dateAdded: z.ZodOptional<z.ZodNumber>;
            tags: z.ZodOptional<z.ZodString>;
            keyword: z.ZodOptional<z.ZodString>;
            position: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            title: string;
            url?: string | undefined;
            folderPath?: string | undefined;
            dateAdded?: number | undefined;
            tags?: string | undefined;
            keyword?: string | undefined;
            position?: number | undefined;
        }, {
            title: string;
            url?: string | undefined;
            folderPath?: string | undefined;
            dateAdded?: number | undefined;
            tags?: string | undefined;
            keyword?: string | undefined;
            position?: number | undefined;
        }>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly updateBookmark: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodObject<{
            title: z.ZodOptional<z.ZodString>;
            url: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            folderPath: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            dateAdded: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
            tags: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            keyword: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            position: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        }, "strict", z.ZodTypeAny, {
            title?: string | undefined;
            url?: string | undefined;
            folderPath?: string | undefined;
            dateAdded?: number | undefined;
            tags?: string | undefined;
            keyword?: string | undefined;
            position?: number | undefined;
        }, {
            title?: string | undefined;
            url?: string | undefined;
            folderPath?: string | undefined;
            dateAdded?: number | undefined;
            tags?: string | undefined;
            keyword?: string | undefined;
            position?: number | undefined;
        }>], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly deleteBookmark: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly moveBookmark: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodString, z.ZodNumber], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly searchBookmarks: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            title: z.ZodString;
            url: z.ZodNullable<z.ZodString>;
            folder_path: z.ZodString;
            date_added: z.ZodNumber;
            date_modified: z.ZodNullable<z.ZodNumber>;
            position: z.ZodNumber;
            source_id: z.ZodNullable<z.ZodString>;
            import_key: z.ZodNullable<z.ZodString>;
            tags: z.ZodNullable<z.ZodString>;
            keyword: z.ZodNullable<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            id: number;
            title: string;
            url: string | null;
            folder_path: string;
            date_added: number;
            date_modified: number | null;
            position: number;
            source_id: string | null;
            import_key: string | null;
            tags: string | null;
            keyword: string | null;
        }, {
            id: number;
            title: string;
            url: string | null;
            folder_path: string;
            date_added: number;
            date_modified: number | null;
            position: number;
            source_id: string | null;
            import_key: string | null;
            tags: string | null;
            keyword: string | null;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getHistory: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            search: z.ZodOptional<z.ZodString>;
            startTime: z.ZodOptional<z.ZodNumber>;
            endTime: z.ZodOptional<z.ZodNumber>;
            limit: z.ZodOptional<z.ZodNumber>;
            offset: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            search?: string | undefined;
            startTime?: number | undefined;
            endTime?: number | undefined;
            limit?: number | undefined;
            offset?: number | undefined;
        }, {
            search?: string | undefined;
            startTime?: number | undefined;
            endTime?: number | undefined;
            limit?: number | undefined;
            offset?: number | undefined;
        }>], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            url: z.ZodString;
            title: z.ZodNullable<z.ZodString>;
            visit_count: z.ZodNumber;
            typed_count: z.ZodNumber;
            first_visit: z.ZodNullable<z.ZodNumber>;
            last_visit: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            id: number;
            url: string;
            title: string | null;
            visit_count: number;
            typed_count: number;
            first_visit: number | null;
            last_visit: number;
        }, {
            id: number;
            url: string;
            title: string | null;
            visit_count: number;
            typed_count: number;
            first_visit: number | null;
            last_visit: number;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly searchHistory: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString, z.ZodOptional<z.ZodNumber>], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            url: z.ZodString;
            title: z.ZodNullable<z.ZodString>;
            visit_count: z.ZodNumber;
            typed_count: z.ZodNumber;
            first_visit: z.ZodNullable<z.ZodNumber>;
            last_visit: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            id: number;
            url: string;
            title: string | null;
            visit_count: number;
            typed_count: number;
            first_visit: number | null;
            last_visit: number;
        }, {
            id: number;
            url: string;
            title: string | null;
            visit_count: number;
            typed_count: number;
            first_visit: number | null;
            last_visit: number;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly searchHistoryForAutocomplete: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            query: z.ZodString;
            limit: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            query: string;
            limit?: number | undefined;
        }, {
            query: string;
            limit?: number | undefined;
        }>], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            url: z.ZodString;
            title: z.ZodNullable<z.ZodString>;
            visit_count: z.ZodNumber;
            typed_count: z.ZodNumber;
            first_visit: z.ZodNullable<z.ZodNumber>;
            last_visit: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            id: number;
            url: string;
            title: string | null;
            visit_count: number;
            typed_count: number;
            first_visit: number | null;
            last_visit: number;
        }, {
            id: number;
            url: string;
            title: string | null;
            visit_count: number;
            typed_count: number;
            first_visit: number | null;
            last_visit: number;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly recordHistoryVisit: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            url: z.ZodString;
            title: z.ZodOptional<z.ZodString>;
            transition: z.ZodOptional<z.ZodString>;
            visitTime: z.ZodOptional<z.ZodNumber>;
            typed: z.ZodOptional<z.ZodBoolean>;
            source: z.ZodOptional<z.ZodEnum<["vibestudio", "import"]>>;
            panelId: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            url: string;
            title?: string | undefined;
            transition?: string | undefined;
            visitTime?: number | undefined;
            typed?: boolean | undefined;
            source?: "import" | "vibestudio" | undefined;
            panelId?: string | undefined;
        }, {
            url: string;
            title?: string | undefined;
            transition?: string | undefined;
            visitTime?: number | undefined;
            typed?: boolean | undefined;
            source?: "import" | "vibestudio" | undefined;
            panelId?: string | undefined;
        }>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly updateHistoryTitle: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            url: z.ZodString;
            title: z.ZodString;
            observedAt: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            url: string;
            title: string;
            observedAt?: number | undefined;
        }, {
            url: string;
            title: string;
            observedAt?: number | undefined;
        }>], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly deleteHistoryEntry: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly deleteHistoryRange: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly clearAllHistory: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listPasswordSummaries: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodArray<z.ZodObject<Omit<{
            id: z.ZodNumber;
            origin_url: z.ZodString;
            username: z.ZodString;
            password: z.ZodString;
            action_url: z.ZodString;
            realm: z.ZodString;
            date_created: z.ZodNullable<z.ZodNumber>;
            date_last_used: z.ZodNullable<z.ZodNumber>;
            date_password_changed: z.ZodNullable<z.ZodNumber>;
            times_used: z.ZodNumber;
        }, "password">, "strict", z.ZodTypeAny, {
            id: number;
            origin_url: string;
            username: string;
            action_url: string;
            realm: string;
            date_created: number | null;
            date_last_used: number | null;
            date_password_changed: number | null;
            times_used: number;
        }, {
            id: number;
            origin_url: string;
            username: string;
            action_url: string;
            realm: string;
            date_created: number | null;
            date_last_used: number | null;
            date_password_changed: number | null;
            times_used: number;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listPasswordSummariesPage: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
        returns: z.ZodObject<{
            items: z.ZodArray<z.ZodObject<Omit<{
                id: z.ZodNumber;
                origin_url: z.ZodString;
                username: z.ZodString;
                password: z.ZodString;
                action_url: z.ZodString;
                realm: z.ZodString;
                date_created: z.ZodNullable<z.ZodNumber>;
                date_last_used: z.ZodNullable<z.ZodNumber>;
                date_password_changed: z.ZodNullable<z.ZodNumber>;
                times_used: z.ZodNumber;
            }, "password">, "strict", z.ZodTypeAny, {
                id: number;
                origin_url: string;
                username: string;
                action_url: string;
                realm: string;
                date_created: number | null;
                date_last_used: number | null;
                date_password_changed: number | null;
                times_used: number;
            }, {
                id: number;
                origin_url: string;
                username: string;
                action_url: string;
                realm: string;
                date_created: number | null;
                date_last_used: number | null;
                date_password_changed: number | null;
                times_used: number;
            }>, "many">;
            total: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            items: {
                id: number;
                origin_url: string;
                username: string;
                action_url: string;
                realm: string;
                date_created: number | null;
                date_last_used: number | null;
                date_password_changed: number | null;
                times_used: number;
            }[];
            total: number;
        }, {
            items: {
                id: number;
                origin_url: string;
                username: string;
                action_url: string;
                realm: string;
                date_created: number | null;
                date_last_used: number | null;
                date_password_changed: number | null;
                times_used: number;
            }[];
            total: number;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getPasswordForSite: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            origin_url: z.ZodString;
            username: z.ZodString;
            password: z.ZodString;
            action_url: z.ZodString;
            realm: z.ZodString;
            date_created: z.ZodNullable<z.ZodNumber>;
            date_last_used: z.ZodNullable<z.ZodNumber>;
            date_password_changed: z.ZodNullable<z.ZodNumber>;
            times_used: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            id: number;
            origin_url: string;
            username: string;
            password: string;
            action_url: string;
            realm: string;
            date_created: number | null;
            date_last_used: number | null;
            date_password_changed: number | null;
            times_used: number;
        }, {
            id: number;
            origin_url: string;
            username: string;
            password: string;
            action_url: string;
            realm: string;
            date_created: number | null;
            date_last_used: number | null;
            date_password_changed: number | null;
            times_used: number;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listPasswordsPage: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
        returns: z.ZodObject<{
            items: z.ZodArray<z.ZodObject<{
                id: z.ZodNumber;
                origin_url: z.ZodString;
                username: z.ZodString;
                password: z.ZodString;
                action_url: z.ZodString;
                realm: z.ZodString;
                date_created: z.ZodNullable<z.ZodNumber>;
                date_last_used: z.ZodNullable<z.ZodNumber>;
                date_password_changed: z.ZodNullable<z.ZodNumber>;
                times_used: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                id: number;
                origin_url: string;
                username: string;
                password: string;
                action_url: string;
                realm: string;
                date_created: number | null;
                date_last_used: number | null;
                date_password_changed: number | null;
                times_used: number;
            }, {
                id: number;
                origin_url: string;
                username: string;
                password: string;
                action_url: string;
                realm: string;
                date_created: number | null;
                date_last_used: number | null;
                date_password_changed: number | null;
                times_used: number;
            }>, "many">;
            total: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            items: {
                id: number;
                origin_url: string;
                username: string;
                password: string;
                action_url: string;
                realm: string;
                date_created: number | null;
                date_last_used: number | null;
                date_password_changed: number | null;
                times_used: number;
            }[];
            total: number;
        }, {
            items: {
                id: number;
                origin_url: string;
                username: string;
                password: string;
                action_url: string;
                realm: string;
                date_created: number | null;
                date_last_used: number | null;
                date_password_changed: number | null;
                times_used: number;
            }[];
            total: number;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addPassword: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            url: z.ZodString;
            actionUrl: z.ZodOptional<z.ZodString>;
            username: z.ZodString;
            password: z.ZodString;
            realm: z.ZodOptional<z.ZodString>;
            dateCreated: z.ZodOptional<z.ZodNumber>;
            dateLastUsed: z.ZodOptional<z.ZodNumber>;
            datePasswordChanged: z.ZodOptional<z.ZodNumber>;
            timesUsed: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            url: string;
            actionUrl?: string | undefined;
            username: string;
            password: string;
            realm?: string | undefined;
            dateCreated?: number | undefined;
            dateLastUsed?: number | undefined;
            datePasswordChanged?: number | undefined;
            timesUsed?: number | undefined;
        }, {
            url: string;
            actionUrl?: string | undefined;
            username: string;
            password: string;
            realm?: string | undefined;
            dateCreated?: number | undefined;
            dateLastUsed?: number | undefined;
            datePasswordChanged?: number | undefined;
            timesUsed?: number | undefined;
        }>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly updatePassword: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodObject<{
            url: z.ZodOptional<z.ZodString>;
            actionUrl: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            username: z.ZodOptional<z.ZodString>;
            password: z.ZodOptional<z.ZodString>;
            realm: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            dateCreated: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
            dateLastUsed: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
            datePasswordChanged: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
            timesUsed: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        }, "strict", z.ZodTypeAny, {
            url?: string | undefined;
            actionUrl?: string | undefined;
            username?: string | undefined;
            password?: string | undefined;
            realm?: string | undefined;
            dateCreated?: number | undefined;
            dateLastUsed?: number | undefined;
            datePasswordChanged?: number | undefined;
            timesUsed?: number | undefined;
        }, {
            url?: string | undefined;
            actionUrl?: string | undefined;
            username?: string | undefined;
            password?: string | undefined;
            realm?: string | undefined;
            dateCreated?: number | undefined;
            dateLastUsed?: number | undefined;
            datePasswordChanged?: number | undefined;
            timesUsed?: number | undefined;
        }>], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly deletePassword: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addNeverSave: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly isNeverSave: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodBoolean;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getNeverSaveOrigins: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodArray<z.ZodString, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getNeverSaveOriginsPage: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
        returns: z.ZodObject<{
            items: z.ZodArray<z.ZodString, "many">;
            total: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            items: string[];
            total: number;
        }, {
            items: string[];
            total: number;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly removeNeverSave: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly updateLastUsed: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getFormFillSuggestions: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            fieldName: z.ZodOptional<z.ZodString>;
            type: z.ZodOptional<z.ZodEnum<["name", "given-name", "additional-name", "family-name", "honorific-prefix", "honorific-suffix", "nickname", "username", "new-password", "current-password", "one-time-code", "organization-title", "email", "tel", "tel-country-code", "tel-national", "tel-area-code", "tel-local", "tel-local-prefix", "tel-local-suffix", "tel-extension", "impp", "organization", "street-address", "address-line1", "address-line2", "address-line3", "address-level1", "address-level2", "address-level3", "address-level4", "postal-code", "country", "country-name", "cc-name", "cc-given-name", "cc-additional-name", "cc-family-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-type", "transaction-currency", "transaction-amount", "language", "bday", "bday-day", "bday-month", "bday-year", "sex", "url", "photo"]>>;
            prefix: z.ZodOptional<z.ZodString>;
            limit: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            fieldName?: string | undefined;
            type?: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | undefined;
            prefix?: string | undefined;
            limit?: number | undefined;
        }, {
            fieldName?: string | undefined;
            type?: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | undefined;
            prefix?: string | undefined;
            limit?: number | undefined;
        }>], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            fieldName: z.ZodString;
            type: z.ZodNullable<z.ZodEnum<["name", "given-name", "additional-name", "family-name", "honorific-prefix", "honorific-suffix", "nickname", "username", "new-password", "current-password", "one-time-code", "organization-title", "email", "tel", "tel-country-code", "tel-national", "tel-area-code", "tel-local", "tel-local-prefix", "tel-local-suffix", "tel-extension", "impp", "organization", "street-address", "address-line1", "address-line2", "address-line3", "address-level1", "address-level2", "address-level3", "address-level4", "postal-code", "country", "country-name", "cc-name", "cc-given-name", "cc-additional-name", "cc-family-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-type", "transaction-currency", "transaction-amount", "language", "bday", "bday-day", "bday-month", "bday-year", "sex", "url", "photo"]>>;
            value: z.ZodString;
            displayLabel: z.ZodNullable<z.ZodString>;
            aliases: z.ZodArray<z.ZodString, "many">;
            createdAt: z.ZodNumber;
            updatedAt: z.ZodNumber;
            useCount: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            id: number;
            fieldName: string;
            type: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | null;
            value: string;
            displayLabel: string | null;
            aliases: string[];
            createdAt: number;
            updatedAt: number;
            useCount: number;
        }, {
            id: number;
            fieldName: string;
            type: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | null;
            value: string;
            displayLabel: string | null;
            aliases: string[];
            createdAt: number;
            updatedAt: number;
            useCount: number;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listFormFillValues: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            fieldName: z.ZodString;
            type: z.ZodNullable<z.ZodEnum<["name", "given-name", "additional-name", "family-name", "honorific-prefix", "honorific-suffix", "nickname", "username", "new-password", "current-password", "one-time-code", "organization-title", "email", "tel", "tel-country-code", "tel-national", "tel-area-code", "tel-local", "tel-local-prefix", "tel-local-suffix", "tel-extension", "impp", "organization", "street-address", "address-line1", "address-line2", "address-line3", "address-level1", "address-level2", "address-level3", "address-level4", "postal-code", "country", "country-name", "cc-name", "cc-given-name", "cc-additional-name", "cc-family-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-type", "transaction-currency", "transaction-amount", "language", "bday", "bday-day", "bday-month", "bday-year", "sex", "url", "photo"]>>;
            value: z.ZodString;
            displayLabel: z.ZodNullable<z.ZodString>;
            aliases: z.ZodArray<z.ZodString, "many">;
            createdAt: z.ZodNumber;
            updatedAt: z.ZodNumber;
            useCount: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            id: number;
            fieldName: string;
            type: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | null;
            value: string;
            displayLabel: string | null;
            aliases: string[];
            createdAt: number;
            updatedAt: number;
            useCount: number;
        }, {
            id: number;
            fieldName: string;
            type: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | null;
            value: string;
            displayLabel: string | null;
            aliases: string[];
            createdAt: number;
            updatedAt: number;
            useCount: number;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listFormFillValuesPage: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
        returns: z.ZodObject<{
            items: z.ZodArray<z.ZodObject<{
                id: z.ZodNumber;
                fieldName: z.ZodString;
                type: z.ZodNullable<z.ZodEnum<["name", "given-name", "additional-name", "family-name", "honorific-prefix", "honorific-suffix", "nickname", "username", "new-password", "current-password", "one-time-code", "organization-title", "email", "tel", "tel-country-code", "tel-national", "tel-area-code", "tel-local", "tel-local-prefix", "tel-local-suffix", "tel-extension", "impp", "organization", "street-address", "address-line1", "address-line2", "address-line3", "address-level1", "address-level2", "address-level3", "address-level4", "postal-code", "country", "country-name", "cc-name", "cc-given-name", "cc-additional-name", "cc-family-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-type", "transaction-currency", "transaction-amount", "language", "bday", "bday-day", "bday-month", "bday-year", "sex", "url", "photo"]>>;
                value: z.ZodString;
                displayLabel: z.ZodNullable<z.ZodString>;
                aliases: z.ZodArray<z.ZodString, "many">;
                createdAt: z.ZodNumber;
                updatedAt: z.ZodNumber;
                useCount: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                id: number;
                fieldName: string;
                type: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | null;
                value: string;
                displayLabel: string | null;
                aliases: string[];
                createdAt: number;
                updatedAt: number;
                useCount: number;
            }, {
                id: number;
                fieldName: string;
                type: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | null;
                value: string;
                displayLabel: string | null;
                aliases: string[];
                createdAt: number;
                updatedAt: number;
                useCount: number;
            }>, "many">;
            total: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            items: {
                id: number;
                fieldName: string;
                type: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | null;
                value: string;
                displayLabel: string | null;
                aliases: string[];
                createdAt: number;
                updatedAt: number;
                useCount: number;
            }[];
            total: number;
        }, {
            items: {
                id: number;
                fieldName: string;
                type: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | null;
                value: string;
                displayLabel: string | null;
                aliases: string[];
                createdAt: number;
                updatedAt: number;
                useCount: number;
            }[];
            total: number;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addFormFillValue: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            fieldName: z.ZodString;
            type: z.ZodOptional<z.ZodEnum<["name", "given-name", "additional-name", "family-name", "honorific-prefix", "honorific-suffix", "nickname", "username", "new-password", "current-password", "one-time-code", "organization-title", "email", "tel", "tel-country-code", "tel-national", "tel-area-code", "tel-local", "tel-local-prefix", "tel-local-suffix", "tel-extension", "impp", "organization", "street-address", "address-line1", "address-line2", "address-line3", "address-level1", "address-level2", "address-level3", "address-level4", "postal-code", "country", "country-name", "cc-name", "cc-given-name", "cc-additional-name", "cc-family-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-type", "transaction-currency", "transaction-amount", "language", "bday", "bday-day", "bday-month", "bday-year", "sex", "url", "photo"]>>;
            value: z.ZodString;
            displayLabel: z.ZodOptional<z.ZodString>;
            aliases: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            createdAt: z.ZodOptional<z.ZodNumber>;
            updatedAt: z.ZodOptional<z.ZodNumber>;
            useCount: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            fieldName: string;
            type?: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | undefined;
            value: string;
            displayLabel?: string | undefined;
            aliases?: string[] | undefined;
            createdAt?: number | undefined;
            updatedAt?: number | undefined;
            useCount?: number | undefined;
        }, {
            fieldName: string;
            type?: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | undefined;
            value: string;
            displayLabel?: string | undefined;
            aliases?: string[] | undefined;
            createdAt?: number | undefined;
            updatedAt?: number | undefined;
            useCount?: number | undefined;
        }>, z.ZodOptional<z.ZodString>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly updateFormFillValue: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodObject<{
            value: z.ZodOptional<z.ZodString>;
            displayLabel: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            aliases: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
        }, "strict", z.ZodTypeAny, {
            value?: string | undefined;
            displayLabel?: string | undefined;
            aliases?: string[] | undefined;
        }, {
            value?: string | undefined;
            displayLabel?: string | undefined;
            aliases?: string[] | undefined;
        }>], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly markFormFillValueUsed: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly deleteFormFillValue: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly clearFormFillValues: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly applyCookieMutations: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            mutations: z.ZodArray<z.ZodDiscriminatedUnion<"op", [z.ZodObject<{
                op: z.ZodLiteral<"put">;
                cookie: z.ZodObject<{
                    name: z.ZodString;
                    domain: z.ZodString;
                    path: z.ZodString;
                    partitionKey: z.ZodOptional<z.ZodObject<{
                        topLevelSite: z.ZodString;
                        hasCrossSiteAncestor: z.ZodBoolean;
                    }, "strict", z.ZodTypeAny, {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    }, {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    }>>;
                } & {
                    value: z.ZodString;
                    hostOnly: z.ZodBoolean;
                    secure: z.ZodBoolean;
                    httpOnly: z.ZodBoolean;
                    sameSite: z.ZodEnum<["unspecified", "no_restriction", "lax", "strict"]>;
                    expirationDate: z.ZodOptional<z.ZodNumber>;
                    sourceScheme: z.ZodOptional<z.ZodString>;
                    sourcePort: z.ZodOptional<z.ZodNumber>;
                    createdAt: z.ZodOptional<z.ZodNumber>;
                    lastAccessed: z.ZodOptional<z.ZodNumber>;
                }, "strict", z.ZodTypeAny, {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                    value: string;
                    hostOnly: boolean;
                    secure: boolean;
                    httpOnly: boolean;
                    sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                    expirationDate?: number | undefined;
                    sourceScheme?: string | undefined;
                    sourcePort?: number | undefined;
                    createdAt?: number | undefined;
                    lastAccessed?: number | undefined;
                }, {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                    value: string;
                    hostOnly: boolean;
                    secure: boolean;
                    httpOnly: boolean;
                    sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                    expirationDate?: number | undefined;
                    sourceScheme?: string | undefined;
                    sourcePort?: number | undefined;
                    createdAt?: number | undefined;
                    lastAccessed?: number | undefined;
                }>;
                mutationId: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                op: "put";
                cookie: {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                    value: string;
                    hostOnly: boolean;
                    secure: boolean;
                    httpOnly: boolean;
                    sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                    expirationDate?: number | undefined;
                    sourceScheme?: string | undefined;
                    sourcePort?: number | undefined;
                    createdAt?: number | undefined;
                    lastAccessed?: number | undefined;
                };
                mutationId: string;
            }, {
                op: "put";
                cookie: {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                    value: string;
                    hostOnly: boolean;
                    secure: boolean;
                    httpOnly: boolean;
                    sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                    expirationDate?: number | undefined;
                    sourceScheme?: string | undefined;
                    sourcePort?: number | undefined;
                    createdAt?: number | undefined;
                    lastAccessed?: number | undefined;
                };
                mutationId: string;
            }>, z.ZodObject<{
                op: z.ZodLiteral<"delete">;
                key: z.ZodObject<{
                    name: z.ZodString;
                    domain: z.ZodString;
                    path: z.ZodString;
                    partitionKey: z.ZodOptional<z.ZodObject<{
                        topLevelSite: z.ZodString;
                        hasCrossSiteAncestor: z.ZodBoolean;
                    }, "strict", z.ZodTypeAny, {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    }, {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    }>>;
                }, "strict", z.ZodTypeAny, {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                }, {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                }>;
                mutationId: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                op: "delete";
                key: {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                };
                mutationId: string;
            }, {
                op: "delete";
                key: {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                };
                mutationId: string;
            }>]>, "many">;
        }, "strict", z.ZodTypeAny, {
            mutations: ({
                op: "put";
                cookie: {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                    value: string;
                    hostOnly: boolean;
                    secure: boolean;
                    httpOnly: boolean;
                    sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                    expirationDate?: number | undefined;
                    sourceScheme?: string | undefined;
                    sourcePort?: number | undefined;
                    createdAt?: number | undefined;
                    lastAccessed?: number | undefined;
                };
                mutationId: string;
            } | {
                op: "delete";
                key: {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                };
                mutationId: string;
            })[];
        }, {
            mutations: ({
                op: "put";
                cookie: {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                    value: string;
                    hostOnly: boolean;
                    secure: boolean;
                    httpOnly: boolean;
                    sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                    expirationDate?: number | undefined;
                    sourceScheme?: string | undefined;
                    sourcePort?: number | undefined;
                    createdAt?: number | undefined;
                    lastAccessed?: number | undefined;
                };
                mutationId: string;
            } | {
                op: "delete";
                key: {
                    name: string;
                    domain: string;
                    path: string;
                    partitionKey?: {
                        topLevelSite: string;
                        hasCrossSiteAncestor: boolean;
                    } | undefined;
                };
                mutationId: string;
            })[];
        }>], null>;
        returns: z.ZodObject<{
            revision: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            revision: number;
        }, {
            revision: number;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listCookieOrigins: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodObject<{
            revision: z.ZodNumber;
            origins: z.ZodArray<z.ZodString, "many">;
        }, "strict", z.ZodTypeAny, {
            revision: number;
            origins: string[];
        }, {
            revision: number;
            origins: string[];
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listCookieOriginsPage: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
        returns: z.ZodObject<{
            items: z.ZodArray<z.ZodString, "many">;
            total: z.ZodNumber;
            revision: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            items: string[];
            total: number;
            revision: number;
        }, {
            items: string[];
            total: number;
            revision: number;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getCookiesForOrigin: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            domain: z.ZodString;
            path: z.ZodString;
            partitionKey: z.ZodOptional<z.ZodObject<{
                topLevelSite: z.ZodString;
                hasCrossSiteAncestor: z.ZodBoolean;
            }, "strict", z.ZodTypeAny, {
                topLevelSite: string;
                hasCrossSiteAncestor: boolean;
            }, {
                topLevelSite: string;
                hasCrossSiteAncestor: boolean;
            }>>;
            value: z.ZodString;
            hostOnly: z.ZodBoolean;
            secure: z.ZodBoolean;
            httpOnly: z.ZodBoolean;
            sameSite: z.ZodEnum<["unspecified", "no_restriction", "lax", "strict"]>;
            expirationDate: z.ZodOptional<z.ZodNumber>;
            sourceScheme: z.ZodOptional<z.ZodString>;
            sourcePort: z.ZodOptional<z.ZodNumber>;
            lastAccessed: z.ZodOptional<z.ZodNumber>;
        } & {
            encryptedValue: z.ZodString;
            contentHash: z.ZodString;
            createdAt: z.ZodNumber;
            revision: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            name: string;
            domain: string;
            path: string;
            partitionKey?: {
                topLevelSite: string;
                hasCrossSiteAncestor: boolean;
            } | undefined;
            value: string;
            hostOnly: boolean;
            secure: boolean;
            httpOnly: boolean;
            sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
            expirationDate?: number | undefined;
            sourceScheme?: string | undefined;
            sourcePort?: number | undefined;
            lastAccessed?: number | undefined;
            encryptedValue: string;
            contentHash: string;
            createdAt: number;
            revision: number;
        }, {
            name: string;
            domain: string;
            path: string;
            partitionKey?: {
                topLevelSite: string;
                hasCrossSiteAncestor: boolean;
            } | undefined;
            value: string;
            hostOnly: boolean;
            secure: boolean;
            httpOnly: boolean;
            sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
            expirationDate?: number | undefined;
            sourceScheme?: string | undefined;
            sourcePort?: number | undefined;
            lastAccessed?: number | undefined;
            encryptedValue: string;
            contentHash: string;
            createdAt: number;
            revision: number;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listCookiesPage: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>;
        returns: z.ZodObject<{
            items: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                domain: z.ZodString;
                path: z.ZodString;
                partitionKey: z.ZodOptional<z.ZodObject<{
                    topLevelSite: z.ZodString;
                    hasCrossSiteAncestor: z.ZodBoolean;
                }, "strict", z.ZodTypeAny, {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                }, {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                }>>;
                value: z.ZodString;
                hostOnly: z.ZodBoolean;
                secure: z.ZodBoolean;
                httpOnly: z.ZodBoolean;
                sameSite: z.ZodEnum<["unspecified", "no_restriction", "lax", "strict"]>;
                expirationDate: z.ZodOptional<z.ZodNumber>;
                sourceScheme: z.ZodOptional<z.ZodString>;
                sourcePort: z.ZodOptional<z.ZodNumber>;
                lastAccessed: z.ZodOptional<z.ZodNumber>;
            } & {
                encryptedValue: z.ZodString;
                contentHash: z.ZodString;
                createdAt: z.ZodNumber;
                revision: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                name: string;
                domain: string;
                path: string;
                partitionKey?: {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                } | undefined;
                value: string;
                hostOnly: boolean;
                secure: boolean;
                httpOnly: boolean;
                sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                expirationDate?: number | undefined;
                sourceScheme?: string | undefined;
                sourcePort?: number | undefined;
                lastAccessed?: number | undefined;
                encryptedValue: string;
                contentHash: string;
                createdAt: number;
                revision: number;
            }, {
                name: string;
                domain: string;
                path: string;
                partitionKey?: {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                } | undefined;
                value: string;
                hostOnly: boolean;
                secure: boolean;
                httpOnly: boolean;
                sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                expirationDate?: number | undefined;
                sourceScheme?: string | undefined;
                sourcePort?: number | undefined;
                lastAccessed?: number | undefined;
                encryptedValue: string;
                contentHash: string;
                createdAt: number;
                revision: number;
            }>, "many">;
            total: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            items: {
                name: string;
                domain: string;
                path: string;
                partitionKey?: {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                } | undefined;
                value: string;
                hostOnly: boolean;
                secure: boolean;
                httpOnly: boolean;
                sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                expirationDate?: number | undefined;
                sourceScheme?: string | undefined;
                sourcePort?: number | undefined;
                lastAccessed?: number | undefined;
                encryptedValue: string;
                contentHash: string;
                createdAt: number;
                revision: number;
            }[];
            total: number;
        }, {
            items: {
                name: string;
                domain: string;
                path: string;
                partitionKey?: {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                } | undefined;
                value: string;
                hostOnly: boolean;
                secure: boolean;
                httpOnly: boolean;
                sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                expirationDate?: number | undefined;
                sourceScheme?: string | undefined;
                sourcePort?: number | undefined;
                lastAccessed?: number | undefined;
                encryptedValue: string;
                contentHash: string;
                createdAt: number;
                revision: number;
            }[];
            total: number;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly clearCookiesForOrigin: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly clearAllCookies: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly endBrowserSession: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getCookieSiteSummary: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodObject<{
            origin: z.ZodString;
            cookieCount: z.ZodNumber;
            revision: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            origin: string;
            cookieCount: number;
            revision: number;
        }, {
            origin: string;
            cookieCount: number;
            revision: number;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getSearchEngines: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            name: z.ZodString;
            keyword: z.ZodNullable<z.ZodString>;
            search_url: z.ZodString;
            suggest_url: z.ZodNullable<z.ZodString>;
            favicon_url: z.ZodNullable<z.ZodString>;
            is_default: z.ZodNumber;
            source_id: z.ZodNullable<z.ZodString>;
            import_key: z.ZodNullable<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            id: number;
            name: string;
            keyword: string | null;
            search_url: string;
            suggest_url: string | null;
            favicon_url: string | null;
            is_default: number;
            source_id: string | null;
            import_key: string | null;
        }, {
            id: number;
            name: string;
            keyword: string | null;
            search_url: string;
            suggest_url: string | null;
            favicon_url: string | null;
            is_default: number;
            source_id: string | null;
            import_key: string | null;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly setDefaultEngine: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodNumber], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly saveSearchEngine: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<Omit<{
            name: z.ZodString;
            keyword: z.ZodOptional<z.ZodString>;
            searchUrl: z.ZodString;
            suggestUrl: z.ZodOptional<z.ZodString>;
            faviconUrl: z.ZodOptional<z.ZodString>;
            isDefault: z.ZodBoolean;
            sourceId: z.ZodOptional<z.ZodString>;
        }, "faviconUrl" | "sourceId"> & {
            id: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            name: string;
            keyword?: string | undefined;
            searchUrl: string;
            suggestUrl?: string | undefined;
            isDefault: boolean;
            id?: number | undefined;
        }, {
            name: string;
            keyword?: string | undefined;
            searchUrl: string;
            suggestUrl?: string | undefined;
            isDefault: boolean;
            id?: number | undefined;
        }>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getSearchSuggestions: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodArray<z.ZodObject<{
            url: z.ZodString;
            title: z.ZodString;
            source: z.ZodLiteral<"search-suggestion">;
            completionQuery: z.ZodString;
            engineId: z.ZodNumber;
            engineName: z.ZodString;
            searchTemplate: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            url: string;
            title: string;
            source: "search-suggestion";
            completionQuery: string;
            engineId: number;
            engineName: string;
            searchTemplate: string;
        }, {
            url: string;
            title: string;
            source: "search-suggestion";
            completionQuery: string;
            engineId: number;
            engineName: string;
            searchTemplate: string;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly putPageFavicon: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            pageUrl: z.ZodString;
            origin: z.ZodString;
            sourceUrl: z.ZodOptional<z.ZodString>;
            data: z.ZodString;
            mimeType: z.ZodEnum<["image/png", "image/jpeg", "image/gif", "image/webp", "image/x-icon", "image/svg+xml", "image/bmp", "image/avif"]>;
            updatedAt: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            pageUrl: string;
            origin: string;
            sourceUrl?: string | undefined;
            data: string;
            mimeType: "image/avif" | "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/svg+xml" | "image/webp" | "image/x-icon";
            updatedAt: number;
        }, {
            pageUrl: string;
            origin: string;
            sourceUrl?: string | undefined;
            data: string;
            mimeType: "image/avif" | "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/svg+xml" | "image/webp" | "image/x-icon";
            updatedAt: number;
        }>], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getPageFavicon: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodNullable<z.ZodObject<{
            page_url: z.ZodString;
            origin: z.ZodString;
            source_url: z.ZodNullable<z.ZodString>;
            image_data: z.ZodString;
            mime_type: z.ZodEnum<["image/png", "image/jpeg", "image/gif", "image/webp", "image/x-icon", "image/svg+xml", "image/bmp", "image/avif"]>;
            updated_at: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            page_url: string;
            origin: string;
            source_url: string | null;
            image_data: string;
            mime_type: "image/avif" | "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/svg+xml" | "image/webp" | "image/x-icon";
            updated_at: number;
        }, {
            page_url: string;
            origin: string;
            source_url: string | null;
            image_data: string;
            mime_type: "image/avif" | "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/svg+xml" | "image/webp" | "image/x-icon";
            updated_at: number;
        }>>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly upsertImportJob: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            jobId: z.ZodString;
            hostId: z.ZodString;
            hostLabel: z.ZodString;
            sourceId: z.ZodString;
            browser: z.ZodString;
            phase: z.ZodEnum<["queued", "discovering", "copying", "reading", "decrypting", "normalizing", "storing", "reconciling", "complete", "cancelled", "failed", "partial"]>;
            startedAt: z.ZodNumber;
            updatedAt: z.ZodNumber;
            finishedAt: z.ZodOptional<z.ZodNumber>;
            dataTypes: z.ZodArray<z.ZodEnum<["bookmarks", "history", "cookies", "passwords", "formFill", "searchEngines", "favicons"]>, "many">;
            progress: z.ZodArray<z.ZodObject<{
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
            error: z.ZodOptional<z.ZodString>;
            resumable: z.ZodBoolean;
        }, "strict", z.ZodTypeAny, {
            jobId: string;
            hostId: string;
            hostLabel: string;
            sourceId: string;
            browser: string;
            phase: "cancelled" | "complete" | "copying" | "decrypting" | "discovering" | "failed" | "normalizing" | "partial" | "queued" | "reading" | "reconciling" | "storing";
            startedAt: number;
            updatedAt: number;
            finishedAt?: number | undefined;
            dataTypes: ("bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines")[];
            progress: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            warnings: string[];
            error?: string | undefined;
            resumable: boolean;
        }, {
            jobId: string;
            hostId: string;
            hostLabel: string;
            sourceId: string;
            browser: string;
            phase: "cancelled" | "complete" | "copying" | "decrypting" | "discovering" | "failed" | "normalizing" | "partial" | "queued" | "reading" | "reconciling" | "storing";
            startedAt: number;
            updatedAt: number;
            finishedAt?: number | undefined;
            dataTypes: ("bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines")[];
            progress: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            warnings: string[];
            error?: string | undefined;
            resumable: boolean;
        }>], null>;
        returns: z.ZodVoid;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly getImportJob: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodString], null>;
        returns: z.ZodNullable<z.ZodObject<{
            jobId: z.ZodString;
            hostId: z.ZodString;
            hostLabel: z.ZodOptional<z.ZodString>;
            sourceId: z.ZodString;
            browser: z.ZodOptional<z.ZodString>;
            phase: z.ZodEnum<["queued", "discovering", "copying", "reading", "decrypting", "normalizing", "storing", "reconciling", "complete", "cancelled", "failed", "partial"]>;
            requestedDataTypes: z.ZodArray<z.ZodEnum<["bookmarks", "history", "cookies", "passwords", "formFill", "searchEngines", "favicons"]>, "many">;
            startedAt: z.ZodNumber;
            updatedAt: z.ZodNumber;
            finishedAt: z.ZodOptional<z.ZodNumber>;
            progress: z.ZodArray<z.ZodObject<{
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
            error: z.ZodOptional<z.ZodString>;
            resumable: z.ZodBoolean;
        }, "strict", z.ZodTypeAny, {
            jobId: string;
            hostId: string;
            hostLabel?: string | undefined;
            sourceId: string;
            browser?: string | undefined;
            phase: "cancelled" | "complete" | "copying" | "decrypting" | "discovering" | "failed" | "normalizing" | "partial" | "queued" | "reading" | "reconciling" | "storing";
            requestedDataTypes: ("bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines")[];
            startedAt: number;
            updatedAt: number;
            finishedAt?: number | undefined;
            progress: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            warnings: string[];
            error?: string | undefined;
            resumable: boolean;
        }, {
            jobId: string;
            hostId: string;
            hostLabel?: string | undefined;
            sourceId: string;
            browser?: string | undefined;
            phase: "cancelled" | "complete" | "copying" | "decrypting" | "discovering" | "failed" | "normalizing" | "partial" | "queued" | "reading" | "reconciling" | "storing";
            requestedDataTypes: ("bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines")[];
            startedAt: number;
            updatedAt: number;
            finishedAt?: number | undefined;
            progress: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            warnings: string[];
            error?: string | undefined;
            resumable: boolean;
        }>>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly listImportJobs: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[], null>;
        returns: z.ZodArray<z.ZodObject<{
            jobId: z.ZodString;
            hostId: z.ZodString;
            hostLabel: z.ZodOptional<z.ZodString>;
            sourceId: z.ZodString;
            browser: z.ZodOptional<z.ZodString>;
            phase: z.ZodEnum<["queued", "discovering", "copying", "reading", "decrypting", "normalizing", "storing", "reconciling", "complete", "cancelled", "failed", "partial"]>;
            requestedDataTypes: z.ZodArray<z.ZodEnum<["bookmarks", "history", "cookies", "passwords", "formFill", "searchEngines", "favicons"]>, "many">;
            startedAt: z.ZodNumber;
            updatedAt: z.ZodNumber;
            finishedAt: z.ZodOptional<z.ZodNumber>;
            progress: z.ZodArray<z.ZodObject<{
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
            error: z.ZodOptional<z.ZodString>;
            resumable: z.ZodBoolean;
        }, "strict", z.ZodTypeAny, {
            jobId: string;
            hostId: string;
            hostLabel?: string | undefined;
            sourceId: string;
            browser?: string | undefined;
            phase: "cancelled" | "complete" | "copying" | "decrypting" | "discovering" | "failed" | "normalizing" | "partial" | "queued" | "reading" | "reconciling" | "storing";
            requestedDataTypes: ("bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines")[];
            startedAt: number;
            updatedAt: number;
            finishedAt?: number | undefined;
            progress: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            warnings: string[];
            error?: string | undefined;
            resumable: boolean;
        }, {
            jobId: string;
            hostId: string;
            hostLabel?: string | undefined;
            sourceId: string;
            browser?: string | undefined;
            phase: "cancelled" | "complete" | "copying" | "decrypting" | "discovering" | "failed" | "normalizing" | "partial" | "queued" | "reading" | "reconciling" | "storing";
            requestedDataTypes: ("bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines")[];
            startedAt: number;
            updatedAt: number;
            finishedAt?: number | undefined;
            progress: {
                dataType: "bookmarks" | "cookies" | "favicons" | "formFill" | "history" | "passwords" | "searchEngines";
                itemsProcessed: number;
                totalItems?: number | undefined;
                stored: number;
                skipped: number;
                errors: number;
            }[];
            warnings: string[];
            error?: string | undefined;
            resumable: boolean;
        }>, "many">;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly recordImportBatch: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            jobId: z.ZodString;
            dataType: z.ZodString;
            batchIndex: z.ZodNumber;
            idempotencyKey: z.ZodString;
            itemCount: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            jobId: string;
            dataType: string;
            batchIndex: number;
            idempotencyKey: string;
            itemCount: number;
        }, {
            jobId: string;
            dataType: string;
            batchIndex: number;
            idempotencyKey: string;
            itemCount: number;
        }>], null>;
        returns: z.ZodObject<{
            stored: z.ZodBoolean;
        }, "strict", z.ZodTypeAny, {
            stored: boolean;
        }, {
            stored: boolean;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addBookmarksBatch: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodArray<z.ZodObject<{
            title: z.ZodString;
            url: z.ZodString;
            dateAdded: z.ZodNumber;
            dateModified: z.ZodOptional<z.ZodNumber>;
            folder: z.ZodArray<z.ZodString, "many">;
            tags: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            keyword: z.ZodOptional<z.ZodString>;
            sourceId: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            title: string;
            url: string;
            dateAdded: number;
            dateModified?: number | undefined;
            folder: string[];
            tags?: string[] | undefined;
            keyword?: string | undefined;
            sourceId?: string | undefined;
        }, {
            title: string;
            url: string;
            dateAdded: number;
            dateModified?: number | undefined;
            folder: string[];
            tags?: string[] | undefined;
            keyword?: string | undefined;
            sourceId?: string | undefined;
        }>, "many">, z.ZodObject<{
            sourceId: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            sourceId: string;
        }, {
            sourceId: string;
        }>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addHistoryBatch: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodArray<z.ZodObject<{
            url: z.ZodString;
            title: z.ZodString;
            visitCount: z.ZodNumber;
            lastVisitTime: z.ZodNumber;
            firstVisitTime: z.ZodOptional<z.ZodNumber>;
            typedCount: z.ZodOptional<z.ZodNumber>;
            transition: z.ZodOptional<z.ZodString>;
            visits: z.ZodOptional<z.ZodArray<z.ZodObject<{
                visitTime: z.ZodNumber;
                transition: z.ZodOptional<z.ZodString>;
                typed: z.ZodOptional<z.ZodBoolean>;
            }, "strict", z.ZodTypeAny, {
                visitTime: number;
                transition?: string | undefined;
                typed?: boolean | undefined;
            }, {
                visitTime: number;
                transition?: string | undefined;
                typed?: boolean | undefined;
            }>, "many">>;
        }, "strict", z.ZodTypeAny, {
            url: string;
            title: string;
            visitCount: number;
            lastVisitTime: number;
            firstVisitTime?: number | undefined;
            typedCount?: number | undefined;
            transition?: string | undefined;
            visits?: {
                visitTime: number;
                transition?: string | undefined;
                typed?: boolean | undefined;
            }[] | undefined;
        }, {
            url: string;
            title: string;
            visitCount: number;
            lastVisitTime: number;
            firstVisitTime?: number | undefined;
            typedCount?: number | undefined;
            transition?: string | undefined;
            visits?: {
                visitTime: number;
                transition?: string | undefined;
                typed?: boolean | undefined;
            }[] | undefined;
        }>, "many">, z.ZodObject<{
            sourceId: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            sourceId: string;
        }, {
            sourceId: string;
        }>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addCookiesBatch: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodObject<{
            jobId: z.ZodString;
            batchIndex: z.ZodNumber;
            cookies: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                domain: z.ZodString;
                path: z.ZodString;
                partitionKey: z.ZodOptional<z.ZodObject<{
                    topLevelSite: z.ZodString;
                    hasCrossSiteAncestor: z.ZodBoolean;
                }, "strict", z.ZodTypeAny, {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                }, {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                }>>;
            } & {
                value: z.ZodString;
                hostOnly: z.ZodBoolean;
                secure: z.ZodBoolean;
                httpOnly: z.ZodBoolean;
                sameSite: z.ZodEnum<["unspecified", "no_restriction", "lax", "strict"]>;
                expirationDate: z.ZodOptional<z.ZodNumber>;
                sourceScheme: z.ZodOptional<z.ZodString>;
                sourcePort: z.ZodOptional<z.ZodNumber>;
                createdAt: z.ZodOptional<z.ZodNumber>;
                lastAccessed: z.ZodOptional<z.ZodNumber>;
            }, "strict", z.ZodTypeAny, {
                name: string;
                domain: string;
                path: string;
                partitionKey?: {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                } | undefined;
                value: string;
                hostOnly: boolean;
                secure: boolean;
                httpOnly: boolean;
                sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                expirationDate?: number | undefined;
                sourceScheme?: string | undefined;
                sourcePort?: number | undefined;
                createdAt?: number | undefined;
                lastAccessed?: number | undefined;
            }, {
                name: string;
                domain: string;
                path: string;
                partitionKey?: {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                } | undefined;
                value: string;
                hostOnly: boolean;
                secure: boolean;
                httpOnly: boolean;
                sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                expirationDate?: number | undefined;
                sourceScheme?: string | undefined;
                sourcePort?: number | undefined;
                createdAt?: number | undefined;
                lastAccessed?: number | undefined;
            }>, "many">;
        }, "strict", z.ZodTypeAny, {
            jobId: string;
            batchIndex: number;
            cookies: {
                name: string;
                domain: string;
                path: string;
                partitionKey?: {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                } | undefined;
                value: string;
                hostOnly: boolean;
                secure: boolean;
                httpOnly: boolean;
                sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                expirationDate?: number | undefined;
                sourceScheme?: string | undefined;
                sourcePort?: number | undefined;
                createdAt?: number | undefined;
                lastAccessed?: number | undefined;
            }[];
        }, {
            jobId: string;
            batchIndex: number;
            cookies: {
                name: string;
                domain: string;
                path: string;
                partitionKey?: {
                    topLevelSite: string;
                    hasCrossSiteAncestor: boolean;
                } | undefined;
                value: string;
                hostOnly: boolean;
                secure: boolean;
                httpOnly: boolean;
                sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
                expirationDate?: number | undefined;
                sourceScheme?: string | undefined;
                sourcePort?: number | undefined;
                createdAt?: number | undefined;
                lastAccessed?: number | undefined;
            }[];
        }>], null>;
        returns: z.ZodObject<{
            revision: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            revision: number;
        }, {
            revision: number;
        }>;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addPasswordsBatch: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodArray<z.ZodObject<{
            url: z.ZodString;
            actionUrl: z.ZodOptional<z.ZodString>;
            username: z.ZodString;
            password: z.ZodString;
            realm: z.ZodOptional<z.ZodString>;
            dateCreated: z.ZodOptional<z.ZodNumber>;
            dateLastUsed: z.ZodOptional<z.ZodNumber>;
            datePasswordChanged: z.ZodOptional<z.ZodNumber>;
            timesUsed: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            url: string;
            actionUrl?: string | undefined;
            username: string;
            password: string;
            realm?: string | undefined;
            dateCreated?: number | undefined;
            dateLastUsed?: number | undefined;
            datePasswordChanged?: number | undefined;
            timesUsed?: number | undefined;
        }, {
            url: string;
            actionUrl?: string | undefined;
            username: string;
            password: string;
            realm?: string | undefined;
            dateCreated?: number | undefined;
            dateLastUsed?: number | undefined;
            datePasswordChanged?: number | undefined;
            timesUsed?: number | undefined;
        }>, "many">, z.ZodObject<{
            sourceId: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            sourceId: string;
        }, {
            sourceId: string;
        }>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addFormFillBatch: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodArray<z.ZodObject<{
            fieldName: z.ZodString;
            type: z.ZodOptional<z.ZodEnum<["name", "given-name", "additional-name", "family-name", "honorific-prefix", "honorific-suffix", "nickname", "username", "new-password", "current-password", "one-time-code", "organization-title", "email", "tel", "tel-country-code", "tel-national", "tel-area-code", "tel-local", "tel-local-prefix", "tel-local-suffix", "tel-extension", "impp", "organization", "street-address", "address-line1", "address-line2", "address-line3", "address-level1", "address-level2", "address-level3", "address-level4", "postal-code", "country", "country-name", "cc-name", "cc-given-name", "cc-additional-name", "cc-family-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-type", "transaction-currency", "transaction-amount", "language", "bday", "bday-day", "bday-month", "bday-year", "sex", "url", "photo"]>>;
            value: z.ZodString;
            displayLabel: z.ZodOptional<z.ZodString>;
            aliases: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            createdAt: z.ZodOptional<z.ZodNumber>;
            updatedAt: z.ZodOptional<z.ZodNumber>;
            useCount: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            fieldName: string;
            type?: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | undefined;
            value: string;
            displayLabel?: string | undefined;
            aliases?: string[] | undefined;
            createdAt?: number | undefined;
            updatedAt?: number | undefined;
            useCount?: number | undefined;
        }, {
            fieldName: string;
            type?: "additional-name" | "address-level1" | "address-level2" | "address-level3" | "address-level4" | "address-line1" | "address-line2" | "address-line3" | "bday" | "bday-day" | "bday-month" | "bday-year" | "cc-additional-name" | "cc-csc" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-family-name" | "cc-given-name" | "cc-name" | "cc-number" | "cc-type" | "country" | "country-name" | "current-password" | "email" | "family-name" | "given-name" | "honorific-prefix" | "honorific-suffix" | "impp" | "language" | "name" | "new-password" | "nickname" | "one-time-code" | "organization" | "organization-title" | "photo" | "postal-code" | "sex" | "street-address" | "tel" | "tel-area-code" | "tel-country-code" | "tel-extension" | "tel-local" | "tel-local-prefix" | "tel-local-suffix" | "tel-national" | "transaction-amount" | "transaction-currency" | "url" | "username" | undefined;
            value: string;
            displayLabel?: string | undefined;
            aliases?: string[] | undefined;
            createdAt?: number | undefined;
            updatedAt?: number | undefined;
            useCount?: number | undefined;
        }>, "many">, z.ZodObject<{
            sourceId: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            sourceId: string;
        }, {
            sourceId: string;
        }>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addSearchEnginesBatch: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            keyword: z.ZodOptional<z.ZodString>;
            searchUrl: z.ZodString;
            suggestUrl: z.ZodOptional<z.ZodString>;
            faviconUrl: z.ZodOptional<z.ZodString>;
            isDefault: z.ZodBoolean;
            sourceId: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            name: string;
            keyword?: string | undefined;
            searchUrl: string;
            suggestUrl?: string | undefined;
            faviconUrl?: string | undefined;
            isDefault: boolean;
            sourceId?: string | undefined;
        }, {
            name: string;
            keyword?: string | undefined;
            searchUrl: string;
            suggestUrl?: string | undefined;
            faviconUrl?: string | undefined;
            isDefault: boolean;
            sourceId?: string | undefined;
        }>, "many">, z.ZodObject<{
            sourceId: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            sourceId: string;
        }, {
            sourceId: string;
        }>], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
    readonly addFaviconsBatch: {
        website: {
            readonly kind: "closed";
            readonly reason: "Browser profile data requires the browser privacy UI and cannot be exported to websites.";
        };
        description: string;
        args: z.ZodTuple<[z.ZodArray<z.ZodObject<{
            pageUrl: z.ZodString;
            origin: z.ZodString;
            sourceUrl: z.ZodOptional<z.ZodString>;
            data: z.ZodString;
            mimeType: z.ZodEnum<["image/png", "image/jpeg", "image/gif", "image/webp", "image/x-icon", "image/svg+xml", "image/bmp", "image/avif"]>;
            updatedAt: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            pageUrl: string;
            origin: string;
            sourceUrl?: string | undefined;
            data: string;
            mimeType: "image/avif" | "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/svg+xml" | "image/webp" | "image/x-icon";
            updatedAt: number;
        }, {
            pageUrl: string;
            origin: string;
            sourceUrl?: string | undefined;
            data: string;
            mimeType: "image/avif" | "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/svg+xml" | "image/webp" | "image/x-icon";
            updatedAt: number;
        }>, "many">], null>;
        returns: z.ZodNumber;
        capability: string;
        authority: {
            principals: ("code" | "host" | "user")[];
        };
        tier: {
            tier: "gated" | "open";
            session: "family";
            rationale: string;
        };
        access: {
            sensitivity: "destructive" | "read" | "write";
        };
    };
}, "addCookiesBatch" | "addFormFillBatch" | "addFormFillValue" | "addNeverSave" | "addPassword" | "addPasswordsBatch" | "applyCookieMutations" | "clearAllCookies" | "clearCookiesForOrigin" | "clearFormFillValues" | "deleteFormFillValue" | "deletePassword" | "endBrowserSession" | "getCookieSiteSummary" | "getCookiesForOrigin" | "getFormFillSuggestions" | "getNeverSaveOrigins" | "getNeverSaveOriginsPage" | "getPasswordForSite" | "isNeverSave" | "listCookieOrigins" | "listCookieOriginsPage" | "listCookiesPage" | "listFormFillValues" | "listFormFillValuesPage" | "listPasswordSummaries" | "listPasswordSummariesPage" | "listPasswordsPage" | "markFormFillValueUsed" | "removeNeverSave" | "updateFormFillValue" | "updateLastUsed" | "updatePassword">;
export {};
