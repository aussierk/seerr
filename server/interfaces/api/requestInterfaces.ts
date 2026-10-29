import type { MediaRequestStatus, MediaType } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties, PaginatedResponse } from './common';

// Another user's request that cannot be satisfied together with a pending one.
// Only shown to users who manage requests, since it reveals other users' settings.
export type RequestConflictInfo = {
  request: Pick<
    MediaRequest,
    'id' | 'serverId' | 'profileId' | 'rootFolder' | 'languageProfileId'
  > & {
    status: MediaRequestStatus;
    requestedBy: { id: number; displayName: string };
  };
  differences: string[];
  seasons?: number[];
};

// A request as a manager sees it: with the requests it conflicts with, when it
// is pending
export type MediaRequestWithConflicts = MediaRequest & {
  conflicts?: RequestConflictInfo[];
};

export interface RequestResultsResponse extends PaginatedResponse {
  results: (NonFunctionProperties<MediaRequest> & {
    profileName?: string;
    canRemove?: boolean;
    conflicts?: RequestConflictInfo[];
  })[];
  serviceErrors: {
    radarr: { id: number; name: string }[];
    sonarr: { id: number; name: string }[];
  };
}

export type MediaRequestBody = {
  mediaType: MediaType;
  mediaId: number;
  tvdbId?: number;
  seasons?: number[] | 'all';
  is4k?: boolean;
  serverId?: number;
  profileId?: number;
  profileName?: string;
  rootFolder?: string;
  languageProfileId?: number;
  userId?: number;
  tags?: number[];
  ignoreQuota?: boolean;
};
