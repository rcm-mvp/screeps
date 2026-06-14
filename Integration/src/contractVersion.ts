/**
 * The contract version this harness certifies — the drift detector's anchor.
 *
 * Three places must agree, and the harness is the deliberately-independent
 * third copy (scenario F compares all of them at runtime):
 *
 *   - API/src/contract.ts      `BridgeMemory.version` (shape only, no constant)
 *   - Bot/src/settings.ts      `SETTINGS.CONTRACT_VERSION` (what the bot writes)
 *   - here                     what the integration suite certifies
 *
 * If you bump the contract in any repo, scenario F goes red until you bump it
 * everywhere AND re-certify the round-trip here. That is the point: a version
 * bump must be a conscious, coordinated, integration-tested event — never a
 * silent production failure.
 */
export const EXPECTED_CONTRACT_VERSION = 1;
