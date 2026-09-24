import { MediaRequestStatus, MediaStatus } from '@server/constants/media';

type RequestLike = {
  id?: number;
  is4k: boolean;
  status: MediaRequestStatus;
  requestedBy: { id: number };
  seasons?: { seasonNumber: number }[];
};

type SeasonLike = {
  seasonNumber: number;
  status: MediaStatus;
  status4k: MediaStatus;
};

// A season in any of these states still has its content, or is getting it
const HELD_STATUSES = [
  MediaStatus.AVAILABLE,
  MediaStatus.PARTIALLY_AVAILABLE,
  MediaStatus.PROCESSING,
];

/**
 * Seasons a user cannot request again because they already hold them. Only the
 * user's own requests block: another user's request or availability on the
 * server does not, so a second user can still request the season (and have
 * their tags applied). A completed request only blocks while the season is
 * still available, partially available or processing, so it can be requested
 * again after the media is removed.
 */
export function getOwnBlockedSeasons({
  requests,
  seasons,
  userId,
  is4k,
  ignoreRequestId,
}: {
  requests: RequestLike[];
  seasons: SeasonLike[];
  userId?: number;
  is4k: boolean;
  ignoreRequestId?: number;
}): number[] {
  const statusKey = is4k ? 'status4k' : 'status';
  const heldSeasons = new Set(
    seasons
      .filter((season) => HELD_STATUSES.includes(season[statusKey]))
      .map((season) => season.seasonNumber)
  );

  return requests
    .filter(
      (request) =>
        request.is4k === is4k &&
        request.requestedBy.id === userId &&
        request.status !== MediaRequestStatus.DECLINED &&
        request.id !== ignoreRequestId
    )
    .flatMap((request) =>
      (request.seasons ?? [])
        .map((season) => season.seasonNumber)
        .filter(
          (seasonNumber) =>
            request.status !== MediaRequestStatus.COMPLETED ||
            heldSeasons.has(seasonNumber)
        )
    );
}
