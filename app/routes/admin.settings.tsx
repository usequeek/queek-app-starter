import { type FormEvent, useEffect, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, api } from "../bridge.client.js";

/** Settings: the starter's one setting, saved onto the installation row. */
export default function AdminSettings() {
  const [greeting, setGreeting] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    api<{ greeting: string | null }>("GET", "/settings")
      .then(({ greeting }) => {
        if (!live) return;
        setGreeting(greeting ?? "");
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setNotice({
          tone: "error",
          text: error instanceof ApiError ? error.message : "Could not load settings.",
        });
      });
    return () => {
      live = false;
    };
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setNotice(null);
    try {
      const saved = await api<{ greeting: string }>("PUT", "/settings", { greeting });
      setGreeting(saved.greeting);
      // The save is confirmed with an inline notice.
      setNotice({ tone: "ok", text: "Saved." });
    } catch (error: unknown) {
      setNotice({
        tone: "error",
        text: error instanceof ApiError ? error.message : "Could not save settings.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="One setting, stored on the installation." />
      <Card>
        <CardHeader>
          <CardTitle>Greeting</CardTitle>
          <CardDescription>Logged when an order update arrives.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="greeting">Greeting</Label>
              <Input
                id="greeting"
                value={greeting}
                onChange={(event) => setGreeting(event.target.value)}
                placeholder="Hello from My App"
                maxLength={280}
                disabled={!loaded || saving}
              />
            </div>
            {notice ? (
              <p
                role={notice.tone === "error" ? "alert" : "status"}
                className={`text-sm ${notice.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
              >
                {notice.text}
              </p>
            ) : null}
            <Button type="submit" disabled={!loaded || saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
