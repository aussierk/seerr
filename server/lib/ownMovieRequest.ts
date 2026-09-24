import { MediaRequestStatus, MediaStatus } from '@server/constants/media';

type RequestLike = {
  is4k: boolean;
  status: MediaRequestStatus;
  requestedBy: { id: number };
};

/**
 * Whether a user already holds a request for a movie, so they can't make
 * another. A declined request may be superseded, and a completed one only
 * blocks while the movie is still available, so it can be requested again
 * after the media is removed.
 */
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
        mediaStatus === MediaStatus.AVAILABLE)
  );
}
