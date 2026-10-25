export const VERSION = "0.1.0";

declare const __EXTENSION_VERSION__: string | undefined;

/** Version of the extension in the checkout this CLI was built from (set by scripts/build.mjs). */
export const EXTENSION_VERSION: string = typeof __EXTENSION_VERSION__ === "string" ? __EXTENSION_VERSION__ : "unknown";
