import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { MediaType } from '@server/constants/media';
import resolveRequestRoute from '@server/lib/resolveRequestRoute';
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
    activeProfileId: 1,
    activeProfileName: 'Default',
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
    activeProfileId: 1,
    activeProfileName: 'Default',
    activeDirectory: '/tv',
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

describe('resolveRequestRoute', () => {
  const settings = getSettings();

  beforeEach(() => {
    settings.radarr = [];
    settings.sonarr = [];
  });

  it('returns an explicit configured server even when it is not the default', () => {
    settings.radarr = [radarr({ id: 1, isDefault: true }), radarr({ id: 2 })];

    assert.equal(
      resolveRequestRoute({
        mediaType: MediaType.MOVIE,
        is4k: false,
        serverId: 2,
      }),
      2
    );
  });

  it('returns an explicit configured sonarr server for tv requests', () => {
    settings.sonarr = [sonarr({ id: 1, isDefault: true }), sonarr({ id: 2 })];

    assert.equal(
      resolveRequestRoute({
        mediaType: MediaType.TV,
        is4k: false,
        serverId: 2,
      }),
      2
    );
  });

  it('treats serverId 0 as an explicit server', () => {
    settings.radarr = [radarr({ id: 0 }), radarr({ id: 1, isDefault: true })];

    assert.equal(
      resolveRequestRoute({
        mediaType: MediaType.MOVIE,
        is4k: false,
        serverId: 0,
      }),
      0
    );
  });

  it('returns undefined for an explicit server that is no longer configured', () => {
    settings.radarr = [radarr({ id: 1, isDefault: true })];

    assert.equal(
      resolveRequestRoute({
        mediaType: MediaType.MOVIE,
        is4k: false,
        serverId: 99,
      }),
      undefined
    );
  });

  it('does not resolve a tv server id against the radarr list', () => {
    settings.radarr = [radarr({ id: 5, isDefault: true })];
    settings.sonarr = [sonarr({ id: 1, isDefault: true })];

    assert.equal(
      resolveRequestRoute({
        mediaType: MediaType.TV,
        is4k: false,
        serverId: 5,
      }),
      undefined
    );
  });

  it('does not resolve a movie server id against the sonarr list', () => {
    settings.radarr = [radarr({ id: 1, isDefault: true })];
    settings.sonarr = [sonarr({ id: 5, isDefault: true })];

    assert.equal(
      resolveRequestRoute({
        mediaType: MediaType.MOVIE,
        is4k: false,
        serverId: 5,
      }),
      undefined
    );
  });

  it('falls back to the default server when serverId is undefined', () => {
    settings.radarr = [radarr({ id: 1, isDefault: true }), radarr({ id: 2 })];

    assert.equal(
      resolveRequestRoute({ mediaType: MediaType.MOVIE, is4k: false }),
      1
    );
  });

  it('treats a null serverId the same as an omitted one', () => {
    settings.sonarr = [sonarr({ id: 1, isDefault: true }), sonarr({ id: 2 })];

    assert.equal(
      resolveRequestRoute({
        mediaType: MediaType.TV,
        is4k: false,
        serverId: null,
      }),
      1
    );
  });

  it('uses the 4k default for 4k requests', () => {
    settings.radarr = [
      radarr({ id: 1, isDefault: true, is4k: false }),
      radarr({ id: 2, isDefault: true, is4k: true }),
    ];

    assert.equal(
      resolveRequestRoute({ mediaType: MediaType.MOVIE, is4k: true }),
      2
    );
    assert.equal(
      resolveRequestRoute({ mediaType: MediaType.MOVIE, is4k: false }),
      1
    );
  });

  it('returns undefined when no default matches the 4k tier', () => {
    settings.radarr = [radarr({ id: 2, isDefault: true, is4k: true })];

    assert.equal(
      resolveRequestRoute({ mediaType: MediaType.MOVIE, is4k: false }),
      undefined
    );
  });

  it('returns undefined when no servers are configured', () => {
    assert.equal(
      resolveRequestRoute({ mediaType: MediaType.MOVIE, is4k: false }),
      undefined
    );
    assert.equal(
      resolveRequestRoute({ mediaType: MediaType.TV, is4k: true }),
      undefined
    );
  });
});
