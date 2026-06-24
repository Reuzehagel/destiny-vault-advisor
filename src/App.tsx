import { Fragment, memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react"
import { Effect, Exit, Cause } from "effect"
import { parseArmorCsv, type ParsedArmor } from "./parse/dimArmor"
import { analyzeArmor, DEFAULT_PROTECTED_TAGS, type AnalysisResult } from "./domain/analysis"
import { fetchItemInfo, fetchBestPerk, type ItemInfo } from "./manifest/icons"
import type { AnnotatedArmor, Verdict } from "./domain/model"
import { cn } from "@/lib/utils"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Checkbox } from "@/components/ui/checkbox"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Settings2, Tags, Image as ImageIcon, SlidersHorizontal } from "lucide-react"

type LoadedResult = AnalysisResult & { skipped: number; usedBaseStats: boolean }
type Filter = "ALL" | Verdict
/** "total" | "power" | "name" | a stat name (sort by that stat). */
type SortKey = string
type GroupBy = "NONE" | "Archetype" | "Set"

const BASE_SORT_LABEL: Record<string, string> = {
  total: "Total",
  power: "Power",
  name: "Name",
}
const sortLabel = (k: SortKey) => BASE_SORT_LABEL[k] ?? k

// Static option set for the group-by Select. Labels carry the "Group:" prefix so the
// trigger (a bare <SelectValue/>) renders them verbatim — no external label mapping.
const GROUP_ITEMS: ReadonlyArray<{ value: GroupBy; label: string }> = [
  { value: "NONE", label: "No grouping" },
  { value: "Archetype", label: "Group: Archetype" },
  { value: "Set", label: "Group: Set" },
]

const STORAGE_KEY = "vault-advisor:v1"

const VERDICT_LABEL: Record<Verdict, string> = {
  SHARD: "Shard",
  DUPE: "Dupe",
  KEEP: "Keep",
}

// Bungie's official stat icons (Armor 3.0). Headers show the icon; the name is on hover.
const STAT_ICONS: Record<string, string> = {
  Health: "https://www.bungie.net/common/destiny2_content/icons/717b8b218cc14325a54869bef21d2964.png",
  Melee: "https://www.bungie.net/common/destiny2_content/icons/fa534aca76d7f2d7e7b4ba4df4271b42.png",
  Grenade: "https://www.bungie.net/common/destiny2_content/icons/065cdaabef560e5808e821cefaeaa22c.png",
  Super: "https://www.bungie.net/common/destiny2_content/icons/585ae4ede9c3da96b34086fccccdc8cd.png",
  Class: "https://www.bungie.net/common/destiny2_content/icons/7eb845acb5b3a4a9b7e0b2f05f5c43f1.png",
  Weapons: "https://www.bungie.net/common/destiny2_content/icons/bc69675acdae9e6b9a68a02fb4d62e07.png",
}

const VERDICT_CLASS: Record<Verdict, string> = {
  SHARD: "bg-shard/15 text-shard",
  DUPE: "bg-dupe/15 text-dupe",
  KEEP: "bg-keep/15 text-keep",
}

// The CSV "Id" is the DIM item instance id, exported wrapped in quotes. DIM search
// matches exact items with `id:<instanceId>`, OR-ed together to highlight a set.
const cleanId = (id: string) => id.replace(/[^0-9]/g, "")
const buildDimQuery = (ids: ReadonlyArray<string>) =>
  ids.map((id) => `id:${cleanId(id)}`).join(" or ")

// Lightweight fuzzy matcher: case-insensitive subsequence match with scoring. Returns the
// match score (higher = better) or -1 when `query`'s characters don't appear in order in
// `text`. Rewards matches at word boundaries and consecutive runs, so "dis" ranks "Disaster
// Corps" above a piece where d-i-s are scattered. No dependency, fast enough for 1000+ names.
function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let qi = 0
  let score = 0
  let run = 0
  let prev = -2
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue
    let bonus = 1
    if (ti === 0 || t[ti - 1] === " " || t[ti - 1] === "'") bonus += 4 // word boundary
    if (ti === prev + 1) bonus += ++run * 2 // consecutive run
    else run = 0
    score += bonus
    prev = ti
    qi++
  }
  return qi === q.length ? score : -1
}

