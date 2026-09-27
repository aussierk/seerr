import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type {
  DVRSettings,
  RadarrSettings,
  SonarrSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import type { EntityManager } from 'typeorm';

interface SubscriberWithPrivate {
  syncExistingItem: (
    entity: MediaRequest,
    api: RadarrAPI,
    server: DVRSettings,
    itemId: number,
    options: { tags: number[] }
  ) => Promise<void>;
  existingItemId: (
    entity: MediaRequest,
    media: Media,
    server: DVRSettings
  ) => number | undefined;
}

function configureRadarr(overrides: Partial<RadarrSettings> = {}): void {
  const settings = getSettings();
  settings.radarr = [
    {
      id: 0,
      name: 'Radarr 0',
      hostname: 'localhost',
      port: 7878,
      apiKey: 'test-key',
      baseUrl: '',
      useSsl: false,
      activeProfileId: 1,
      activeDirectory: '/movies',
      is4k: false,
      minimumAvailability: 'released',
      tags: [],
      tagRequests: true,
      isDefault: true,
      syncEnabled: true,
      preventSearch: false,
      externalUrl: '',
      ...overrides,
    } as RadarrSettings,
  ];
  settings.sonarr = [];
}

function buildMedia(overrides: Partial<Media> = {}): Media {
  return new Media({
    mediaType: MediaType.MOVIE,
    tmdbId: 12345,
    status: MediaStatus.AVAILABLE,
    status4k: MediaStatus.UNKNOWN,
    serviceId: 0,
    externalServiceId: 42,
    ...overrides,
  });
}

function buildEntity(media: Media): MediaRequest {
  return new MediaRequest({
    type: MediaType.MOVIE,
    status: MediaRequestStatus.APPROVED,
    media,
    requestedBy: new User({ id: 1, displayName: 'John Doe' }),
    is4k: false,
  });
}

function buildManager(media: Media): EntityManager {
  return {
    getRepository: () => ({
      findOne: async () => media,
      save: async (entity: MediaRequest) => entity,
    }),
  } as unknown as EntityManager;
}

function buildApi(): RadarrAPI {
  return new RadarrAPI({ url: 'http://localhost:7878/api/v3', apiKey: 'test' });
}

const tagSettings = (overrides: Partial<DVRSettings> = {}): DVRSettings =>
  ({
    tagRequests: true,
    hostname: 'localhost',
    port: 7878,
    ...overrides,
  }) as DVRSettings;

describe('MediaRequestSubscriber sendToRadarr with available media', () => {
  afterEach(() => mock.restoreAll());

  it('completes without tagging when the media is not tracked on the target server', async () => {
    configureRadarr();
    const media = buildMedia({ serviceId: 99 });
    const entity = buildEntity(media);
    const addTags = mock.method(
      RadarrAPI.prototype,
      'addTags',
      async () => undefined
    );

    await new MediaRequestSubscriber().sendToRadarr(
      entity,
      buildManager(media)
    );

    assert.strictEqual(entity.status, MediaRequestStatus.COMPLETED);
    assert.strictEqual(addTags.mock.callCount(), 0);
  });

  it('completes when merging tags into the existing movie fails', async () => {
    configureRadarr({ tags: [3], port: 1 });
    const media = buildMedia();
    const entity = buildEntity(media);
    const addTags = mock.method(RadarrAPI.prototype, 'addTags', async () => {
      throw new Error('connection refused');
    });

    await new MediaRequestSubscriber().sendToRadarr(
      entity,
      buildManager(media)
    );

    assert.strictEqual(entity.status, MediaRequestStatus.COMPLETED);
    assert.strictEqual(addTags.mock.callCount(), 1);
  });

  it('merges the configured server tags into the existing movie', async () => {
    configureRadarr({ tags: [3], port: 1 });
    const media = buildMedia();
    const entity = buildEntity(media);
    const addTags = mock.method(
      RadarrAPI.prototype,
      'addTags',
      async () => undefined
    );

    await new MediaRequestSubscriber().sendToRadarr(
      entity,
      buildManager(media)
    );

    assert.strictEqual(entity.status, MediaRequestStatus.COMPLETED);
    assert.strictEqual(addTags.mock.callCount(), 1);
    assert.deepStrictEqual(addTags.mock.calls[0].arguments, [42, [3]]);
  });

  it('still completes when the *arr server is unreachable', async () => {
    configureRadarr({ port: 1 });
    const media = buildMedia();
    const entity = buildEntity(media);
    const addTags = mock.method(
      RadarrAPI.prototype,
      'addTags',
      async () => undefined
    );

    await new MediaRequestSubscriber().sendToRadarr(
      entity,
      buildManager(media)
    );

    assert.strictEqual(entity.status, MediaRequestStatus.COMPLETED);
    assert.strictEqual(addTags.mock.callCount(), 0);
  });
});

describe('MediaRequestSubscriber sendToSonarr with available series', () => {
  afterEach(() => mock.restoreAll());

  function configureSonarr(overrides: Partial<SonarrSettings> = {}): void {
    const settings = getSettings();
    settings.radarr = [];
    settings.sonarr = [
      {
        id: 0,
        name: 'Sonarr 0',
        hostname: 'localhost',
        port: 1,
        apiKey: 'test-key',
        baseUrl: '',
        useSsl: false,
        activeProfileId: 1,
        activeProfileName: 'Default',
        overrideRule: [],
        activeLanguageProfileId: 1,
        activeDirectory: '/tv',
        animeTags: [9],
        is4k: false,
        enableSeasonFolders: true,
        tags: [3],
        tagRequests: true,
        isDefault: true,
        syncEnabled: true,
        preventSearch: false,
        externalUrl: '',
        seriesType: 'standard',
        monitorNewItems: 'all',
        animeSeriesType: 'anime',
        activeAnimeDirectory: '',
        activeAnimeProfileId: 0,
        activeAnimeLanguageProfileId: 0,
        ...overrides,
      } as SonarrSettings,
    ];
  }

  function buildTvEntity(media: Media): MediaRequest {
    return new MediaRequest({
      type: MediaType.TV,
      status: MediaRequestStatus.APPROVED,
      media,
      requestedBy: new User({ id: 1, displayName: 'John Doe' }),
      is4k: false,
      seasons: [],
    });
  }

  function buildTvMedia(overrides: Partial<Media> = {}): Media {
    return new Media({
      mediaType: MediaType.TV,
      tmdbId: 12345,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
      serviceId: 0,
      externalServiceId: 42,
      ...overrides,
    });
  }

  it('merges the configured server tags into the existing series', async () => {
    configureSonarr();
    const media = buildTvMedia();
    const entity = buildTvEntity(media);
    const addTags = mock.method(
      SonarrAPI.prototype,
      'addTags',
      async () => undefined
    );
    mock.method(SonarrAPI.prototype, 'getSeriesById', async () => ({
      id: 42,
      seriesType: 'standard',
    }));

    await new MediaRequestSubscriber().sendToSonarr(
      entity,
      buildManager(media)
    );

    assert.strictEqual(entity.status, MediaRequestStatus.COMPLETED);
    // The user tag lookup fails against the unreachable server, so the
    // update must carry exactly the configured server tags.
    assert.strictEqual(addTags.mock.callCount(), 1);
    assert.deepStrictEqual(addTags.mock.calls[0].arguments, [
      42,
      [3],
      { id: 42, seriesType: 'standard' },
    ]);
  });

  it('uses the anime tags for anime series', async () => {
    configureSonarr();
    const media = buildTvMedia();
    const entity = buildTvEntity(media);
    const addTags = mock.method(
      SonarrAPI.prototype,
      'addTags',
      async () => undefined
    );
    mock.method(SonarrAPI.prototype, 'getSeriesById', async () => ({
      id: 42,
      seriesType: 'anime',
    }));

    await new MediaRequestSubscriber().sendToSonarr(
      entity,
      buildManager(media)
    );

    assert.strictEqual(entity.status, MediaRequestStatus.COMPLETED);
    assert.strictEqual(addTags.mock.callCount(), 1);
    assert.deepStrictEqual(addTags.mock.calls[0].arguments, [
      42,
      [9],
      { id: 42, seriesType: 'anime' },
    ]);
  });

  it('uses the request override tags for the existing series', async () => {
    configureSonarr();
    const media = buildTvMedia();
    const entity = buildTvEntity(media);
    entity.tags = [7];
    const addTags = mock.method(
      SonarrAPI.prototype,
      'addTags',
      async () => undefined
    );
    mock.method(SonarrAPI.prototype, 'getSeriesById', async () => ({
      id: 42,
      seriesType: 'standard',
    }));

    await new MediaRequestSubscriber().sendToSonarr(
      entity,
      buildManager(media)
    );

    assert.strictEqual(addTags.mock.callCount(), 1);
    assert.deepStrictEqual(addTags.mock.calls[0].arguments[1], [7]);
  });

  it('ignores the request override tags when its server fell back to the default', async () => {
    configureSonarr();
    const media = buildTvMedia();
    const entity = buildTvEntity(media);
    entity.serverId = 99;
    entity.tags = [7];
    const addTags = mock.method(
      SonarrAPI.prototype,
      'addTags',
      async () => undefined
    );
    mock.method(SonarrAPI.prototype, 'getSeriesById', async () => ({
      id: 42,
      seriesType: 'standard',
    }));

    await new MediaRequestSubscriber().sendToSonarr(
      entity,
      buildManager(media)
    );

    assert.strictEqual(addTags.mock.callCount(), 1);
    assert.deepStrictEqual(addTags.mock.calls[0].arguments[1], [3]);
  });

  it('completes when the existing series cannot be fetched from Sonarr', async () => {
    configureSonarr();
    const media = buildTvMedia();
    const entity = buildTvEntity(media);
    const addTags = mock.method(
      SonarrAPI.prototype,
      'addTags',
      async () => undefined
    );
    mock.method(SonarrAPI.prototype, 'getSeriesById', async () => {
      throw new Error('connection refused');
    });

    await new MediaRequestSubscriber().sendToSonarr(
      entity,
      buildManager(media)
    );

    assert.strictEqual(entity.status, MediaRequestStatus.COMPLETED);
    assert.strictEqual(addTags.mock.callCount(), 0);
  });
});

describe('MediaRequestSubscriber syncExistingItem', () => {
  afterEach(() => mock.restoreAll());

  it('merges the configured tags with the existing requester tag', async () => {
    const api = buildApi();
    const addTags = mock.method(api, 'addTags', async () => undefined);
    mock.method(api, 'getTags', async () => [{ id: 5, label: '1-john doe' }]);

    const media = buildMedia();
    const entity = buildEntity(media);

    await (
      new MediaRequestSubscriber() as unknown as SubscriberWithPrivate
    ).syncExistingItem(entity, api, tagSettings(), 42, { tags: [3] });

    assert.strictEqual(addTags.mock.callCount(), 1);
    assert.deepStrictEqual(addTags.mock.calls[0].arguments, [42, [3, 5]]);
  });

  it('creates the requester tag and merges it with the configured tags', async () => {
    const api = buildApi();
    const addTags = mock.method(api, 'addTags', async () => undefined);
    mock.method(api, 'getTags', async () => []);
    const createTag = mock.method(api, 'createTag', async () => ({
      id: 7,
      label: '1-john doe',
    }));

    const media = buildMedia();
    const entity = buildEntity(media);

    await (
      new MediaRequestSubscriber() as unknown as SubscriberWithPrivate
    ).syncExistingItem(entity, api, tagSettings(), 42, { tags: [3] });

    assert.strictEqual(createTag.mock.callCount(), 1);
    assert.strictEqual(addTags.mock.callCount(), 1);
    assert.deepStrictEqual(addTags.mock.calls[0].arguments, [42, [3, 7]]);
  });

  it('does not duplicate a requester tag already in the tag set', async () => {
    const api = buildApi();
    const addTags = mock.method(api, 'addTags', async () => undefined);
    mock.method(api, 'getTags', async () => [{ id: 5, label: '1-john doe' }]);

    const media = buildMedia();
    const entity = buildEntity(media);

    await (
      new MediaRequestSubscriber() as unknown as SubscriberWithPrivate
    ).syncExistingItem(entity, api, tagSettings(), 42, { tags: [5] });

    assert.strictEqual(addTags.mock.callCount(), 1);
    assert.deepStrictEqual(addTags.mock.calls[0].arguments, [42, [5]]);
  });

  it('applies the configured tags even when the user tag lookup fails', async () => {
    const api = buildApi();
    const addTags = mock.method(api, 'addTags', async () => undefined);
    mock.method(api, 'getTags', async () => {
      throw new Error('connection refused');
    });

    const media = buildMedia();
    const entity = buildEntity(media);

    await (
      new MediaRequestSubscriber() as unknown as SubscriberWithPrivate
    ).syncExistingItem(entity, api, tagSettings(), 42, { tags: [3] });

    assert.strictEqual(addTags.mock.callCount(), 1);
    assert.deepStrictEqual(addTags.mock.calls[0].arguments, [42, [3]]);
  });

  it('skips the update when there are no tags to apply', async () => {
    const api = buildApi();
    const addTags = mock.method(api, 'addTags', async () => undefined);
    const getTags = mock.method(api, 'getTags', async () => [
      { id: 5, label: '1-john doe' },
    ]);

    const media = buildMedia();
    const entity = buildEntity(media);

    await (
      new MediaRequestSubscriber() as unknown as SubscriberWithPrivate
    ).syncExistingItem(entity, api, tagSettings({ tagRequests: false }), 42, {
      tags: [],
    });

    assert.strictEqual(addTags.mock.callCount(), 0);
    assert.strictEqual(getTags.mock.callCount(), 0);
  });

  it('swallows update failures so completion is not blocked', async () => {
    const api = buildApi();
    const addTags = mock.method(api, 'addTags', async () => {
      throw new Error('connection refused');
    });

    const media = buildMedia();
    const entity = buildEntity(media);

    await assert.doesNotReject(() =>
      (
        new MediaRequestSubscriber() as unknown as SubscriberWithPrivate
      ).syncExistingItem(entity, api, tagSettings({ tagRequests: false }), 42, {
        tags: [3],
      })
    );
    assert.strictEqual(addTags.mock.callCount(), 1);
  });
});

describe('MediaRequestSubscriber existingItemId', () => {
  const subscriber = () =>
    new MediaRequestSubscriber() as unknown as SubscriberWithPrivate;

  it('returns the external id when the media is tracked on the server', () => {
    const media = buildMedia();
    assert.strictEqual(
      subscriber().existingItemId(
        buildEntity(media),
        media,
        tagSettings({ id: 0 })
      ),
      42
    );
  });

  it('returns nothing when the media is tracked on another server', () => {
    const media = buildMedia({ serviceId: 99 });
    assert.strictEqual(
      subscriber().existingItemId(
        buildEntity(media),
        media,
        tagSettings({ id: 0 })
      ),
      undefined
    );
  });

  it('returns nothing when the media has no externalServiceId', () => {
    const media = buildMedia({ externalServiceId: null });
    assert.strictEqual(
      subscriber().existingItemId(
        buildEntity(media),
        media,
        tagSettings({ id: 0 })
      ),
      undefined
    );
  });
});
