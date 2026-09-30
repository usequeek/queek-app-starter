"use client";

import { Inbox } from "lucide-react";
import type * as React from "react";

import { Button } from "@/components/ui/button";

export interface EmptyStateProps {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Defaults to an inbox glyph in a muted circle. */
  icon?: React.ReactNode;
  className?: string;
}

/**
 * EmptyState — the table/section empty pattern: centered icon, heading,
 * one supporting line, one primary action. All copy arrives as props (i18n).
 */
export function EmptyState({ title, description, actionLabel, onAction, icon, className }: EmptyStateProps) {
  return (
    <div
      className={
        "flex flex-col items-center justify-center rounded-md border border-dashed border-border px-6 py-12 text-center " +
        (className ?? "")
      }
    >
      <span
        aria-hidden="true"
        className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        {icon ?? <Inbox className="size-5" />}
      </span>
      <p className="mt-4 text-sm font-semibold">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {actionLabel ? (
        <Button type="button" className="mt-4" onClick={() => onAction?.()}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