function runParse(csv: string): Promise<Exit.Exit<ParsedArmor, unknown>> {
  return Effect.runPromiseExit(parseArmorCsv(csv))
}

function friendlyError(cause: Cause.Cause<unknown>): string {
  const err = Cause.failureOption(cause)
  if (err._tag === "Some") {
    const e = err.value as { _tag?: string; headers?: ReadonlyArray<string>; message?: string }
    switch (e._tag) {
      case "NoStatColumnsError":
        return `Couldn't find any stat columns. Detected headers: ${(e.headers ?? []).join(", ")}.`
      case "NoArmorRowsError":
        return "No armor rows found — is this the armor.csv (not weapons.csv)?"
      case "CsvParseError":
        return `CSV parse error: ${e.message}`
    }
  }
  return "Something went wrong reading that file."
}

export default function App() {
  const [parsed, setParsed] = useState<ParsedArmor | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fileName, setFileName] = useState("")
  const [dragging, setDragging] = useState(false)

  const [filter, setFilter] = useState<Filter>("ALL")
  const [sortKey, setSortKey] = useState<SortKey>("total")
  const [search, setSearch] = useState("")
  const [klass, setKlass] = useState("ALL")
  const [minStat, setMinStat] = useState("NONE")
  const [minVal, setMinVal] = useState(0)
  const [groupBy, setGroupBy] = useState<GroupBy>("NONE")
  const [tierFilter, setTierFilter] = useState("ALL")
  const [protectedTags, setProtectedTags] = useState<ReadonlyArray<string>>(DEFAULT_PROTECTED_TAGS)

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [copied, setCopied] = useState<string | null>(null)

  const [apiKey, setApiKey] = useState("")
  const [items, setItems] = useState<Record<string, ItemInfo>>({})
  const [iconLoading, setIconLoading] = useState(false)

  const [settingsSection, setSettingsSection] = useState<"advisor" | "icons">("advisor")

  function clearIconCache() {
    setItems({})
    try {
      localStorage.removeItem("vault-advisor:items")
    } catch {
      // best-effort
    }
  }

  // Lazily resolve an exotic's intrinsic perk text the first time its popup opens.
  // useCallback keeps the identity stable so memoized rows don't re-render on every keystroke.
  const resolvePerk = useCallback((a: AnnotatedArmor) => {
    const info = items[a.hash]
    if (
      a.rarity.toLowerCase() !== "exotic" ||
      !apiKey.trim() ||
      !info ||
      info.perkName !== undefined ||
      info.plugHashes.length === 0
    ) {
      return
    }
    // Mark as in-progress (empty perkName) so we don't refetch on every open.
    setItems((prev) => ({ ...prev, [a.hash]: { ...prev[a.hash], perkName: "" } }))
    Effect.runPromise(fetchBestPerk(info.plugHashes, apiKey.trim())).then((perk) => {
      if (!perk) return
      setItems((prev) => {
        const next = {
          ...prev,
          [a.hash]: { ...prev[a.hash], perkName: perk.name, perkDescription: perk.description },
        }
        try {
          localStorage.setItem("vault-advisor:items", JSON.stringify(next))
        } catch {
          // best-effort
        }
        return next
      })
    })
  }, [items, apiKey])

  // Analysis is derived: re-runs when the parsed vault OR the protected-tags setting changes.
  const result = useMemo<LoadedResult | null>(() => {
    if (!parsed) return null
    return {
      ...analyzeArmor(parsed.pieces, parsed.statColumns, protectedTags),
      skipped: parsed.skipped,
      usedBaseStats: parsed.usedBaseStats,
    }
  }, [parsed, protectedTags])

  async function analyze(text: string, name: string) {
    setError(null)
    const exit = await runParse(text)
    if (Exit.isSuccess(exit)) {
      setParsed(exit.value)
      setFileName(name)
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        const saved = raw ? JSON.parse(raw) : {}
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, csv: text, fileName: name }))
      } catch {
        // storage disabled/full — persistence is best-effort
      }
    } else {
      setParsed(null)
      setError(friendlyError(exit.cause))
    }
  }

  function copyQuery(ids: ReadonlyArray<string>, label: string) {
    if (ids.length === 0) return
    navigator.clipboard.writeText(buildDimQuery(ids)).then(() => {
      setCopied(label)
      setTimeout(() => setCopied(null), 1800)
    })
  }

  async function handleFile(file: File) {
    setSelected(new Set()) // stale ids would point at the previous file's items
    await analyze(await file.text(), file.name)
  }

  async function loadSample() {
    setSelected(new Set())
    const res = await fetch(`${import.meta.env.BASE_URL}armor-sample.csv`)
    await analyze(await res.text(), "armor-sample.csv (demo)")
  }

  // Restore the last-loaded vault + selection + settings on first mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw) as {
        csv?: string
        fileName?: string
        selected?: string[]
        protectedTags?: string[]
      }
      if (saved.selected) setSelected(new Set(saved.selected))
      if (saved.protectedTags) setProtectedTags(saved.protectedTags)
      if (saved.csv) analyze(saved.csv, saved.fileName ?? "restored.csv")
    } catch {
      // ignore corrupt storage
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist selection + settings (merged into the saved blob) whenever they change.
  useEffect(() => {
    if (!result) return
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      const saved = raw ? JSON.parse(raw) : {}
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ...saved, selected: [...selected], protectedTags }),
      )
    } catch {
      // best-effort
    }
  }, [selected, protectedTags, result])

  // Load saved API key + cached item info once.
  useEffect(() => {
    try {
      const k = localStorage.getItem("vault-advisor:apikey")
      if (k) setApiKey(k)
      const it = localStorage.getItem("vault-advisor:items")
      if (it) setItems(JSON.parse(it))
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem("vault-advisor:apikey", apiKey)
    } catch {
      // ignore
    }
  }, [apiKey])

  // Fetch item info for any hashes we don't have cached, once a key + vault are present.
  useEffect(() => {
    if (!result || !apiKey.trim()) return
    const missing = [...new Set(result.armor.map((a) => a.hash).filter(Boolean))].filter(
      (h) => !items[h],
    )
    if (missing.length === 0) return
    setIconLoading(true)
    Effect.runPromise(fetchItemInfo(missing, apiKey.trim()))
      .then((fetched) =>
        setItems((prev) => {
          const next = { ...prev, ...fetched }
          try {
            localStorage.setItem("vault-advisor:items", JSON.stringify(next))
          } catch {
            // cache is best-effort
          }
          return next
        }),
      )
      .finally(() => setIconLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, apiKey])

  const statColumns = result?.summary.statColumns ?? []
  const classes = useMemo(
    () => (result ? Array.from(new Set(result.armor.map((a) => a.klass))).sort() : []),
    [result],
  )
  const tiers = useMemo(
    () => (result ? Array.from(new Set(result.armor.map((a) => a.tier))).sort((x, y) => y - x) : []),
    [result],
  )
  // Id → piece, so a row's `dominatedBy` ids can be resolved to the actual better rolls.
  const byId = useMemo(
    () => new Map((result?.armor ?? []).map((a) => [a.id, a] as const)),
    [result],
  )

  // Option sets for the filter Selects. Each is passed to <Select items> so a bare
  // <SelectValue/> renders the selected item's label (Base UI maps value→label from
  // items) and so the same array is the single source for the rendered <SelectItem>s.
  const klassItems = useMemo(
    () => [{ value: "ALL", label: "All classes" }, ...classes.map((c) => ({ value: c, label: c }))],
    [classes],
  )
  const sortItems = useMemo(
    () => [
      { value: "total", label: "Total" },
      { value: "power", label: "Power" },
      { value: "name", label: "Name" },
      ...statColumns.map((s) => ({ value: s, label: s })),
    ],
    [statColumns],
  )
  const minStatItems = useMemo(
    () => [{ value: "NONE", label: "Min stat" }, ...statColumns.map((s) => ({ value: s, label: s }))],
    [statColumns],
  )
  const tierItems = useMemo(
    () => [
      { value: "ALL", label: "All tiers" },
      ...tiers.map((t) => ({ value: String(t), label: t === 0 ? "Legacy (T0)" : `Tier ${t}` })),
    ],
    [tiers],
  )

  // The input updates `search` synchronously (snappy typing); the heavy filter/sort + table
  // re-render keys off the deferred value, so it runs at low priority and never blocks input.
  const deferredSearch = useDeferredValue(search)
  const isSearchStale = search !== deferredSearch

  const rows = useMemo(() => {
    if (!result) return []
    let r = result.armor
    if (filter !== "ALL") r = r.filter((a) => a.verdicts.includes(filter))
    if (klass !== "ALL") r = r.filter((a) => a.klass === klass)
    if (tierFilter !== "ALL") r = r.filter((a) => a.tier === Number(tierFilter))
    if (minStat !== "NONE") r = r.filter((a) => (a.stats[minStat] ?? 0) >= minVal)

    // With a query active, fuzzy-match on name and order by relevance (best matches first),
    // which overrides the chosen sort — the most useful order while you're typing.
    const q = deferredSearch.trim()
    if (q) {
      const scored: Array<{ a: AnnotatedArmor; score: number }> = []
      for (const a of r) {
        const score = fuzzyScore(q, a.name)
        if (score >= 0) scored.push({ a, score })
      }
      scored.sort((x, y) => y.score - x.score || x.a.name.localeCompare(y.a.name))
      return scored.map((s) => s.a)
    }

    return [...r].sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name)
      if (sortKey === "total" || sortKey === "power") return b[sortKey] - a[sortKey]
      // otherwise sortKey is a stat name
      return (b.stats[sortKey] ?? 0) - (a.stats[sortKey] ?? 0)
    })
  }, [result, filter, klass, tierFilter, minStat, minVal, deferredSearch, sortKey])

  // When grouping, partition the filtered rows; otherwise a single anonymous group.
  const groups = useMemo(() => {
    if (groupBy === "NONE") return [{ key: "", items: rows }]
    const m = new Map<string, AnnotatedArmor[]>()
    for (const a of rows) {
      const key = (groupBy === "Set" ? a.set : a.archetype) || "—"
      const arr = m.get(key)
      if (arr) arr.push(a)
      else m.set(key, [a])
    }
    return [...m.entries()]
      .sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]))
      .map(([key, items]) => ({ key, items }))
  }, [rows, groupBy])

  const allFilteredSelected = rows.length > 0 && rows.every((a) => selected.has(a.id))
  const someFilteredSelected = rows.some((a) => selected.has(a.id))
  const shardIds = useMemo(
    () => (result?.armor ?? []).filter((a) => a.verdicts.includes("SHARD")).map((a) => a.id),
    [result],
  )

  const toggleRow = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  function toggleAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allFilteredSelected) rows.forEach((a) => next.delete(a.id))
      else rows.forEach((a) => next.add(a.id))
      return next
    })
  }

  function toggleGroup(items: ReadonlyArray<AnnotatedArmor>) {
    const allSel = items.every((a) => selected.has(a.id))
    setSelected((prev) => {
      const next = new Set(prev)
      items.forEach((a) => (allSel ? next.delete(a.id) : next.add(a.id)))
      return next
    })
  }

  const colSpan = 8 + statColumns.length

  // How many secondary controls are set away from their default — shown as a badge on the
  // Filters button so active refinements stay visible even while the popover is closed.
  const activeFilterCount =
    (klass !== "ALL" ? 1 : 0) +
    (tierFilter !== "ALL" ? 1 : 0) +
    (sortKey !== "total" ? 1 : 0) +
    (groupBy !== "NONE" ? 1 : 0) +
    (minStat !== "NONE" ? 1 : 0)

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Vault Advisor</h1>
          <p className="mt-1 text-muted-foreground">
            Drop your DIM armor export and find what's safe to shard.
          </p>
        </div>
        <Dialog>
          <DialogTrigger
            render={
              <Button variant="outline" size="icon" aria-label="Settings">
                <Settings2 />
              </Button>
            }
          />
          <DialogContent className="overflow-hidden p-0 sm:max-w-2xl">
            <DialogTitle className="sr-only">Settings</DialogTitle>
            <Tabs
              value={settingsSection}
              onValueChange={(v) => setSettingsSection(v as "advisor" | "icons")}
              orientation="vertical"
              className="min-h-96 gap-0"
            >
              <TabsList className="h-auto w-44 shrink-0 justify-start gap-1 rounded-none border-r bg-muted/30 p-2">
                <TabsTrigger value="advisor" className="justify-start">
                  <Tags />
                  Advisor
                </TabsTrigger>
                <TabsTrigger value="icons" className="justify-start">
                  <ImageIcon />
                  Item icons
                </TabsTrigger>
              </TabsList>
              <TabsContent value="advisor" className="p-6">
                <FieldGroup>
                  <Field>
                    <FieldLabel>Tags that protect a piece</FieldLabel>
                    <ToggleGroup
                      multiple
                      variant="outline"
                      size="sm"
                      value={[...protectedTags]}
                      onValueChange={(vals) => setProtectedTags(vals)}
                    >
                      {["keep", "favorite", "archive"].map((t) => (
                        <ToggleGroupItem key={t} value={t} className="capitalize">
                          {t}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                    <FieldDescription>
                      Pieces with these DIM tags are never suggested for shard/dupe. In-game
                      "locked" is ignored — many players lock reflexively.
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </TabsContent>
              <TabsContent value="icons" className="p-6">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="apikey">Bungie API key</FieldLabel>
                    <Input
                      id="apikey"
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="paste key…"
                    />
                    <FieldDescription>
                      Used to fetch item icons & descriptions from the Bungie manifest (no login).{" "}
                      <a
                        href="https://www.bungie.net/en/Application"
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary underline"
                      >
                        Get a free key
                      </a>
                      . Origin Header must be your app URL (e.g. http://localhost:5173).
                      {iconLoading
                        ? " · fetching…"
                        : Object.keys(items).length > 0
                          ? ` · ${Object.keys(items).length} cached`
                          : ""}
                    </FieldDescription>
                  </Field>
                  {Object.keys(items).length > 0 && (
                    <Button variant="outline" size="sm" className="w-fit" onClick={clearIconCache}>
                      Clear icon cache
                    </Button>
                  )}
                </FieldGroup>
              </TabsContent>
            </Tabs>
          </DialogContent>
        </Dialog>
      </header>

      <Card
        className={cn(
          "border-dashed transition-colors",
          dragging && "border-primary bg-accent/40",
        )}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const f = e.dataTransfer.files[0]
          if (f) handleFile(f)
        }}
      >
        <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
          <p className="text-sm">
            Drag <code className="rounded bg-muted px-1.5 py-0.5">armor.csv</code> here, or
          </p>
          <label className={cn(buttonVariants(), "cursor-pointer")}>
            Choose file
            <input
              type="file"
              accept=".csv"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleFile(f)
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            DIM → Settings → "Export to CSV" → Armor ·{" "}
            <Button variant="link" onClick={loadSample} className="h-auto p-0 text-xs">
              or try sample data
            </Button>
          </p>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive" className="mt-4">
          <AlertTitle>Couldn't read that file</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {result && (
        <div className="mt-8 flex flex-col gap-4">
          <div className="flex items-stretch divide-x divide-border rounded-lg border bg-card/40">
            {[
              { label: "Pieces", value: result.summary.total },
              { label: "Safe to shard", value: result.summary.shardable, tone: "text-shard" },
              { label: "Duplicates", value: result.summary.dupes, tone: "text-dupe" },
              { label: "Legacy", value: result.summary.legacy },
            ].map((s) => (
              <div key={s.label} className="flex-1 px-3 py-2.5 text-center">
                <div className={cn("text-xl font-bold tabular-nums", s.tone)}>{s.value}</div>
                <div className="text-xs text-muted-foreground">{s.label}</div>
              </div>
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            Loaded <strong className="text-foreground">{fileName}</strong> · stats:{" "}
            <code>{statColumns.join(", ")}</code>
            {result.usedBaseStats && " (base)"}
            {result.skipped > 0 && ` · ${result.skipped} rows skipped`}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              variant="outline"
              size="sm"
              value={[filter]}
              onValueChange={(vals) => setFilter((vals[vals.length - 1] as Filter) ?? "ALL")}
            >
              {(["ALL", "SHARD", "DUPE", "KEEP"] as Filter[]).map((f) => (
                <ToggleGroupItem key={f} value={f}>
                  {f === "ALL" ? "All" : VERDICT_LABEL[f]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>

            <div className="ml-auto flex items-center gap-2">
              <Popover>
                <PopoverTrigger
                  render={
                    <Button variant="outline" size="sm">
                      <SlidersHorizontal />
                      Filters
                      {activeFilterCount > 0 && (
                        <Badge
                          variant="secondary"
                          className="ml-1 size-5 justify-center rounded-full p-0 tabular-nums"
                        >
                          {activeFilterCount}
                        </Badge>
                      )}
                    </Button>
                  }
                />
                <PopoverContent align="end" className="w-72">
                  <FieldGroup>
                    <Field>
                      <FieldLabel>Class</FieldLabel>
                      <Select items={klassItems} value={klass} onValueChange={(v) => setKlass(v ?? "ALL")}>
                        <SelectTrigger size="sm" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {klassItems.map((it) => (
                              <SelectItem key={it.value} value={it.value}>
                                {it.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel>Tier</FieldLabel>
                      <Select items={tierItems} value={tierFilter} onValueChange={(v) => setTierFilter(v ?? "ALL")}>
                        <SelectTrigger size="sm" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {tierItems.map((it) => (
                              <SelectItem key={it.value} value={it.value}>
                                {it.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel>Sort by</FieldLabel>
                      <Select items={sortItems} value={sortKey} onValueChange={(v) => setSortKey(v ?? "total")}>
                        <SelectTrigger size="sm" className="w-full">
                          <SelectValue>{(v) => sortLabel(v)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {sortItems.map((it) => (
                              <SelectItem key={it.value} value={it.value}>
                                {it.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel>Group by</FieldLabel>
                      <Select items={GROUP_ITEMS} value={groupBy} onValueChange={(v) => setGroupBy((v ?? "NONE") as GroupBy)}>
                        <SelectTrigger size="sm" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {GROUP_ITEMS.map((it) => (
                              <SelectItem key={it.value} value={it.value}>
                                {it.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel>Min stat</FieldLabel>
                      <div className="flex items-center gap-2">
                        <Select items={minStatItems} value={minStat} onValueChange={(v) => setMinStat(v ?? "NONE")}>
                          <SelectTrigger size="sm" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {minStatItems.map((it) => (
                                <SelectItem key={it.value} value={it.value}>
                                  {it.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        {minStat !== "NONE" && (
                          <Input
                            type="number"
                            min={0}
                            value={minVal}
                            onChange={(e) => setMinVal(Number(e.target.value) || 0)}
                            className="w-20"
                            aria-label="Minimum value"
                          />
                        )}
                      </div>
                    </Field>
                  </FieldGroup>
                </PopoverContent>
              </Popover>

              <Input
                placeholder="Search name…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-44"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card/40 px-3 py-2">
            <span className="text-sm text-muted-foreground">
              {selected.size > 0
                ? `${selected.size} selected`
                : "Tick rows, then copy a DIM search to select them in‑game"}
            </span>
            <div className="ml-auto flex gap-2">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={selected.size === 0}
                      onClick={() => copyQuery([...selected], "selected")}
                    >
                      {copied === "selected" ? "Copied ✓" : `Copy DIM query${selected.size ? ` (${selected.size})` : ""}`}
                    </Button>
                  }
                />
                <TooltipContent>Paste into DIM's search bar to highlight exactly these items</TooltipContent>
              </Tooltip>
              {shardIds.length > 0 && (
                <Button size="sm" variant="outline" onClick={() => copyQuery(shardIds, "shard")}>
                  {copied === "shard" ? "Copied ✓" : `Copy all shardable (${shardIds.length})`}
                </Button>
              )}
              {selected.size > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              )}
            </div>
          </div>

          <div className={cn("rounded-lg border", isSearchStale && "opacity-60 transition-opacity")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      checked={allFilteredSelected}
                      indeterminate={!allFilteredSelected && someFilteredSelected}
                      onCheckedChange={toggleAllFiltered}
                      aria-label="Select all rows"
                    />
                  </TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Class</TableHead>
                  <TableHead>Slot</TableHead>
                  <TableHead className="text-center">Tier</TableHead>
                  <TableHead>Archetype</TableHead>
                  {statColumns.map((s) => (
                    <TableHead key={s} className="text-center">
                      {STAT_ICONS[s] ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <img src={STAT_ICONS[s]} alt={s} className="mx-auto size-5 opacity-80" />
                            }
                          />
                          <TooltipContent>{s}</TooltipContent>
                        </Tooltip>
                      ) : (
                        s.slice(0, 3)
                      )}
                    </TableHead>
                  ))}
                  <TableHead className="text-center">Total</TableHead>
                  <TableHead>Advisor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((g) => (
                  <Fragment key={g.key || "all"}>
                    {g.key && (
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableCell className="w-8">
                          <Checkbox
                            checked={g.items.every((a) => selected.has(a.id))}
                            indeterminate={
                              !g.items.every((a) => selected.has(a.id)) &&
                              g.items.some((a) => selected.has(a.id))
                            }
                            onCheckedChange={() => toggleGroup(g.items)}
                            aria-label={`Select all ${g.key}`}
                          />
                        </TableCell>
                        <TableCell colSpan={colSpan - 1} className="font-semibold">
                          {g.key}{" "}
                          <span className="font-normal text-muted-foreground">· {g.items.length}</span>
                        </TableCell>
                      </TableRow>
                    )}
                    {g.items.map((a) => (
                      <ArmorRow
                        key={a.id}
                        a={a}
                        statColumns={statColumns}
                        selected={selected.has(a.id)}
                        onToggle={toggleRow}
                        info={items[a.hash]}
                        hasKey={apiKey.trim().length > 0}
                        byId={byId}
                        onInspect={resolvePerk}
                      />
                    ))}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
          {rows.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No matches</EmptyTitle>
                <EmptyDescription>No pieces match these filters.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      )}
    </div>
  )
}

const ArmorRow = memo(function ArmorRow({
  a,
  statColumns,
  selected,
  onToggle,
  info,
  hasKey,
  byId,
  onInspect,
}: {
  a: AnnotatedArmor
  statColumns: ReadonlyArray<string>
  selected: boolean
  onToggle: (id: string) => void
  info?: ItemInfo
  hasKey: boolean
  byId: ReadonlyMap<string, AnnotatedArmor>
  onInspect: (a: AnnotatedArmor) => void
}) {
  const exotic = a.rarity.toLowerCase() === "exotic"
  return (
    <TableRow
      data-selected={selected || undefined}
      className={cn(
        a.verdicts.includes("SHARD") && "bg-shard/5",
        "data-[selected]:bg-primary/10",
      )}
    >
      <TableCell className="w-8">
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggle(a.id)}
          aria-label={`Select ${a.name}`}
        />
      </TableCell>
      <TableCell className={cn("font-medium", exotic && "text-exotic")}>
        <div className="flex items-center gap-1.5">
          <Popover onOpenChange={(open) => open && onInspect(a)}>
            <PopoverTrigger
              render={
                <button className="flex items-center gap-2 text-left hover:underline">
                  {info?.icon && (
                    <img
                      src={info.icon}
                      alt=""
                      loading="lazy"
                      className={cn("size-7 shrink-0 rounded", exotic && "ring-1 ring-exotic/50")}
                    />
                  )}
                  <span>{a.name}</span>
                </button>
              }
            />
            <PopoverContent className="w-80">
              <ItemDetail a={a} info={info} hasKey={hasKey} byId={byId} />
            </PopoverContent>
          </Popover>
          {a.tag && (
            <Badge variant="outline" className="capitalize">
              {a.tag}
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">{a.klass}</TableCell>
      <TableCell className="text-muted-foreground">{a.slot}</TableCell>
      <TableCell className="text-center text-muted-foreground">{a.tier || "—"}</TableCell>
      <TableCell className="text-muted-foreground">{a.archetype || "—"}</TableCell>
      {statColumns.map((s) => (
        <TableCell key={s} className="text-center tabular-nums">
          {a.stats[s] ?? 0}
        </TableCell>
      ))}
      <TableCell className="text-center font-bold tabular-nums">{a.total}</TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {a.verdicts.map((v, i) => (
            <Tooltip key={v}>
              <TooltipTrigger
                render={<Badge className={cn(VERDICT_CLASS[v], "cursor-default")}>{VERDICT_LABEL[v]}</Badge>}
              />
              <TooltipContent>{a.reasons[i] ?? VERDICT_LABEL[v]}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TableCell>
    </TableRow>
  )
})

function ItemDetail({
  a,
  info,
  hasKey,
  byId,
}: {
  a: AnnotatedArmor
  info?: ItemInfo
  hasKey: boolean
  byId: ReadonlyMap<string, AnnotatedArmor>
}) {
  const exotic = a.rarity.toLowerCase() === "exotic"
  const perkLoading = info?.perkName === "" && !info?.perkDescription
  // The copies of this same item that cover it (≥ on every stat) — i.e. why it's a duplicate.
  const dominators = a.dominatedBy.map((id) => byId.get(id)).filter(Boolean) as AnnotatedArmor[]
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {info?.icon && (
          <img
            src={info.icon}
            alt=""
            className={cn("size-10 rounded", exotic && "ring-1 ring-exotic/50")}
          />
        )}
        <div>
          <div className={cn("text-sm font-semibold", exotic && "text-exotic")}>{a.name}</div>
          <div className="text-xs text-muted-foreground">
            {info?.type ?? `${a.klass} ${a.slot}`}
            {a.tier ? ` · Tier ${a.tier}` : ""}
            {a.archetype ? ` · ${a.archetype}` : ""}
          </div>
        </div>
      </div>

      {dominators.length > 0 && (
        <div className="flex flex-col gap-1 rounded-md bg-muted/50 p-2">
          <div className="text-xs font-medium">Duplicate of</div>
          {dominators.slice(0, 4).map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate">{d.name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                T{d.tier} · {d.total}
              </span>
            </div>
          ))}
          {dominators.length > 4 && (
            <div className="text-xs text-muted-foreground">+{dominators.length - 4} more</div>
          )}
        </div>
      )}

      {exotic &&
        (perkLoading ? (
          <p className="text-xs text-muted-foreground">Loading perk…</p>
        ) : info?.perkDescription ? (
          <div className="rounded-md bg-muted/50 p-2">
            {info.perkName && <div className="text-sm font-medium">{info.perkName}</div>}
            <p className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">
              {info.perkDescription}
            </p>
          </div>
        ) : null)}

      {info?.description && <p className="text-xs text-muted-foreground">{info.description}</p>}
      {info?.flavor && <p className="text-xs italic text-muted-foreground">"{info.flavor}"</p>}

      {!info && (
        <p className="text-xs text-muted-foreground">
          {hasKey ? "Fetching item details…" : "Add a Bungie API key in Settings to load item details."}
        </p>
      )}
    </div>
  )
}
