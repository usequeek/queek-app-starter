import {
  type AppTokens,
  buildInstallationRecord,
  createInstallationClient,
  type InstallationStore,
  type InstallEnvelope,
  type Logger,
} from "@usequeek/app-sdk";

export interface StarterLifecycleDeps {
  store: InstallationStore;
  /** Mints the installation tokens every Queek call goes through (S1). */
  tokens: AppTokens;
  log: Logger;
  queekFetchImpl?: typeof fetch;
}

/**
 * Install / uninstall lifecycle (importable without booting the server —
 * index.ts only wires these into Hono).
 *
 * Install saves the handoff then answers 2xx FIRST: Queek activates the
 * installation only after this handler returns 2xx, and refuses token
 * mints while it is pending (409 app_installation_pending) — so a
 * proof-call made here can never succeed. The Merchant API verification
 * (GET /store) runs right after, in the background; a failure is logged,
 * never a reason to fail the install.
 */
export function buildLifecycle(deps: StarterLifecycleDeps) {
  async function onInstall(envelope: InstallEnvelope): Promise<void> {
    const { data } = envelope;
    // Save first, then answer 2xx: GET /store through the installation
    // client runs after the handoff, in the background. Only the store
    // p_id is logged — never a token.
    const existing = await deps.store.getInstallation(data.installation.id);
    await deps.store.saveInstallation(buildInstallationRecord(data));
    const client = createInstallationClient({
      installationId: data.installation.id,
      apiBase: data.api_base,
      tokens: deps.tokens,
      fetchImpl: deps.queekFetchImpl,
    });
    setTimeout(() => {
      void client
        .getStore()
        .then((profile) => {
          const record = profile as unknown as Record<string, unknown>;
          const nested = record.data as Record<string, unknown> | undefined;
          const pid = nested?.p_id ?? record.p_id;
          deps.log.info("installed", {
            store: typeof pid === "string" ? pid : "unknown",
            installation: data.installation.p_id,
          });
        })
        .catch(() =>
          deps.log.error("post-install Merchant API check failed", {
            installation: data.installation.p_id,
          }),
        );
    }, 1_000);
    if (existing) deps.log.info("reinstalled", { installation: data.installation.p_id });
  }

  async function onUninstall(envelope: {
    data: { installation: { id: string; p_id: string } };
  }): Promise<void> {
    await deps.store.deleteInstallation(envelope.data.installation.id);
    deps.log.info("uninstalled", { installation: envelope.data.installation.p_id });
  }

  return { onInstall, onUninstall };
}
