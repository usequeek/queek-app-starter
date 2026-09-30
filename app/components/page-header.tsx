"use client";

import * as React from "react";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";

export interface PageHeaderAction {
    label: string;
    onClick?: () => void;
    variant?: "default" | "secondary" | "outline" | "ghost" | "destructive";
    disabled?: boolean;
}

export interface PageHeaderProps {
    title: string;
    description?: string;
    primaryAction?: PageHeaderAction;
    secondaryActions?: PageHeaderAction[];
    backLabel?: string;
    onBack?: () => void;
    className?: string;
}

/**
 * PageHeader — heading plus primary/secondary actions. In an embedded Queek
 * app, mirror the same title + actions to the dashboard title bar over the
 * bridge (`queek.setTitle({ heading, primaryAction, secondaryActions })` from
 * `@usequeek/app-sdk/react`) so the page reads native inside the dashboard
 * chrome; the in-page header below still serves standalone / direct loads.
 */
export function PageHeader({
    title,
    description,
    primaryAction,
    secondaryActions = [],
    backLabel,
    onBack,
    className,
}: PageHeaderProps) {
    return (
        <div className={className}>
            {onBack ? (
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mb-1 -ml-2"
                    onClick={onBack}
                >
                    <ArrowLeft className="size-4" />
                    {backLabel ?? "Back"}
                </Button>
            ) : null}
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
                    {description ? (
                        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
                    ) : null}
                </div>
                {primaryAction || secondaryActions.length > 0 ? (
                    <div className="flex shrink-0 items-center gap-2">
                        {secondaryActions.map((action) => (
                            <Button
                                key={action.label}
                                type="button"
                                variant={action.variant ?? "outline"}
                                disabled={action.disabled}
                                onClick={action.onClick}
                            >
                                {action.label}
                            </Button>
                        ))}
                        {primaryAction ? (
                            <Button
                                type="button"
                                variant={primaryAction.variant ?? "default"}
                                disabled={primaryAction.disabled}
                                onClick={primaryAction.onClick}
                            >
                                {primaryAction.label}
                            </Button>
                        ) : null}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
