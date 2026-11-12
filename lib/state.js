/**
 * dsh-shell-skills/state — the manager's volatile state surface.
 *
 * The Plugins-page card cannot use a custom Remote namespace, so the Host and
 * the card share settings documents. Keeping that state in the SAME document as
 * the editable hub settings means every state write bumps the revision the
 * form was opened at, and a save then fails the revision fence with
 * "the deployment did not accept these values".
 *
 * This entry exists only to hold those fields in their own document. It
 * publishes its live config so the host half can read `pendingAction` and
 * compare `lastActionId` without polling the settings service.
 *
 * @module dsh-shell-skills/state
 */

import z from '@deepseek-ai/schemastery'

/** Stable entry id; also the settings namespace the card writes. */
export const name = 'dsh-shell-skills-state'

/** The state surface has no dependencies. */
export const inject = []

/** Cordis service name exposing the live state config. */
export const STATE_SERVICE = 'shellSkillsState'

/**
 * Manager state, all volatile.
 *
 * `installedJson` / `remoteJson` / `statusJson` are mirrors the Host writes for
 * the card; `pendingAction` is the card's command; `lastActionId` acknowledges
 * it. None of these belong in the editable settings form.
 */
export const Config = z.object({
  /** JSON array of `{ name, description, status }` for every installed skill. */
  'installedJson': z.string().default('').volatile(),
  /** JSON array of remote index entries with an `installed` flag. */
  'remoteJson': z.string().default('').volatile(),
  /** JSON `{ ok, action, message, at }` describing the last manager action. */
  'statusJson': z.string().default('').volatile(),
  /** JSON `{ id, type, name?, status?, at }` the card asks the Host to perform. */
  'pendingAction': z.string().default('').volatile(),
  /** Id of the last action performed; prevents replaying the same request. */
  'lastActionId': z.string().default('').volatile(),
})

/**
 * Publish the live config for the host half.
 * @param ctx - the Cordis context owning this entry.
 * @param config - the resolved Config.
 */
export function apply(ctx, config) {
  ctx.provide(STATE_SERVICE, { config, namespace: name })
}