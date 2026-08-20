"use client";

import { useState } from "react";
import { Button, Pill } from "@/components/primitives";

/**
 * One collapsed menu of options, with the team's own additions alongside.
 *
 * Lifted out of the sweep screen unchanged so the Agent screen can define a
 * campaign from the same vocabulary, with the same interaction, rather than
 * growing a second and slightly different way to pick a programme. It takes plain
 * data and callbacks and holds no state but its own draft, which is what made the
 * move a straight one.
 */
export function Category({
  label,
  builtIn,
  custom,
  selected,
  onToggle,
  onAdd,
  onRemove,
  onAll,
  onClear,
}: {
  label: string;
  builtIn: string[];
  custom: string[];
  selected: string[];
  onToggle: (option: string) => void;
  onAdd: (term: string) => void;
  onRemove: (term: string) => void;
  onAll: () => void;
  onClear: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const options = [...builtIn, ...custom];

  function commit() {
    onAdd(draft);
    setDraft("");
    setAdding(false);
  }

  return (
    <details className="z-disclosure">
      <summary>
        {label}
        <span className="z-count">
          {selected.length > 0 ? `${selected.length} selected` : options.length}
        </span>
      </summary>
      <div className="z-disclosure-body">
        <div className="z-row z-row-wrap" style={{ gap: "var(--z-space-2)" }}>
          {builtIn.map((o) => (
            <Pill key={o} as="button" active={selected.includes(o)} onClick={() => onToggle(o)}>
              {o}
            </Pill>
          ))}
          {/* Added by the team. Removable, since they own them. */}
          {custom.map((o) => (
            <span key={o} className="z-custom-term">
              <Pill as="button" active={selected.includes(o)} onClick={() => onToggle(o)}>
                {o}
              </Pill>
              <button
                className="z-custom-remove"
                onClick={() => onRemove(o)}
                aria-label={`Remove ${o}`}
                title={`Remove ${o}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>

        {adding ? (
          <div className="z-row" style={{ marginTop: "var(--z-space-3)", gap: "var(--z-space-2)" }}>
            <input
              className="z-input"
              autoFocus
              placeholder={`Add to ${label.toLowerCase()}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") {
                  setDraft("");
                  setAdding(false);
                }
              }}
              style={{ padding: "6px 10px", fontSize: "var(--z-fs-small)" }}
            />
            <Button size="sm" onClick={commit} disabled={!draft.trim()}>
              Add
            </Button>
          </div>
        ) : (
          <div className="z-row" style={{ marginTop: "var(--z-space-4)" }}>
            <button className="z-linkish" onClick={() => setAdding(true)}>
              Add your own
            </button>
            <span className="z-spacer" />
            <button className="z-linkish" onClick={onAll}>
              Select all
            </button>
            <button className="z-linkish" onClick={onClear}>
              Clear
            </button>
          </div>
        )}
      </div>
    </details>
  );
}
