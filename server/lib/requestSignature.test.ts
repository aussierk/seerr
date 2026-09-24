import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { MediaType } from '@server/constants/media';
import {
  getRequestSignature,
  signaturesEqual,
} from '@server/lib/requestSignature';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';

function radarr(overrides: Partial<RadarrSettings> = {}): RadarrSettings {
  return {
    id: 0,
    name: 'Radarr',
    hostname: 'localhost',
    port: 7878,
    apiKey: 'test-key',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 4,
    activeProfileName: 'HD',
    activeDirectory: '/movies',
    minimumAvailability: 'released',
    tags: [],
    is4k: false,
    isDefault: false,
    syncEnabled: true,
    preventSearch: false,
    tagRequests: false,
    overrideRule: [],
    ...overrides,
  };
}

function sonarr(overrides: Partial<SonarrSettings> = {}): SonarrSettings {
  return {
    id: 0,
    name: 'Sonarr',
    hostname: 'localhost',
    port: 8989,
    apiKey: 'test-key',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 4,
    activeProfileName: 'HD',
    activeDirectory: '/tv',
    activeLanguageProfileId: 1,
    tags: [],
    is4k: false,
    isDefault: false,
    syncEnabled: true,
    preventSearch: false,
    tagRequests: false,
    overrideRule: [],
    seriesType: 'standard',
    animeSeriesType: 'anime',
    enableSeasonFolders: true,
    monitorNewItems: 'all',
    ...overrides,
  };
}

describe('getRequestSignature', () => {
  const settings = getSettings();

  beforeEach(() => {
    settings.radarr = [];
    settings.sonarr = [];
  });

  it('treats a request that picks the server defaults like one that picks nothing', () => {
    settings.radarr = [radarr({ id: 1, isDefault: true })];

    const unset = getRequestSignature({
      mediaType: MediaType.MOVIE,
      is4k: false,
    });
    const explicit = getRequestSignature({
      mediaType: MediaType.MOVIE,
      is4k: false,
      serverId: 1,
      profileId: 4,
      rootFolder: '/movies',
    });

    assert.ok(signaturesEqual(unset, explicit));
  });

  it('tells apart a request that picks a non-default profile', () => {
    settings.radarr = [radarr({ id: 1, isDefault: true })];

    const unset = getRequestSignature({
      mediaType: MediaType.MOVIE,
      is4k: false,
    });
    const other = getRequestSignature({
      mediaType: MediaType.MOVIE,
      is4k: false,
      profileId: 9,
    });

    assert.ok(!signaturesEqual(unset, other));
  });

  it('competes on the default server when the serverId is unknown', () => {
    settings.radarr = [radarr({ id: 1, isDefault: true })];

    const signature = getRequestSignature({
      mediaType: MediaType.MOVIE,
      is4k: false,
      serverId: 7,
    });

    assert.equal(signature.serverId, 1);
  });

  it('competes on the default server when the serverId is for the other 4K type', () => {
    settings.radarr = [
      radarr({ id: 1, isDefault: true }),
      radarr({ id: 2, is4k: true, isDefault: true }),
    ];

    const signature = getRequestSignature({
      mediaType: MediaType.MOVIE,
      is4k: false,
      serverId: 2,
    });

    assert.equal(signature.serverId, 1);
  });

  describe('series', () => {
    beforeEach(() => {
      settings.sonarr = [
        sonarr({
          id: 1,
          isDefault: true,
          activeAnimeDirectory: '/anime',
          activeAnimeProfileId: 8,
          activeAnimeLanguageProfileId: 3,
        }),
      ];
    });

    it('uses the anime defaults for an anime series', () => {
      const unset = getRequestSignature({
        mediaType: MediaType.TV,
        is4k: false,
        isAnime: true,
      });

      assert.equal(unset.rootFolder, '/anime');
      assert.equal(unset.profileId, 8);
      assert.equal(unset.languageProfileId, 3);
    });

    it('treats the explicit anime folder like no choice for an anime series', () => {
      const unset = getRequestSignature({
        mediaType: MediaType.TV,
        is4k: false,
        isAnime: true,
      });
      const explicit = getRequestSignature({
        mediaType: MediaType.TV,
        is4k: false,
        isAnime: true,
        rootFolder: '/anime',
      });

      assert.ok(signaturesEqual(unset, explicit));
    });

    it('keeps the standard folder as a different choice for an anime series', () => {
      const unset = getRequestSignature({
        mediaType: MediaType.TV,
        is4k: false,
        isAnime: true,
      });
      const standard = getRequestSignature({
        mediaType: MediaType.TV,
        is4k: false,
        isAnime: true,
        rootFolder: '/tv',
      });

      assert.ok(!signaturesEqual(unset, standard));
    });

    it('ignores the anime defaults for a series that is not anime', () => {
      const unset = getRequestSignature({
        mediaType: MediaType.TV,
        is4k: false,
      });

      assert.equal(unset.rootFolder, '/tv');
      assert.equal(unset.profileId, 4);
      assert.equal(unset.languageProfileId, 1);
    });
  });
});
