import { NativeModules, Platform } from "react-native";
import type { ShellClient } from "./shellClient";
import { openExternalUrl } from "./nativeCapabilities";
export interface OAuthLoopbackHandoff {
    transactionId: string;
    redirectUri: string;
    host: "localhost" | "127.0.0.1";
    port: number;
    callbackPath: string;
    state: string;
    timeoutMs: number;
}
export interface ExternalOpenPayload {
    url?: string;
    oauthLoopback?: OAuthLoopbackHandoff;
    oauthAppScheme?: OAuthAppSchemeHandoff;
}
export interface OAuthAppSchemeHandoff {
    transactionId: string;
    redirectUri: string;
    callbackScheme: "vibestudio";
    state: string;
    timeoutMs: number;
    prefersEphemeral?: boolean;
}
interface OAuthLoopbackNativeModule {
    start(options: {
        host: "localhost" | "127.0.0.1";
        port: number;
        callbackPath: string;
        expectedState: string;
        timeoutMs: number;
    }): Promise<void>;
    wait(): Promise<{
        url: string;
        code?: string;
        state: string;
        error?: string;
    }>;
    stop(): Promise<void>;
}
interface VibestudioAuthSessionNativeModule {
    start(options: {
        authUrl: string;
        callbackScheme: "vibestudio";
        prefersEphemeral?: boolean;
        timeoutMs?: number;
    }): Promise<{ url: string }>;
}
function getNativeModule(): OAuthLoopbackNativeModule {
    const nativeModule = NativeModules["OAuthLoopback"] as OAuthLoopbackNativeModule | undefined;
    if (!nativeModule) {
        throw new Error("Android OAuth loopback support is not available in this build");
    }
    return nativeModule;
}
function getAuthSessionNativeModule(): VibestudioAuthSessionNativeModule {
    const nativeModule = NativeModules["VibestudioAuthSession"] as
        | VibestudioAuthSessionNativeModule
        | undefined;
    if (!nativeModule) {
        throw new Error("iOS OAuth auth-session support is not available in this build");
    }
    return nativeModule;
}
export async function handleExternalOpen(shellClient: ShellClient, payload: ExternalOpenPayload): Promise<void> {
    if (!payload.url)
        return;
    if (payload.oauthAppScheme) {
        if (Platform.OS !== "ios") {
            throw new Error("app-scheme OAuth handoffs require iOS ASWebAuthenticationSession");
        }
        const authSession = getAuthSessionNativeModule();
        const handoff = payload.oauthAppScheme;
        const result = await authSession.start({
            authUrl: payload.url,
            callbackScheme: handoff.callbackScheme,
            prefersEphemeral: handoff.prefersEphemeral,
            timeoutMs: handoff.timeoutMs,
        });
        const callbackUrl = result.url;
        const state = new URL(callbackUrl).searchParams.get("state") ?? undefined;
        if (state !== handoff.state) {
            throw new Error("OAuth state mismatch");
        }
        await shellClient.credentialService.forwardOAuthCallback({
            transactionId: handoff.transactionId,
            url: callbackUrl,
            state,
        });
        return;
    }
    if (!payload.oauthLoopback) {
        const oauthError = describeMissingLoopback(payload.url);
        if (oauthError) {
            throw new Error(oauthError);
        }
        await openExternalUrl(payload.url);
        return;
    }
    if (Platform.OS === "ios") {
        throw new Error("Android OAuth loopback handoff cannot run on iOS; retry with app-scheme OAuth.");
    }
    const native = getNativeModule();
    const loopback = payload.oauthLoopback;
    let callbackPending: Promise<{
        url: string;
        code?: string;
        state: string;
        error?: string;
    }> | null = null;
    try {
        await native.start({
            host: loopback.host,
            port: loopback.port,
            callbackPath: loopback.callbackPath,
            expectedState: loopback.state,
            timeoutMs: loopback.timeoutMs,
        });
        callbackPending = native.wait();
        await openExternalUrl(payload.url);
        const callback = await callbackPending;
        await shellClient.credentialService.forwardOAuthCallback({
                transactionId: loopback.transactionId,
                url: callback.url,
                state: callback.state,
            });
    }
    catch (error) {
        await native.stop().catch(() => { });
        throw error;
    }
}
function describeMissingLoopback(rawUrl: string): string | null {
    let url: URL;
    try {
        url = new URL(rawUrl);
    }
    catch {
        return null;
    }
    if (url.hostname !== "auth.openai.com" || !url.pathname.startsWith("/oauth/authorize")) {
        return null;
    }
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    if (redirectUri.startsWith("http://localhost:") || redirectUri.startsWith("http://127.0.0.1:")) {
        return null;
    }
    return "OpenAI OAuth was started without the Android loopback callback. Restart the Vibestudio server and retry so the mobile panel uses the client-loopback OAuth flow.";
}
