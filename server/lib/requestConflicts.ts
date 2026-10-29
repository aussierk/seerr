import TheMovieDb from '@server/api/themoviedb';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { RequestConflictInfo } from '@server/interfaces/api/requestInterfaces';
import type { RequestConflict } from '@server/lib/requestSignature';
import {
  findConflictingRequests,
  getRequestSignatureOf,
} from '@server/lib/requestSignature';
import { isAnimeMedia } from '@server/lib/serviceDefaults';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In } from 'typeorm';

const toConflictInfo = ({
  request,
  differences,
  seasons,
}: RequestConflict): RequestConflictInfo => ({
  request: {
    id: request.id,
    status: request.status,
    serverId: request.serverId,
    profileId: request.profileId,
    rootFolder: request.rootFolder,
    languageProfileId: request.languageProfileId,
    requestedBy: {
      id: request.requestedBy.id,
      displayName: request.requestedBy.displayName,
    },
  },
  differences,
  ...(seasons ? { seasons } : {}),
});

// Anime series default to the server's anime folder, profile and language. When
// no server sets any of them there is nothing to tell apart, so skip the lookup
const hasAnimeDefaults = (): boolean =>
  getSettings().sonarr.some(
    (server) =>
      server.activeAnimeDirectory ||
      server.activeAnimeProfileId ||
      server.activeAnimeLanguageProfileId
  );

// What a request needs to be checked for conflicts. Any MediaRequest fits, and
// so does a request from a media's details payload given its media explicitly.
type ConflictTarget = Pick<MediaRequest, 'id' | 'status' | 'type'> & {
  media: Pick<Media, 'id' | 'tmdbId'>;
};

// Whether each pending series is anime, by media id. A series that TMDB can't
// describe is compared as a standard one rather than failing the whole list.
// `known` holds the series the caller has already looked at.
async function getAnimeSeries(
  requests: ConflictTarget[],
  known: Map<number, boolean>
): Promise<Set<number>> {
  const anime = new Set(
    [...known].filter(([, isAnime]) => isAnime).map(([mediaId]) => mediaId)
  );
  const series = new Map(
    requests
      .filter(
        (request) =>
          request.type === MediaType.TV && !known.has(request.media.id)
      )
      .map((request) => [request.media.id, request.media.tmdbId])
  );

  if (series.size === 0 || !hasAnimeDefaults()) {
    return anime;
  }

  const tmdb = new TheMovieDb();
  await Promise.all(
    [...series].map(async ([mediaId, tmdbId]) => {
      try {
        if (isAnimeMedia(await tmdb.getTvShow({ tvId: tmdbId }))) {
          anime.add(mediaId);
        }
      } catch (e) {
        logger.warn(
          'Could not look up a series to compare its request defaults',
          {
            label: 'Request Conflicts',
            tmdbId,
            errorMessage: e instanceof Error ? e.message : String(e),
          }
        );
      }
    })
  );

  return anime;
}

/**
 * The requests each pending request conflicts with. Only pending requests have
 * conflicts to resolve, so every other request is left out of the result.
 */
export async function getConflictsFor(
  requests: ConflictTarget[],
  options: { isAnime?: Map<number, boolean> } = {}
): Promise<Map<number, RequestConflictInfo[]>> {
  const conflicts = new Map<number, RequestConflictInfo[]>();
  const pending = requests.filter(
    (request) => request.status === MediaRequestStatus.PENDING
  );

  if (pending.length === 0) {
    return conflicts;
  }

  const siblings = await getRepository(MediaRequest).find({
    where: { media: { id: In(pending.map((request) => request.media.id)) } },
    relations: { requestedBy: true, seasons: true },
  });

  const animeSeries = await getAnimeSeries(
    pending,
    options.isAnime ?? new Map()
  );

  for (const request of pending) {
    // Use the reloaded copy, which always has its requester and seasons
    const target = siblings.find((sibling) => sibling.id === request.id);

    if (!target) {
      continue;
    }

    const isAnime = animeSeries.has(target.media.id);

    const found = findConflictingRequests(
      {
        id: target.id,
        requesterId: target.requestedBy.id,
        is4k: target.is4k,
        signature: getRequestSignatureOf(target, isAnime),
        seasons: target.seasons?.map((season) => season.seasonNumber),
        isAnime,
      },
      siblings.filter((sibling) => sibling.media.id === target.media.id)
    );

    conflicts.set(request.id, found.map(toConflictInfo));
  }

  return conflicts;
}

/**
 * The requests of one media with the conflicts of each pending one, for the
 * details page. Requests that are not pending get an empty list. Pass `isAnime`
 * for a series the caller has already fetched, so it is not looked up again.
 */
export async function attachConflicts<
  T extends Pick<MediaRequest, 'id' | 'status' | 'type'>,
>(
  media: Pick<Media, 'id' | 'tmdbId'>,
  requests: T[],
  options: { isAnime?: boolean } = {}
): Promise<(T & { conflicts: RequestConflictInfo[] })[]> {
  const conflicts = await getConflictsFor(
    requests.map(({ id, status, type }) => ({ id, status, type, media })),
    options.isAnime === undefined
      ? {}
      : { isAnime: new Map([[media.id, options.isAnime]]) }
  );

  return requests.map((request) => ({
    ...request,
    conflicts: conflicts.get(request.id) ?? [],
  }));
}
