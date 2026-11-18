import { MediaType } from '@server/constants/media';
import type { DVRSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';

export type ResolveRequestRouteArgs = {
  mediaType: MediaType;
  is4k: boolean;
  serverId?: number | null;
};

function resolveRequestRoute({
  mediaType,
  is4k,
  serverId,
}: ResolveRequestRouteArgs): number | undefined {
  const settings = getSettings();
  const servers: DVRSettings[] =
    mediaType === MediaType.MOVIE ? settings.radarr : settings.sonarr;

  if (serverId !== null && serverId !== undefined && serverId >= 0) {
    return servers.some((server) => server.id === serverId)
      ? serverId
      : undefined;
  }

  return servers.find((server) => server.isDefault && server.is4k === is4k)?.id;
}

export default resolveRequestRoute;
