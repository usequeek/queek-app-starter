import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, api } from "@/lib/api";

interface SettingsResponse {
  greeting: string | null;
}

interface StoreResponse {
  store: {
    data?: { p_id?: string; name?: string };
    p_id?: string;
    name?: string;
  };
}

function storeName(store: StoreResponse["store"]): string {
  if (typeof store.name === "string") return store.name;
  if (typeof store.data?.name === "string") return store.data.name;
  return "your store";
}

function storePid(store: StoreResponse["store"]): string {
  if (typeof store.p_id === "string") return store.p_id;
  if (typeof store.data?.p_id === "string") return store.data.p_id;
  return "unknown";
}

function useSettings() {
  const [greeting, setGreeting] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    api<SettingsResponse>("GET", "/settings")
      .then((data) => {
        if (!cancelled) {
          setGreeting(data.greeting ?? "");
          setError(null);
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "Could not load settings.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return { greeting, setGreeting, error, loading };
}

export function HomePage() {
  const settings = useSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [store, setStore] = useState<StoreResponse["store"] | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [storeLoading, setStoreLoading] = useState(true);

  const value = draft ?? settings.greeting;

  const loadStore = useCallback(() => {
    setStoreLoading(true);
    api<StoreResponse>("GET", "/store")
      .then((data) => {
        setStore(data.store);
        setStoreError(null);
      })
      .catch((failure: unknown) => {
        setStoreError(failure instanceof Error ? failure.message : "Queek did not answer.");
      })
      .finally(() => setStoreLoading(false));
  }, []);

  useEffect(() => {
    loadStore();
  }, [loadStore]);

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setNotice(null);
    try {
      const saved = await api<SettingsResponse>("PUT", "/settings", { greeting: value });
      settings.setGreeting(saved.greeting ?? "");
      setDraft(null);
      setNotice("Greeting saved.");
    } catch (failure) {
      setNotice(failure instanceof ApiError ? failure.message : "Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="My App"
        description="One settings field and one Merchant API call — the smallest embedded admin."
      />

      {settings.loading ? (
        <div className="space-y-3" role="status" aria-label="Loading">
          <div className="h-5 w-40 animate-pulse rounded bg-muted" />
          <div className="h-9 animate-pulse rounded-md bg-muted" />
        </div>
      ) : settings.error ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-card px-4 py-3 text-sm">
          {settings.error}
        </p>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Settings</CardTitle>
            <CardDescription>The greeting logged when an order update arrives.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSave} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="greeting">Greeting</Label>
                <Input
                  id="greeting"
                  value={value}
                  maxLength={280}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Hello, Suya Spots"
                />
              </div>
              <div className="flex items-center gap-3">
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </Button>
                {notice ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    {notice}
                  </p>
                ) : null}
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Merchant API</CardTitle>
          <CardDescription>
            The example call: this install's store profile, fetched server-side with a short-lived
            installation token.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {storeLoading ? (
            <div
              className="h-16 animate-pulse rounded-md bg-muted"
              role="status"
              aria-label="Loading store"
            />
          ) : store ? (
            <p className="text-sm">
              Connected to <span className="font-semibold">{storeName(store)}</span>{" "}
              <span className="text-muted-foreground">({storePid(store)})</span>.
            </p>
          ) : (
            <EmptyState
              title="No store profile yet"
              description={storeError ?? "Install the app on a store first, then retry."}
              actionLabel="Retry"
              onAction={loadStore}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
