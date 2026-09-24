import { MediaRequestStatus, MediaStatus } from '@server/constants/media';

type RequestLike = {
  is4k: boolean;
  status: MediaRequestStatus;
  requestedBy: { id: number };
};

const HELD_STATUSES = [
  MediaStatus.AVAILABLE,
  MediaStatus.PARTIALLY_AVAILABLE,
  MediaStatus.PROCESSING,
];

export function hasOwnMovieRequest({
  requests,
  mediaStatus,
  userId,
  is4k,
}: {
  requests: RequestLike[];
  mediaStatus?: MediaStatus;
  userId?: number;
  is4k: boolean;
}): boolean {
  return requests.some(
    (request) =>
      request.is4k === is4k &&
      request.requestedBy.id === userId &&
      request.status !== MediaRequestStatus.DECLINED &&
      (request.status !== MediaRequestStatus.COMPLETED ||
        (mediaStatus !== undefined && HELD_STATUSES.includes(mediaStatus)))
  );
}
