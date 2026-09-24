import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
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
  isAnime?: boolean;
}): RequestSignature {
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

const HELD_MEDIA_STATUSES = [
  MediaStatus.AVAILABLE,
  MediaStatus.PARTIALLY_AVAILABLE,
  MediaStatus.PROCESSING,
];

const isActive = (request: MediaRequest, mediaStatus?: MediaStatus): boolean =>
  request.status !== MediaRequestStatus.DECLINED &&
  (request.status !== MediaRequestStatus.COMPLETED ||
    mediaStatus === undefined ||
    HELD_MEDIA_STATUSES.includes(mediaStatus));

export type RequestConflict = {
  request: MediaRequest;
  differences: string[];
  seasons?: number[];
};

export function findConflictingRequests(
  target: {
    id?: number;
    requesterId: number;
    is4k: boolean;
    signature: RequestSignature;
    seasons?: number[];
    isAnime?: boolean;
    mediaStatus?: MediaStatus;
  },
  siblings: MediaRequest[]
): RequestConflict[] {
  const conflicts: RequestConflict[] = [];

  for (const request of siblings) {
    if (
      request.id === target.id ||
      request.requestedBy?.id === target.requesterId ||
      request.is4k !== target.is4k ||
      !isActive(request, target.mediaStatus)
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
