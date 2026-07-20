import {
  releaseChannelFromNamespace,
  releaseChannelFromVersion,
  releaseInstallIdentity,
} from "@open-design/release";

const DEFAULT_WINDOW_TITLE = "Open Design IUX";

export function resolvePackagedWindowTitle(config: { appVersion: string | null; namespace: string }): string {
  const channel =
    releaseChannelFromVersion(config.appVersion) ??
    releaseChannelFromNamespace(config.namespace);
  if (channel == null) return DEFAULT_WINDOW_TITLE;
  return `${releaseInstallIdentity(channel).productName} IUX`;
}
