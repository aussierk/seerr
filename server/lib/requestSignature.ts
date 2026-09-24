import { MediaRequestStatus, MediaType } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import {
  resolveService,
  resolveServiceDefaults,
  servicesFor,
} from '@server/lib/serviceDefaults';

export type RequestSignature = {
  serverId: number | undefined;
  profileId: number | null;
  rootFolder: string | null;
  languageProfileId: number | null;
};

export function getRequestSignature(request: {
  mediaType: MediaType;
  is4k: boolean;
  serverId?: number | null;
  profileId?: number | null;
  rootFolder?: string | null;
  languageProfileId?: number | null;
  // Anime series default to the server's anime folder, profile and language
  isAnime?: boolean;
}): RequestSignature {
  // An unknown serverId, or one for the other 4K type, is sent to the default
  // server, so that is the server the request competes on
  const { service } = resolveService(
    servicesFor(request.mediaType),
    request.is4k,
    request.serverId
  );

  // A request that doesn't pick a value gets the server default, so it must
  // compare equal to one that explicitly picked that same default
  const defaults = service
    ? resolveServiceDefaults(
        request.mediaType,
        service,
        request.isAnime ?? false
      )
    : undefined;

  return {
    serverId: service?.id,
    profileId: request.profileId ?? defaults?.profileId ?? null,
    rootFolder: request.rootFolder || defaults?.rootFolder || null,
    languageProfileId:
      request.languageProfileId ?? defaults?.languageProfileId ?? null,
  };
}

export function getRequestSignatureOf(
  request: MediaRequest,
  isAnime = false
): RequestSignature {
  return getRequestSignature({
    isAnime,
    mediaType: request.type,
    is4k: request.is4k,
    serverId: request.serverId,
    profileId: request.profileId,
    rootFolder: request.rootFolder,
    languageProfileId: request.languageProfileId,
  });
}

export function signaturesEqual(
  a: RequestSignature,
  b: RequestSignature
): boolean {
  return (
    a.serverId === b.serverId &&
    a.profileId === b.profileId &&
    a.rootFolder === b.rootFolder &&
    a.languageProfileId === b.languageProfileId
  );
}

export function describeSignatureDifferences(
  a: RequestSignature,
  b: RequestSignature
): string[] {
  const differences: string[] = [];

  if (a.profileId !== b.profileId) {
    differences.push(
      `quality profile ${a.profileId ?? 'default'} vs ${b.profileId ?? 'default'}`
    );
  }
  if (a.rootFolder !== b.rootFolder) {
    differences.push(
      `root folder ${a.rootFolder ?? 'default'} vs ${b.rootFolder ?? 'default'}`
    );
  }
  if (a.languageProfileId !== b.languageProfileId) {
    differences.push(
      `language profile ${a.languageProfileId ?? 'default'} vs ${
        b.languageProfileId ?? 'default'
      }`
    );
  }

  return differences;
}

// Declined requests are the only ones that no longer hold any settings
const isActive = (request: MediaRequest): boolean =>
  request.status !== MediaRequestStatus.DECLINED;

export type RequestConflict = {
  request: MediaRequest;
  differences: string[];
  seasons?: number[];
};

/**
 * Other users' requests for the same media and quality (4K or not) whose
 * settings differ on the target's server and cannot both be satisfied. Identical
 * settings and other servers never conflict. For series only requests that
 * share a season conflict; when seasons are not loaded on either side the
 * overlap can't be judged and the request is not treated as conflicting.
 */
export function findConflictingRequests(
  target: {
    id?: number;
    requesterId: number;
    is4k: boolean;
    signature: RequestSignature;
    seasons?: number[];
    // Must match the isAnime the target's signature was built with
    isAnime?: boolean;
  },
  siblings: MediaRequest[]
): RequestConflict[] {
  const conflicts: RequestConflict[] = [];

  for (const request of siblings) {
    if (
      request.id === target.id ||
      request.requestedBy?.id === target.requesterId ||
      request.is4k !== target.is4k ||
      !isActive(request)
    ) {
      continue;
    }

    const theirs = getRequestSignatureOf(request, target.isAnime);
    if (
      theirs.serverId !== target.signature.serverId ||
      signaturesEqual(theirs, target.signature)
    ) {
      continue;
    }

    const differences = describeSignatureDifferences(theirs, target.signature);

    if (request.type === MediaType.TV) {
      if (!target.seasons || !request.seasons) {
        continue;
      }

      const heldSeasons = request.seasons.map((season) => season.seasonNumber);
      const seasons = target.seasons.filter((sn) => heldSeasons.includes(sn));
      if (seasons.length === 0) {
        continue;
      }

      conflicts.push({ request, differences, seasons });
    } else {
      conflicts.push({ request, differences });
    }
  }

  return conflicts;
}
