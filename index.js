/**
 * Host half of `dsh-terminal-workspace`.
 *
 * The plugin adds no Host capability: interactive shells are owned by the
 * installed `@deepseek-ai/dsh-api-terminal-controller` service, and the browser
 * half drives them through that service's Client model (`ctx.webTerminals`).
 * This module exists so the Loader row resolves, and so the package can grow a
 * Host half later without changing its mount.
 *
 * @module dsh-terminal-workspace
 */

/**
 * Activate the Host half.
 * @returns nothing; all behavior lives in the browser bundle.
 */
export function apply() {}
