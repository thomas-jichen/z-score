"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/AppState";
import { Category } from "@/components/Category";
import { Button, Card, EmptyState, Pill } from "@/components/primitives";
import { menusByFacet } from "@/lib/tags";
import { GRAD_YEARS } from "@/lib/searchTaxonomy";
import type { CampaignSettings } from "@/lib/campaign";
import type { Selection } from "@/lib/query";
import type { CustomTerms } from "@/lib/state";
import type { TagFacet } from "@/lib/tagRegistry";
import { formatSigma } from "@/lib/zscore";

/**
 * The Agent screen: connect Claude, then watch what it does.
 *
 * Three jobs in the order they are done — connect, run, read — and the order
 * adapts to which of them is outstanding. Before a token exists the setup block
 * is open and the campaign list is an empty state; afterwards setup collapses to
 * a line and the campaigns take the top, because that is what you come back for.
 *
 * Every number a campaign obeys is on this screen and editable here, and the
 * ceilings that come from the vendors rather than from us are shown as read-only
 * facts. A loop that runs unattended for a week and cannot be asked why it
 * stopped is not something anybody should have to trust.
 */

/** "1 query planned" reads as carelessness when it says "1 queries". */
const nQueries = (n: number) => `${n} ${n === 1 ? "query" : "queries"}`;

type Summary = {
  id: string;
  name: string;
  owner: string;
  status: "running" | "done" | "stopped";
  finishedReason?: string;
  day: number;
  settings: CampaignSettings;
  spentUsd: number;
  foundCount: number;
  lastTickAt?: string;
  createdAt: string;
};

type Limits = Record<keyof CampaignSettings, { min: number; max: number; fallback: number }>;

type Facts = {
  costPerQuery: number;
  costPerProfile: number;
  apifyMaxPerRun: number;
  dailyProfileCap: number;
  hourlySearchCap: number;
  hourlyTagCap: number;
  enrichConfigured: boolean;
  mock: boolean;
  ephemeral: boolean;
};

type TokenRow = { hash: string; owner: string; label: string; createdAt: string; lastUsedAt?: string };

type ReportPerson = {
  slug: string;
  name: string;
  headline: string;
  url: string;
  score: number;
  archetype: string;
  confirmed: string[];
  enriched: boolean;
  evicted: boolean;
  signals: { label: string; points: number }[];
};

const BLANK: Selection = {
  programs: [],
  titles: [],
  colleges: [],
  highSchools: [],
  years: [],
  states: [],
  homeStates: [],
};

/** The same menus the sweep screen offers, in the same order. */
const CATEGORIES: {
  key: keyof Selection & keyof CustomTerms;
  label: string;
  facets?: TagFacet[];
  builtIn: string[];
}[] = [
  { key: "programs", label: "Programs & backers", facets: ["accelerator", "program"], builtIn: [] },
  { key: "titles", label: "Title keywords", facets: ["title"], builtIn: [] },
  { key: "colleges", label: "Colleges", facets: ["college"], builtIn: [] },
  { key: "highSchools", label: "High schools", facets: ["highschool"], builtIn: [] },
  { key: "years", label: "Class of", builtIn: GRAD_YEARS },
  { key: "states", label: "Current state", facets: ["state"], builtIn: [] },
  { key: "homeStates", label: "Home state", facets: ["homestate"], builtIn: [] },
];

/** What to say to Claude. Copyable, because the first prompt should not be a guess. */
const PROMPTS = [
  "Set up a seven day search for Stanford and MIT founders who did YC or a16z Speedrun, 100 queries a day, and enrich the best 10 each day.",
  "Change the Stanford founders campaign to 14 days and raise its ceiling to $20.",
  "Try the query \"stanford dropout building\" before I commit to it, and tell me if it is worth a campaign.",
  "How is my campaign doing, and who are the ten best people it has found?",
  "Make new campaigns default to 50 searches a day and a $2 ceiling.",
];

