import {
  type AppTokens,
  buildInstallationRecord,
  createInstallationClient,
  type InstallationStore,
  type InstallEnvelope,
  type Logger,
  QueekApiError,
  RESYNC_EVENT,
  type ResyncEnvelope,
  saveResyncedInstallation,
} from "@usequeek/app-sdk";

/** Log fields that say why a Merchant API call failed, without echoing the message body. */
export function failureFields(error: unknown): Record<string, string | number> {
  if (error instanceof QueekApiError) {
    return {
      status: error.status,
      code: error.code,
      ...(error.requestId ? { request_id: error.requestId } : {}),
    };
  }
  return { reason: error instanceof Error ? error.name : "unknown" };
}

export interface StarterLifecycleDeps {
  store: InstallationStore;
  /** Mints the short-lived installation tokens every Queek call goes through. */
  tokens: AppTokens;
  log: Logger;
  queekFetchImpl?: typeof fetch;
}

/**
 * Install / uninstall lifecycle. Importable without booting the server, so
 * tests call it directly; `app/queek.server.ts` wires it into the SDK handlers.
 *
 * Install saves the handoff then answers 2xx FIRST: Queek activates the
 * installation only after this handler returns 2xx, and refuses token
 * mints while it is pending (409 app_installation_pending) — so a
 * proof-call made here can never succeed. The Merchant API verification
 * (GET /store) runs right after, in the background; a failure is logged,
 * never a reason to fail the install.
 */
export function buildLifecycle(deps: StarterLifecycleDeps) {
  async function onInstall(envelope: InstallEnvelope | ResyncEnvelope): Promise<void> {
    const { data } = envelope;
    // Save first, then answer 2xx: GET /store through the installation
    // client runs after the handoff, in the background. Only the store
    // p_id is logged — never a token.
    const existing = await deps.store.getInstallation(data.installation.id);
    // A resync redelivery (settings_url falling back to install_url) merges
    // into the stored row — refreshes secrets/settings/scopes but keeps
    // installedAt + the cached installation token. A fresh install (or a
    // resync for a row we never stored) writes a full new record.
    if (envelope.type === RESYNC_EVENT && existing) {
      await deps.store.saveInstallation(saveResyncedInstallation(existing, data));
    } else {
      await deps.store.saveInstallation(buildInstallationRecord(data));
    }
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
        .catch((error: unknown) =>
          deps.log.error("post-install Merchant API check failed", {
            installation: data.installation.p_id,
            ...failureFields(error),
          }),
        );
    }, 1_000);
    if (existing) {
      deps.log.info(envelope.type === RESYNC_EVENT ? "resynced" : "reinstalled", {
        installation: data.installation.p_id,
      });
    }
  }

  async function onUninstall(envelope: {
    data: { installation: { id: string; p_id: string } };
  }): Promise<void> {
    await deps.store.deleteInstallation(envelope.data.installation.id);
    deps.log.info("uninstalled", { installation: envelope.data.installation.p_id });
  }

  return { onInstall, onUninstall };
}
