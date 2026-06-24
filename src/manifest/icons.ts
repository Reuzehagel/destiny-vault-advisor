import { Data, Effect, Schedule } from "effect"

// Resolve item details from the Bungie manifest by item-definition hash. The DIM CSV
// gives us the hash; the manifest gives icon, description, flavor, type, and the socket
// plugs (for an exotic's intrinsic perk). Needs a Bungie API key (header only — no
// OAuth). This is the showcase for Effect: many small requests fetched with bounded
// concurrency, retried on rate-limit, with per-item failure isolation.

const BASE = "https://www.bungie.net"
const entityUrl = (type: string, hash: string) =>
  `${BASE}/Platform/Destiny2/Manifest/${type}/${hash}/`

export class ManifestFetchError extends Data.TaggedError("ManifestFetchError")<{
  readonly hash: string
  readonly status?: number
  readonly message: string
}> {}

export interface ItemInfo {
  readonly icon?: string
  readonly name?: string
  /** itemTypeDisplayName, e.g. "Warlock Gauntlets". */
  readonly type?: string
  /** flavorText — the lore blurb. */
  readonly flavor?: string
  /** displayProperties.description (often empty for armor). */
  readonly description?: string
  /** singleInitialItemHashes of the item's sockets — candidates for the exotic perk. */
  readonly plugHashes: ReadonlyArray<string>
  /** Resolved lazily for exotics: the intrinsic perk's name + what it does. */
  readonly perkName?: string
  readonly perkDescription?: string
}

const retry = {
  schedule: Schedule.exponential("500 millis").pipe(Schedule.compose(Schedule.recurs(4))),
  while: (e: ManifestFetchError) => e.status === 429 || (e.status ?? 0) >= 500 || e.status === undefined,
}

// Low-level: fetch one manifest entity definition's `Response` object.
const fetchEntity = (type: string, hash: string, apiKey: string): Effect.Effect<any, ManifestFetchError> =>
  Effect.tryPromise({
    try: (signal) => fetch(entityUrl(type, hash), { headers: { "X-API-Key": apiKey }, signal }),
    catch: (e) => new ManifestFetchError({ hash, message: String(e) }),
  }).pipe(
    Effect.flatMap((res) => {
      if (res.status === 429 || res.status >= 500) {
        return Effect.fail(new ManifestFetchError({ hash, status: res.status, message: `retryable HTTP ${res.status}` }))
      }
      if (!res.ok) {
        return Effect.fail(new ManifestFetchError({ hash, status: res.status, message: `HTTP ${res.status}` }))
      }
      return Effect.tryPromise({
        try: () => res.json() as Promise<{ Response?: any }>,
        catch: (e) => new ManifestFetchError({ hash, message: String(e) }),
      })
    }),
    Effect.retry(retry),
    Effect.map((json) => json?.Response),
  )

const toItemInfo = (def: any): ItemInfo => ({
  icon: def?.displayProperties?.icon ? `${BASE}${def.displayProperties.icon}` : undefined,
  name: def?.displayProperties?.name || undefined,
  type: def?.itemTypeDisplayName || undefined,
  flavor: def?.flavorText || undefined,
  description: def?.displayProperties?.description || undefined,
  plugHashes: ((def?.sockets?.socketEntries ?? []) as Array<{ singleInitialItemHash?: number }>)
    .map((e) => e.singleInitialItemHash)
    .filter((h): h is number => typeof h === "number" && h !== 0)
    .map(String),
})

/**
 * Fetch item info for the given hashes concurrently. Failures are isolated (a hash that
 * errors is skipped), so one bad item never sinks the batch.
 */
export const fetchItemInfo = (
  hashes: ReadonlyArray<string>,
  apiKey: string,
): Effect.Effect<Record<string, ItemInfo>> =>
  Effect.forEach(
    hashes,
    (h) =>
      fetchEntity("DestinyInventoryItemDefinition", h, apiKey).pipe(
        Effect.map((def) => [h, toItemInfo(def)] as const),
        Effect.catchAll(() => Effect.succeed([h, null] as const)),
      ),
    { concurrency: 8 },
  ).pipe(
    Effect.map((entries) => {
      const out: Record<string, ItemInfo> = {}
      for (const [h, info] of entries) if (info) out[h] = info
      return out
    }),
  )

/**
 * Resolve an exotic's intrinsic perk from its socket plugs. Each plug's manifest def carries
 * a `plug.plugCategoryIdentifier`; the exotic armor trait lives in an "intrinsic" category,
 * while the long-but-irrelevant "Upgrade Armor" text comes from the masterwork plug. So we
 * prefer the intrinsic plug, then any non-cosmetic/non-masterwork plug, and only then fall
 * back to longest-description. Within each tier the longest non-empty description wins.
 */
const PLUG_NOISE = /masterwork|cosmetic|shader|ornament|tracker|empty|stat/i

export const fetchBestPerk = (
  plugHashes: ReadonlyArray<string>,
  apiKey: string,
): Effect.Effect<{ name?: string; description: string } | null> =>
  Effect.forEach(
    plugHashes,
    (h) =>
      fetchEntity("DestinyInventoryItemDefinition", h, apiKey).pipe(
        Effect.map((def) => ({
          name: def?.displayProperties?.name as string | undefined,
          description: (def?.displayProperties?.description as string | undefined) ?? "",
          category: (def?.plug?.plugCategoryIdentifier as string | undefined) ?? "",
        })),
        Effect.catchAll(() => Effect.succeed({ name: undefined, description: "", category: "" })),
      ),
    { concurrency: 6 },
  ).pipe(
    Effect.map((plugs) => {
      const withDesc = plugs.filter((p) => p.description.trim().length > 0)
      const longest = (arr: typeof withDesc) =>
        [...arr].sort((a, b) => b.description.length - a.description.length)[0]
      const intrinsic = withDesc.filter(
        (p) => /intrinsic/i.test(p.category) && !/empty/i.test(p.category),
      )
      const signal = withDesc.filter((p) => !PLUG_NOISE.test(p.category))
      const best = longest(intrinsic) ?? longest(signal) ?? longest(withDesc)
      return best ? { name: best.name, description: best.description } : null
    }),
  )
