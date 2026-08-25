import { MediaRequestStatus } from '@server/constants/media';

export function isRequestStillBlocking({
  requestStatus,
  isOwnRequest,
  targetAvailable,
}: {
  requestStatus: MediaRequestStatus;
  isOwnRequest: boolean;
  targetAvailable: boolean;
}): boolean {
  if (requestStatus === MediaRequestStatus.DECLINED) {
    return false;
  }
  if (requestStatus === MediaRequestStatus.COMPLETED) {
    return isOwnRequest && targetAvailable;
  }
  return isOwnRequest || !targetAvailable;
}

export function isSeasonNumberRequestable(
  seasonNumber: number,
  enableSpecialEpisodes: boolean
): boolean {
  return enableSpecialEpisodes || seasonNumber !== 0;
}
