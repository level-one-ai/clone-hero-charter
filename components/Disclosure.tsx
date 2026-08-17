'use client';

import { useState } from 'react';

/**
 * A collapsed section for controls that are needed occasionally but not while charting.
 *
 * The rule this encodes: an advanced feature is not simplified by removing it, only by
 * moving it out of the way of the work. Everything the editor could do before is still
 * one click away — the difference is that the panel now opens showing the three things a
 * charter touches every session instead of the twelve they touch every project.
 *
 * Closed by default and uncontrolled, deliberately: persisting the open state would mean
 * a panel that looks different depending on what you did last week, and "where did that
 * control go" is a worse problem than one extra click.
 */
export default function Disclosure({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="border-b border-edge">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-2xs uppercase tracking-widest text-muted hover:text-fg"
      >
        <span className="font-mono text-faint">{open ? '−' : '+'}</span>
        {label}
      </button>
      {open && <div className="border-t border-edge">{children}</div>}
    </section>
  );
}
