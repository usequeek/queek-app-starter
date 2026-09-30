import { useEffect, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError, api } from "../bridge.client.js";

interface StorePayload {
  p_id?: string;
  name?: string;
  data?: { p_id?: string; name?: string };
}

type State =
  | { status: "loading" }
  | { status: "ready"; pid: string; name: string }
  | { status: "empty" }
  | { status: "error"; message: string };

/** Home: the store this app is installed on — the one Merchant API call. */
export default function AdminHome() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let live = true;
    api<{ store: StorePayload }>("GET", "/store")
      .then(({ store }) => {
        if (!live) return;
        const pid = store.data?.p_id ?? store.p_id;
        if (typeof pid !== "string" || pid === "") {
          setState({ status: "empty" });
          return;
        }
        setState({ status: "ready", pid, name: String(store.data?.name ?? store.name ?? "") });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setState({
          status: "error",
          message: error instanceof ApiError ? error.message : "Queek did not answer. Try again.",
        });
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader title="Home" description="What your app does, in one sentence." />
      {state.status === "loading" ? (
        <Card aria-busy="true">
          <CardHeader>
            <CardTitle>Store</CardTitle>
            <CardDescription>Loading…</CardDescription>
          </CardHeader>
        </Card>
      ) : null}
      {state.status === "ready" ? (
        <Card>
          <CardHeader>
            <CardTitle>Store</CardTitle>
            <CardDescription>The store this app is installed on.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p className="font-medium">{state.name || "Unnamed store"}</p>
            <p className="font-mono text-xs text-muted-foreground">{state.pid}</p>
          </CardContent>
        </Card>
      ) : null}
      {state.status === "empty" ? (
        <EmptyState
          title="No store found"
          description="The Merchant API answered without a store. Reinstall the app, then reload."
        />
      ) : null}
      {state.status === "error" ? (
        <EmptyState title="Queek did not answer" description={state.message} />
      ) : null}
    </div>
  );
}
