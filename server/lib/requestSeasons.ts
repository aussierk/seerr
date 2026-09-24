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

const HELD_STATUSES = [
  MediaStatus.AVAILABLE,
  MediaStatus.PARTIALLY_AVAILABLE,
  MediaStatus.PROCESSING,
];

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