export default function AgentPage() {
  const { team, loading: appLoading } = useApp();

  const [campaigns, setCampaigns] = useState<Summary[]>([]);
  const [defaults, setDefaults] = useState<CampaignSettings | null>(null);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [facts, setFacts] = useState<Facts | null>(null);
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [profile, setProfile] = useState<string>("");

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** Shown once, right after minting, and never again. */
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [sel, setSel] = useState<Selection>(BLANK);
  const [rawQueries, setRawQueries] = useState("");
  const [draft, setDraft] = useState<CampaignSettings | null>(null);

  const [openReport, setOpenReport] = useState<string | null>(null);
  const [report, setReport] = useState<ReportPerson[]>([]);
  const [reportMeta, setReportMeta] = useState<{ ticks: { at: string; day: number; queries: number; queued: number; enriched: number; usd: number; note?: string }[]; plannedQueries: number; queriesRun: number } | null>(null);

  const menus = useMemo(() => menusByFacet(team.taxonomy.tags), [team.taxonomy.tags]);
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const load = useCallback(async () => {
    try {
      const [c, t] = await Promise.all([
        fetch("/api/campaigns", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/mcp-tokens", { cache: "no-store" }).then((r) => r.json()),
      ]);
      if (c.ok) {
        setCampaigns(c.campaigns);
        setDefaults(c.defaults);
        setLimits(c.limits);
        setFacts(c.facts);
        setProfile(c.profile);
        setDraft((d) => d ?? c.defaults);
      } else setError(c.error);
      if (t.ok) setTokens(t.tokens);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: unknown, url = "/api/campaigns") {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      setError(data.error ?? "That did not work.");
      return null;
    }
    setError(null);
    return data;
  }

  async function createToken() {
    setBusy("token");
    const data = await post({ op: "create", label: "Claude" }, "/api/mcp-tokens");
    setBusy(null);
    if (!data) return;
    setFreshToken(data.token);
    setCopied(false);
    await load();
  }

  async function revoke(hash: string) {
    setBusy(hash);
    const data = await post({ op: "revoke", hash }, "/api/mcp-tokens");
    setBusy(null);
    if (data) {
      setTokens(data.tokens);
      setNotice("That token no longer works.");
    }
  }

  async function createCampaign() {
    if (!name.trim()) return;
    setBusy("create");
    const queries = rawQueries
      .split("\n")
      .map((q) => q.trim())
      .filter(Boolean);
    const data = await post({ op: "create", name, selection: sel, queries, settings: draft });
    setBusy(null);
    if (!data) return;
    setCreating(false);
    setName("");
    setSel(BLANK);
    setRawQueries("");
    setNotice(
      `${data.campaign.name} is ready. ${nQueries(data.plannedQueries)} planned, about ${money(data.estimateUsd)} for the full run. Nothing has run yet.` +
        (data.warnings?.length ? ` ${data.warnings.join(" ")}` : "")
    );
    await load();
  }

  async function advance(id: string) {
    setBusy(id);
    setNotice(null);
    const data = await post({ op: "tick", id });
    setBusy(null);
    if (!data) return;
    const t = data.tick;
    setNotice(
      t
        ? `Day ${t.day}: ${nQueries(t.queries)}, ${t.queued} queued, ${t.enriched} enriched, ${money(t.usd)} spent.${t.note ? ` ${t.note}` : ""}`
        : (data.note ?? "Nothing to do.")
    );
    await load();
    if (openReport === id) await showReport(id);
  }

  async function stop(id: string) {
    setBusy(id);
    await post({ op: "stop", id });
    setBusy(null);
    await load();
  }

  async function remove(id: string) {
    setBusy(id);
    const res = await post({ op: "delete", id });
    setBusy(null);
    if (res?.deleted) setNotice(`Deleted "${res.deleted}". The people it found are still in the queue.`);
    if (openReport === id) setOpenReport(null);
    await load();
  }

  async function showReport(id: string) {
    if (openReport === id && report.length > 0) {
      setOpenReport(null);
      return;
    }
    setBusy(id);
    const data = await post({ op: "report", id, limit: 10 });
    setBusy(null);
    if (!data) return;
    setOpenReport(id);
    setReport(data.report);
    setReportMeta({
      ticks: data.ticks,
      plannedQueries: data.plannedQueries,
      queriesRun: data.campaign.day > 0 ? data.plannedQueries : 0,
    });
  }

  async function saveDefaults(next: CampaignSettings) {
    const data = await post({ op: "defaults", settings: next });
    if (data) {
      setDefaults(data.defaults);
      setNotice("New campaigns will start from those numbers.");
    }
  }

  async function updateSettings(id: string, next: Partial<CampaignSettings>) {
    const data = await post({ op: "update", id, settings: next });
    if (data) {
      setNotice(`Updated. ${nQueries(data.plannedQueries)} planned, about ${money(data.estimateUsd)} for the full run.`);
      await load();
    }
  }

  const connected = tokens.length > 0;
  const running = campaigns.filter((c) => c.status === "running").length;
  const finished = campaigns.length - running;

  const command = `claude mcp add --transport http zscore ${origin}/api/mcp \\\n  --header "Authorization: Bearer ${freshToken ?? "YOUR_TOKEN"}"`;

  return (
    <div className="z-page">
      <div className="z-page-head">
        <p className="z-label">
          {loading || appLoading
            ? "Loading"
            : campaigns.length === 0
              ? connected
                ? "Connected, no campaigns yet"
                : "Not connected yet"
              : `${running} running, ${finished} done`}
        </p>
        <h1 className="z-h1">Agent</h1>
      </div>

      {facts?.ephemeral && (
        <div className="z-banner is-error">
          No database is attached, so a campaign would not survive a restart. Add an Upstash Redis
          integration in Vercel and redeploy before starting one.
        </div>
      )}
      {error && <div className="z-banner is-error">{error}</div>}
      {notice && (
        <div className="z-banner z-row">
          <span>{notice}</span>
          <span className="z-spacer" />
          <button className="z-quiet is-bare" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Setup leads while it is outstanding, and steps aside once it is not. */}
      {!connected && !loading && (
        <div style={{ marginBottom: "var(--z-space-8)" }}>
          <Connect
            origin={origin}
            command={command}
            freshToken={freshToken}
            copied={copied}
            onCopy={() => {
              void navigator.clipboard.writeText(command);
              setCopied(true);
            }}
            onCreate={createToken}
            busy={busy === "token"}
            tokens={tokens}
            onRevoke={revoke}
            revoking={busy}
          />
        </div>
      )}

      <div className="z-col-head">
        <p className="z-label is-quiet">Campaigns</p>
        <span className="z-spacer" />
        {!creating && (
          <button className="z-quiet" onClick={() => setCreating(true)}>
            + New campaign
          </button>
        )}
      </div>

      {creating && limits && draft && (
        <Card size="lg">
          <div className="z-stack" style={{ gap: "var(--z-space-5)" }}>
            <input
              className="z-input"
              autoFocus
              placeholder="What are you looking for?"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ fontSize: "var(--z-fs-h4)", padding: "var(--z-space-3) 0", border: "none" }}
            />

            <div className="z-stack" style={{ gap: "var(--z-space-2)" }}>
              {CATEGORIES.map((c) => (
                <Category
                  key={c.key}
                  label={c.label}
                  builtIn={c.facets ? c.facets.flatMap((f) => menus.get(f) ?? []) : c.builtIn}
                  custom={team.customTerms[c.key] ?? []}
                  selected={sel[c.key] ?? []}
                  onToggle={(o) =>
                    setSel((p) => ({
                      ...p,
                      [c.key]: (p[c.key] ?? []).includes(o)
                        ? (p[c.key] ?? []).filter((x) => x !== o)
                        : [...(p[c.key] ?? []), o],
                    }))
                  }
                  onAdd={() => {}}
                  onRemove={() => {}}
                  onAll={() => {}}
                  onClear={() => setSel((p) => ({ ...p, [c.key]: [] }))}
                />
              ))}
            </div>

            <details className="z-disclosure">
              <summary>Queries of your own</summary>
              <div className="z-disclosure-body">
                <textarea
                  className="z-seed-input"
                  rows={3}
                  placeholder={"One per line.\nstanford dropout building\nintitle:founder -recruiter"}
                  value={rawQueries}
                  onChange={(e) => setRawQueries(e.target.value)}
                />
                <p className="z-micro" style={{ marginTop: "var(--z-space-2)" }}>
                  For anything the menus cannot express, such as a minus term or a quoted phrase.
                  The LinkedIn filter is added if you leave it out.
                </p>
              </div>
            </details>

            <Settings limits={limits} value={draft} onChange={setDraft} facts={facts} />

            <div className="z-row" style={{ gap: "var(--z-space-3)" }}>
              <Button size="sm" onClick={createCampaign} disabled={!name.trim() || busy === "create"}>
                {busy === "create" ? "Starting" : "Start campaign"}
              </Button>
              <button className="z-quiet is-bare" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </div>
        </Card>
      )}

      {!creating && campaigns.length === 0 && !loading ? (
        <EmptyState
          title="No campaigns yet."
          hint={
            connected
              ? "Ask Claude to start one, or fill in the form above."
              : "Connect Claude below, then ask it to find you someone."
          }
        />
      ) : (
        <div className="z-stack" style={{ gap: "var(--z-space-3)" }}>
          {campaigns.map((c) => (
            <CampaignRow
              key={c.id}
              c={c}
              mine={c.owner === profile}
              busy={busy === c.id}
              limits={limits}
              facts={facts}
              open={openReport === c.id}
              report={openReport === c.id ? report : []}
              meta={openReport === c.id ? reportMeta : null}
              onAdvance={() => advance(c.id)}
              onStop={() => stop(c.id)}
              onReport={() => showReport(c.id)}
              onUpdate={(next) => updateSettings(c.id, next)}
              onDelete={() => remove(c.id)}
            />
          ))}
        </div>
      )}

      <div className="z-section-gap z-stack" style={{ gap: "var(--z-space-6)" }}>
        {connected && (
          <details className="z-disclosure">
            <summary>
              Connect Claude
              <span className="z-count">
                {tokens.length} {tokens.length === 1 ? "token" : "tokens"}
              </span>
            </summary>
            <div className="z-disclosure-body">
              <Connect
                origin={origin}
                command={command}
                freshToken={freshToken}
                copied={copied}
                onCopy={() => {
                  void navigator.clipboard.writeText(command);
                  setCopied(true);
                }}
                onCreate={createToken}
                busy={busy === "token"}
                tokens={tokens}
                onRevoke={revoke}
                revoking={busy}
              />
            </div>
          </details>
        )}

        <details className="z-disclosure">
          <summary>What to say to Claude</summary>
          <div className="z-disclosure-body z-stack" style={{ gap: "var(--z-space-2)" }}>
            {PROMPTS.map((p) => (
              <button
                key={p}
                className="z-prompt"
                onClick={() => {
                  void navigator.clipboard.writeText(p);
                  setNotice("Copied. Paste it to Claude.");
                }}
                title="Copy this prompt"
              >
                {p}
              </button>
            ))}
          </div>
        </details>

        {defaults && limits && (
          <details className="z-disclosure">
            <summary>Defaults for new campaigns</summary>
            <div className="z-disclosure-body z-stack" style={{ gap: "var(--z-space-5)" }}>
              <Settings
                limits={limits}
                value={defaults}
                onChange={(next) => setDefaults(next)}
                facts={facts}
              />
              <button
                className="z-quiet is-accent"
                style={{ alignSelf: "flex-start" }}
                onClick={() => saveDefaults(defaults)}
              >
                Save as default
              </button>
            </div>
          </details>
        )}

        {facts && (
          <details className="z-disclosure">
            <summary>Limits we do not set</summary>
            <div className="z-disclosure-body">
              <div className="z-rule-row">
                <span className="z-small" style={{ flex: 1 }}>
                  A search
                </span>
                <span className="z-num z-small">{money(facts.costPerQuery)}</span>
              </div>
              <div className="z-rule-row">
                <span className="z-small" style={{ flex: 1 }}>
                  A profile
                </span>
                <span className="z-num z-small">{money(facts.costPerProfile)}</span>
              </div>
              <div className="z-rule-row">
                <span className="z-small" style={{ flex: 1 }}>
                  Profiles per enrichment run, from Apify
                </span>
                <span className="z-num z-small">{facts.apifyMaxPerRun}</span>
              </div>
              <div className="z-rule-row">
                <span className="z-small" style={{ flex: 1 }}>
                  Profiles a day, per person
                </span>
                <span className="z-num z-small">{facts.dailyProfileCap}</span>
              </div>
              <div className="z-rule-row">
                <span className="z-small" style={{ flex: 1 }}>
                  Search requests an hour, 25 queries each
                </span>
                <span className="z-num z-small">{facts.hourlySearchCap}</span>
              </div>
              <p className="z-micro" style={{ marginTop: "var(--z-space-3)" }}>
                A campaign that stops names which of these it reached.
                {facts.mock ? " Enrichment is in mock mode, so it costs nothing and invents profiles." : ""}
                {!facts.enrichConfigured
                  ? " No Apify token is set, so campaigns can search but not enrich."
                  : ""}
              </p>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

/* ── Connect ────────────────────────────────────────────────────────────── */

function Connect({
  origin,
  command,
  freshToken,
  copied,
  onCopy,
  onCreate,
  busy,
  tokens,
  onRevoke,
  revoking,
}: {
  origin: string;
  command: string;
  freshToken: string | null;
  copied: boolean;
  onCopy: () => void;
  onCreate: () => void;
  busy: boolean;
  tokens: TokenRow[];
  onRevoke: (hash: string) => void;
  revoking: string | null;
}) {
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  return (
    <Card size="lg">
      <div className="z-stack" style={{ gap: "var(--z-space-5)" }}>
        {freshToken ? (
          <div className="z-stack" style={{ gap: "var(--z-space-3)" }}>
            <p className="z-small" style={{ color: "var(--z-ink)" }}>
              Run this once. The token is in it, and this is the only time it is shown.
            </p>
            {/* Monospace, against the house rule recorded on `.z-seed-input`. That
                note is about prose that should not look like code; this is a shell
                command carrying a 43-character secret, where character exactness is
                the entire point. */}
            <pre className="z-code">{command}</pre>
            <div className="z-row" style={{ gap: "var(--z-space-3)" }}>
              <button className="z-quiet is-accent" onClick={onCopy}>
                {copied ? "Copied" : "Copy command"}
              </button>
              <span className="z-micro">Then restart Claude Code and ask it what Z-Score can do.</span>
            </div>
          </div>
        ) : (
          <div className="z-stack" style={{ gap: "var(--z-space-3)" }}>
            <p className="z-small">
              Claude reaches this app over MCP at <span className="z-num">{origin}/api/mcp</span>,
              with a token that identifies you. Searching and spending count against your own caps.
            </p>
            {/* Primary only when there is nothing connected yet. With a token
                already working this is a spare-key errand, not the main road. */}
            <span className="z-row">
              {tokens.length === 0 ? (
                <Button size="sm" onClick={onCreate} disabled={busy}>
                  {busy ? "Creating" : "Create a token"}
                </Button>
              ) : (
                <button className="z-quiet is-accent" onClick={onCreate} disabled={busy}>
                  {busy ? "Creating" : "Create another token"}
                </button>
              )}
            </span>
          </div>
        )}

        {tokens.length > 0 && (
          <div className="z-stack" style={{ gap: 0 }}>
            {tokens.map((t) => (
              <div className="z-rule-row" key={t.hash}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="z-small" style={{ color: "var(--z-ink)" }}>
                    {t.label}
                  </span>
                  <span className="z-micro" style={{ display: "block" }}>
                    {t.owner}, made {when(t.createdAt)}
                    {t.lastUsedAt ? `, last used ${when(t.lastUsedAt)}` : ", never used"}
                  </span>
                </span>
                {/* Two taps, like deleting a campaign. There is no undo and no
                    way back to the same secret: recovering means minting a new
                    token and re-running the add command wherever it was used. */}
                <button
                  className="z-quiet is-bare"
                  onClick={() =>
                    confirmRevoke === t.hash ? onRevoke(t.hash) : setConfirmRevoke(t.hash)
                  }
                  onBlur={() => setConfirmRevoke(null)}
                  disabled={revoking === t.hash}
                  data-armed={confirmRevoke === t.hash || undefined}
                >
                  {revoking === t.hash
                    ? "Revoking"
                    : confirmRevoke === t.hash
                      ? "Revoke, for good"
                      : "Revoke"}
                </button>
              </div>
            ))}
          </div>
        )}

        <details className="z-disclosure">
          <summary>Another client</summary>
          <div className="z-disclosure-body">
            <p className="z-micro" style={{ marginBottom: "var(--z-space-2)" }}>
              For Claude Desktop or anything else that reads an MCP config.
            </p>
            <pre className="z-code">{`{
  "mcpServers": {
    "zscore": {
      "url": "${origin}/api/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}`}</pre>
          </div>
        </details>
      </div>
    </Card>
  );
}

/* ── One campaign ───────────────────────────────────────────────────────── */

function CampaignRow({
  c,
  mine,
  busy,
  limits,
  facts,
  open,
  report,
  meta,
  onAdvance,
  onStop,
  onReport,
  onUpdate,
  onDelete,
}: {
  c: Summary;
  mine: boolean;
  busy: boolean;
  limits: Limits | null;
  facts: Facts | null;
  open: boolean;
  report: ReportPerson[];
  meta: { ticks: { at: string; day: number; queries: number; queued: number; enriched: number; usd: number; note?: string }[]; plannedQueries: number } | null;
  onAdvance: () => void;
  onStop: () => void;
  onReport: () => void;
  onUpdate: (next: Partial<CampaignSettings>) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const live = c.status === "running";

  return (
    <div className="z-camp" data-open={open || undefined}>
      <div className="z-camp-row">
        <span style={{ minWidth: 0 }}>
          <span className="z-camp-name">
            <span className="z-camp-dot" data-live={live || undefined} aria-hidden />
            {c.name}
          </span>
          {/* One sentence about where it is. The owner is only worth a word when
              it is somebody else's campaign — on your own it is every row. */}
          <span className="z-camp-sub">
            {!mine && `${c.owner}. `}
            {c.finishedReason
              ? `${c.finishedReason[0].toUpperCase()}${c.finishedReason.slice(1)}`
              : live
                ? `Day ${c.day} of ${c.settings.days}`
                : c.day === 0
                  ? "Not started"
                  : `Stopped on day ${c.day}`}
          </span>
        </span>

        {/* One segment a day, filled for days done. Countable, and it says "this is
            a seven-day thing" without a sentence. */}
        <span className="z-camp-days" title={`Day ${c.day} of ${c.settings.days}`} aria-label={`Day ${c.day} of ${c.settings.days}`}>
          {Array.from({ length: c.settings.days }, (_, i) => (
            <span key={i} className="z-camp-day" data-done={i < c.day || undefined} />
          ))}
        </span>

        <span className="z-camp-found">
          <span className="z-num">{c.foundCount}</span> found
        </span>

        <span className="z-camp-spend z-num">
          {money(c.spentUsd)}
          {c.settings.budgetUsd > 0 && <span className="z-camp-of"> of {money(c.settings.budgetUsd)}</span>}
        </span>

        <span className="z-row" style={{ gap: "var(--z-space-2)", justifyContent: "flex-end" }}>
          {live && (
            <button className="z-quiet is-accent" onClick={onAdvance} disabled={busy}>
              {busy ? "Working" : "Advance"}
            </button>
          )}
          <button className="z-quiet is-bare" onClick={onReport}>
            {open ? "Hide" : "Report"}
          </button>
        </span>
      </div>

      {open && (
        <div className="z-camp-body">
          {report.length === 0 ? (
            <p className="z-small">Nothing found yet.</p>
          ) : (
            <div className="z-stack" style={{ gap: 0 }}>
              {report.map((p, i) => (
                <div className="z-camp-find" key={p.slug}>
                  <span className="z-camp-rank z-num">{i + 1}</span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <Link href={`/candidate/${p.slug}`} className="z-camp-person">
                      {p.name}
                    </Link>
                    <span className="z-camp-sub">{p.headline || "No headline"}</span>
                  </span>
                  <span className="z-row" style={{ gap: 4, flex: "none" }}>
                    {p.confirmed.slice(0, 2).map((t) => (
                      <Pill key={t}>{t}</Pill>
                    ))}
                  </span>
                  <span className="z-camp-score z-num">{formatSigma(p.score)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="z-row z-row-wrap" style={{ gap: "var(--z-space-3)", marginTop: "var(--z-space-4)" }}>
            {mine && limits && (
              <button className="z-quiet" onClick={() => setEditing((e) => !e)}>
                {editing ? "Done" : "Change settings"}
              </button>
            )}
            {mine && live && (
              <button className="z-quiet is-danger" onClick={onStop}>
                Stop
              </button>
            )}
            {/* Only once it has stopped, and only on a second tap. The people it
                found stay in the queue either way; what goes is the record of
                which campaign found them. */}
            {mine && !live && (
              <button
                className="z-quiet is-danger"
                onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
                onBlur={() => setConfirmDelete(false)}
                data-armed={confirmDelete || undefined}
              >
                {confirmDelete ? "Delete, for good" : "Delete"}
              </button>
            )}
            <span className="z-spacer" />
            {meta && (
              <span className="z-micro">
                {nQueries(meta.plannedQueries)} planned
              </span>
            )}
          </div>

          {editing && limits && (
            <div style={{ marginTop: "var(--z-space-4)" }}>
              <EditSettings
                limits={limits}
                facts={facts}
                initial={c.settings}
                onSave={(next) => {
                  onUpdate(next);
                  setEditing(false);
                }}
              />
            </div>
          )}

          {meta && meta.ticks.length > 0 && (
            <details className="z-disclosure" style={{ marginTop: "var(--z-space-4)" }}>
              <summary>
                Advances
                <span className="z-count">{meta.ticks.length}</span>
              </summary>
              <div className="z-disclosure-body z-stack" style={{ gap: "var(--z-space-2)" }}>
                {meta.ticks.map((t, i) => (
                  <p className="z-micro" key={i}>
                    Day {t.day}, {when(t.at)}: {nQueries(t.queries)}, {t.queued} queued,{" "}
                    {t.enriched} enriched, {money(t.usd)}.{t.note ? ` ${t.note}` : ""}
                  </p>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Settings ───────────────────────────────────────────────────────────── */

const FIELDS: { key: keyof CampaignSettings; label: string; hint: string; step: number }[] = [
  { key: "days", label: "Days", hint: "It advances once a day", step: 1 },
  { key: "searchesPerDay", label: "Searches a day", hint: "A tenth of a cent each", step: 5 },
  { key: "queuePerDay", label: "Queued a day", hint: "The best of what it finds", step: 5 },
  { key: "enrichPerDay", label: "Enriched a day", hint: "Four tenths of a cent each", step: 1 },
  { key: "budgetUsd", label: "Ceiling", hint: "It stops here", step: 1 },
  { key: "scoreBar", label: "Score bar", hint: "Optional, 0 means take the best", step: 0.5 },
];

function Settings({
  limits,
  value,
  onChange,
  facts,
}: {
  limits: Limits;
  value: CampaignSettings;
  onChange: (next: CampaignSettings) => void;
  facts: Facts | null;
}) {
  const est =
    value.days * value.searchesPerDay * (facts?.costPerQuery ?? 0.001) +
    value.days * value.enrichPerDay * (facts?.costPerProfile ?? 0.004);

  return (
    <div>
      <div className="z-set-grid">
        {FIELDS.map((f) => (
          <label className="z-set" key={f.key}>
            <span className="z-set-label">{f.label}</span>
            <input
              className="z-set-input z-num"
              type="number"
              min={limits[f.key].min}
              max={limits[f.key].max}
              step={f.step}
              value={value[f.key]}
              onChange={(e) => onChange({ ...value, [f.key]: Number(e.target.value) })}
            />
            <span className="z-set-hint">
              {f.hint}, {limits[f.key].min} to {limits[f.key].max}
            </span>
          </label>
        ))}
      </div>
      <p className="z-micro" style={{ marginTop: "var(--z-space-3)" }}>
        A full run costs about {money(est)} at most. The ceiling is what actually stops it.
      </p>
    </div>
  );
}

/** The two worth changing mid-run, without reprinting the whole form. */
function EditSettings({
  limits,
  facts,
  initial,
  onSave,
}: {
  limits: Limits;
  facts: Facts | null;
  initial: CampaignSettings;
  onSave: (next: Partial<CampaignSettings>) => void;
}) {
  const [draft, setDraft] = useState<CampaignSettings>(initial);

  // The same six fields, the same bounds, the same live estimate as the defaults
  // block. A setting you can only reach by asking Claude is the black box this
  // screen exists to not be.
  return (
    <div className="z-stack" style={{ gap: "var(--z-space-4)" }}>
      <Settings limits={limits} value={draft} onChange={setDraft} facts={facts} />
      <div className="z-row z-row-wrap" style={{ gap: "var(--z-space-3)" }}>
        <button className="z-quiet is-accent" onClick={() => onSave(draft)}>
          Save
        </button>
        <span className="z-micro">
          Takes effect on the next advance. Raising a limit a campaign stopped at puts it back to
          running.
        </span>
      </div>
    </div>
  );
}

/* ── Small helpers ──────────────────────────────────────────────────────── */

function money(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function when(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
