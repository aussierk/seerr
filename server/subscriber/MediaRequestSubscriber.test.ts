import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import RadarrAPI from '@server/api/servarr/radarr';
import type { SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
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
    api: RadarrAPI | SonarrAPI,
    server: DVRSettings,
    itemId: number,
    options: {
      tags?: number[];
      existing?: SonarrSeries;
    }
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

describe('MediaRequestSubscriber sendToRadarr for a second server', () => {
  afterEach(() => {
    delete (TheMovieDb.prototype as unknown as Record<string, unknown>)
      .getMovie;
    mock.restoreAll();
  });

  const configureTwoServers = () => {
    configureRadarr({ tagRequests: false });
    const settings = getSettings();
    settings.radarr.push({ ...settings.radarr[0], id: 1, isDefault: false });
  };

  it('sends a request for another server even though the media is available on the first', async () => {
    configureTwoServers();
    const media = buildMedia({ serviceId: 0 });
    const entity = buildEntity(media);
    entity.serverId = 1;
    // getMovie is a class field, so it is stubbed through the prototype getter
    Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
      get() {
        return async () =>
          ({
            id: 12345,
            title: 'Test Movie',
            release_date: '2020-01-01',
          }) as never;
      },
      set() {},
      configurable: true,
    });
    // addMovie looks the movie up first. It never settles, so the detached
    // save of the result does not run.
    const lookup = mock.method(
      RadarrAPI.prototype,
      'getMovieByTmdbId',
      () => new Promise<never>(() => undefined)
    );

    await new MediaRequestSubscriber().sendToRadarr(
      entity,
      buildManager(media)
    );

    assert.strictEqual(lookup.mock.callCount(), 1);
    assert.strictEqual(entity.status, MediaRequestStatus.APPROVED);
  });

  it('still completes a request for the server the media is available on', async () => {
    configureTwoServers();
    const media = buildMedia({ serviceId: 1 });
    const entity = buildEntity(media);
    entity.serverId = 1;
    mock.method(RadarrAPI.prototype, 'addTags', async () => undefined);
    const lookup = mock.method(
      RadarrAPI.prototype,
      'getMovieByTmdbId',
      async () => {
        throw new Error('should not be sent');
      }
    );

    await new MediaRequestSubscriber().sendToRadarr(
      entity,
      buildManager(media)
    );

    assert.strictEqual(lookup.mock.callCount(), 0);
    assert.strictEqual(entity.status, MediaRequestStatus.COMPLETED);
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

  describe('for a second server', () => {
    afterEach(() => {
      delete (TheMovieDb.prototype as unknown as Record<string, unknown>)
        .getTvShow;
    });

    const configureTwoServers = () => {
      configureSonarr({ tagRequests: false });
      const settings = getSettings();
      settings.sonarr.push({ ...settings.sonarr[0], id: 1, isDefault: false });
    };

    it('sends a request for another server even though the series is available on the first', async () => {
      configureTwoServers();
      const media = buildTvMedia({ serviceId: 0 });
      const entity = buildTvEntity(media);
      entity.serverId = 1;
      // getTvShow is a class field, so it is stubbed through the prototype getter
      Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
        get() {
          return async () =>
            ({
              name: 'Test Series',
              external_ids: { tvdb_id: 321 },
              keywords: { results: [] },
            }) as never;
        },
        set() {},
        configurable: true,
      });
      // It never settles, so the detached save of the result does not run
      const add = mock.method(
        SonarrAPI.prototype,
        'addSeries',
        () => new Promise<never>(() => undefined)
      );

      await new MediaRequestSubscriber().sendToSonarr(
        entity,
        buildManager(media)
      );

      assert.strictEqual(add.mock.callCount(), 1);
      assert.strictEqual(entity.status, MediaRequestStatus.APPROVED);
    });

    it('still completes a request for the server the series is available on', async () => {
      configureTwoServers();
      const media = buildTvMedia({ serviceId: 1 });
      const entity = buildTvEntity(media);
      entity.serverId = 1;
      mock.method(SonarrAPI.prototype, 'addTags', async () => undefined);
      mock.method(SonarrAPI.prototype, 'getSeriesById', async () => ({
        id: 42,
        seriesType: 'standard',
        tags: [],
      }));
      const add = mock.method(SonarrAPI.prototype, 'addSeries', async () => {
        throw new Error('should not be sent');
      });

      await new MediaRequestSubscriber().sendToSonarr(
        entity,
        buildManager(media)
      );

      assert.strictEqual(add.mock.callCount(), 0);
      assert.strictEqual(entity.status, MediaRequestStatus.COMPLETED);
    });
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

describe('MediaRequestSubscriber syncExistingItem settings', () => {
  // Updating an existing item is opt-in and needs a manager's approval
  beforeEach(() => {
    getSettings().main.updateExistingItems = true;
  });
  afterEach(() => {
    getSettings().main.updateExistingItems = false;
    mock.restoreAll();
  });

  const manager = new User({ id: 2, permissions: Permission.MANAGE_REQUESTS });

  const sync = (
    entity: MediaRequest,
    api: RadarrAPI | SonarrAPI,
    existing?: SonarrSeries,
    options: {
      approver?: User | null;
      server?: Partial<DVRSettings>;
    } = {}
  ) => {
    entity.modifiedBy =
      options.approver === undefined
        ? manager
        : (options.approver ?? undefined);

    return (
      new MediaRequestSubscriber() as unknown as SubscriberWithPrivate
    ).syncExistingItem(
      entity,
      api,
      tagSettings({ id: 0, ...options.server }),
      42,
      { existing }
    );
  };

  const movieAt =
    (path: string, qualityProfileId = 1) =>
    async () =>
      ({ id: 42, path, qualityProfileId }) as never;

  it('updates only what the request sets and the movie lacks', async () => {
    const api = buildApi();
    mock.method(api, 'getMovie', movieAt('/movies/Test (2020)'));
    const update = mock.method(api, 'updateMovieSettings', async () => {});
    const entity = buildEntity(buildMedia());
    entity.profileId = 4;
    entity.rootFolder = '/other';

    await sync(entity, api);

    assert.deepStrictEqual(update.mock.calls[0].arguments, [
      42,
      { qualityProfileId: 4, rootFolderPath: '/other' },
    ]);
  });

  it('leaves the root folder alone when the movie is already in it', async () => {
    const api = buildApi();
    mock.method(api, 'getMovie', movieAt('D:\\Movies\\Test (2020)'));
    const update = mock.method(api, 'updateMovieSettings', async () => {});
    const entity = buildEntity(buildMedia());
    entity.profileId = 4;
    entity.rootFolder = 'D:/Movies/';

    await sync(entity, api);

    assert.deepStrictEqual(update.mock.calls[0].arguments, [
      42,
      { qualityProfileId: 4 },
    ]);
  });

  it('asks for no change when the request takes the server defaults', async () => {
    const api = buildApi();
    mock.method(api, 'getMovie', movieAt('/movies/Test (2020)', 7));
    const update = mock.method(api, 'updateMovieSettings', async () => {});

    await sync(buildEntity(buildMedia()), api);

    assert.deepStrictEqual(update.mock.calls[0].arguments, [42, {}]);
  });

  it('asks for no change when the movie already matches the request', async () => {
    const api = buildApi();
    mock.method(api, 'getMovie', movieAt('/movies/Test (2020)', 4));
    const update = mock.method(api, 'updateMovieSettings', async () => {});
    const entity = buildEntity(buildMedia());
    entity.profileId = 4;
    entity.rootFolder = '/movies';

    await sync(entity, api);

    assert.deepStrictEqual(update.mock.calls[0].arguments, [42, {}]);
  });

  describe('guards', () => {
    const request = () => {
      const entity = buildEntity(buildMedia());
      entity.profileId = 4;
      entity.rootFolder = '/other';
      return entity;
    };

    const stubbedApi = () => {
      const api = buildApi();
      const get = mock.method(api, 'getMovie', movieAt('/movies/Test (2020)'));
      const update = mock.method(api, 'updateMovieSettings', async () => {});
      return { api, get, update };
    };

    it('does nothing while the admin has not allowed updates', async () => {
      getSettings().main.updateExistingItems = false;
      const { api, get, update } = stubbedApi();

      await sync(request(), api);

      assert.strictEqual(get.mock.callCount(), 0);
      assert.strictEqual(update.mock.callCount(), 0);
    });

    it('does nothing when the approver is not a manager', async () => {
      const { api, update } = stubbedApi();
      const approver = new User({
        id: 3,
        permissions: Permission.REQUEST | Permission.AUTO_APPROVE,
      });

      await sync(request(), api, undefined, { approver });

      assert.strictEqual(update.mock.callCount(), 0);
    });

    it('does nothing when nobody approved the request', async () => {
      const { api, update } = stubbedApi();

      await sync(request(), api, undefined, { approver: null });

      assert.strictEqual(update.mock.callCount(), 0);
    });

    it('treats values equal to the server defaults as not chosen', async () => {
      const { api, update } = stubbedApi();
      const entity = buildEntity(buildMedia());
      entity.profileId = 7;
      entity.rootFolder = '/default/';

      await sync(entity, api, undefined, {
        server: { activeDirectory: '/default', activeProfileId: 7 },
      });

      assert.deepStrictEqual(update.mock.calls[0].arguments, [42, {}]);
    });

    it('still applies a value that is not a server default', async () => {
      const { api, update } = stubbedApi();

      await sync(request(), api, undefined, {
        server: { activeDirectory: '/default', activeProfileId: 7 },
      });

      assert.deepStrictEqual(update.mock.calls[0].arguments, [
        42,
        { qualityProfileId: 4, rootFolderPath: '/other' },
      ]);
    });

    it('treats the anime defaults of a series as not chosen', async () => {
      const api = new SonarrAPI({
        url: 'http://localhost:8989/api/v3',
        apiKey: 'test',
      });
      const update = mock.method(api, 'updateSeriesSettings', async () => {});
      const entity = buildEntity(buildMedia({ mediaType: MediaType.TV }));
      entity.type = MediaType.TV;
      entity.profileId = 8;
      entity.rootFolder = '/anime';

      await sync(
        entity,
        api,
        { id: 42, path: '/other/Show', qualityProfileId: 1 } as SonarrSeries,
        {
          server: {
            activeDirectory: '/tv',
            activeProfileId: 4,
            activeAnimeDirectory: '/anime',
            activeAnimeProfileId: 8,
          } as Partial<DVRSettings>,
        }
      );

      assert.deepStrictEqual(update.mock.calls[0].arguments, [42, {}]);
    });
  });

  it('swallows update failures so the request is not blocked', async () => {
    const api = buildApi();
    mock.method(api, 'getMovie', movieAt('/movies/Test (2020)'));
    mock.method(api, 'updateMovieSettings', async () => {
      throw new Error('connection refused');
    });
    const entity = buildEntity(buildMedia());
    entity.profileId = 4;

    await assert.doesNotReject(() => sync(entity, api));
  });

  it('swallows a failed read of the item so the request is not blocked', async () => {
    const api = buildApi();
    mock.method(api, 'getMovie', async () => {
      throw new Error('connection refused');
    });
    const update = mock.method(api, 'updateMovieSettings', async () => {});
    const entity = buildEntity(buildMedia());
    entity.profileId = 4;

    await assert.doesNotReject(() => sync(entity, api));
    assert.strictEqual(update.mock.callCount(), 0);
  });

  it('updates the language profile of a series without looking it up again', async () => {
    const api = new SonarrAPI({
      url: 'http://localhost:8989/api/v3',
      apiKey: 'test',
    });
    const get = mock.method(api, 'getSeriesById', async () => {
      throw new Error('unexpected lookup');
    });
    const update = mock.method(api, 'updateSeriesSettings', async () => {});
    const entity = buildEntity(buildMedia({ mediaType: MediaType.TV }));
    entity.languageProfileId = 3;

    await sync(entity, api, {
      id: 42,
      path: '/tv/Show',
      qualityProfileId: 1,
      languageProfileId: 1,
    } as SonarrSeries);

    assert.strictEqual(get.mock.callCount(), 0);
    assert.deepStrictEqual(update.mock.calls[0].arguments, [
      42,
      { languageProfileId: 3 },
    ]);
  });

  it('is applied when approved media is already available', async () => {
    configureRadarr({ tags: [], tagRequests: false });
    const media = buildMedia();
    const entity = buildEntity(media);
    entity.profileId = 4;
    mock.method(RadarrAPI.prototype, 'addTags', async () => undefined);
    const sync = mock.method(
      MediaRequestSubscriber.prototype as unknown as SubscriberWithPrivate,
      'syncExistingItem',
      async () => {}
    );

    await new MediaRequestSubscriber().sendToRadarr(
      entity,
      buildManager(media)
    );

    assert.strictEqual(entity.status, MediaRequestStatus.COMPLETED);
    assert.strictEqual(sync.mock.callCount(), 1);
  });

  it('completes when the item cannot be read from an unreachable Radarr', async () => {
    configureRadarr({ tags: [], tagRequests: false, port: 1 });
    const media = buildMedia();
    const entity = buildEntity(media);
    entity.profileId = 4;
    mock.method(RadarrAPI.prototype, 'addTags', async () => undefined);

    await new MediaRequestSubscriber().sendToRadarr(
      entity,
      buildManager(media)
    );

    assert.strictEqual(entity.status, MediaRequestStatus.COMPLETED);
  });
});

// The whole flow for a title that is already in Radarr: what really reaches it
describe('MediaRequestSubscriber sendToRadarr updating an existing movie', () => {
  const stubMovie = () =>
    Object.defineProperty(RadarrAPI.prototype, 'getMovie', {
      get() {
        return async () =>
          ({
            id: 42,
            path: '/elsewhere/Test (2020)',
            qualityProfileId: 7,
          }) as never;
      },
      set() {},
      configurable: true,
    });

  const approvedBy = (media: Media, approver?: User): MediaRequest => {
    const entity = buildEntity(media);
    entity.modifiedBy = approver;
    return entity;
  };

  const manager = new User({ id: 2, permissions: Permission.MANAGE_REQUESTS });
  const autoApprover = new User({
    id: 1,
    permissions: Permission.REQUEST | Permission.AUTO_APPROVE,
  });

  beforeEach(() => {
    configureRadarr({
      tags: [],
      tagRequests: false,
      activeDirectory: '/movies',
      activeProfileId: 1,
    });
    stubMovie();
    mock.method(RadarrAPI.prototype, 'addTags', async () => undefined);
    getSettings().main.updateExistingItems = true;
  });
  afterEach(() => {
    delete (RadarrAPI.prototype as unknown as Record<string, unknown>).getMovie;
    getSettings().main.updateExistingItems = false;
    mock.restoreAll();
  });

  const send = async (entity: MediaRequest, media: Media) => {
    const update = mock.method(
      RadarrAPI.prototype,
      'updateMovieSettings',
      async () => {}
    );
    await new MediaRequestSubscriber().sendToRadarr(
      entity,
      buildManager(media)
    );
    assert.strictEqual(entity.status, MediaRequestStatus.COMPLETED);
    return update;
  };

  it('moves nothing while the admin has not allowed updates', async () => {
    getSettings().main.updateExistingItems = false;
    const media = buildMedia();
    const entity = approvedBy(media, manager);
    entity.profileId = 4;
    entity.rootFolder = '/other';

    const update = await send(entity, media);

    assert.strictEqual(update.mock.callCount(), 0);
  });

  it('moves nothing for a request that was auto-approved', async () => {
    const media = buildMedia();
    const entity = approvedBy(media, autoApprover);
    entity.profileId = 4;
    entity.rootFolder = '/other';

    const update = await send(entity, media);

    assert.strictEqual(update.mock.callCount(), 0);
  });

  it('moves nothing for the folder and profile an untouched form pre-fills', async () => {
    const media = buildMedia();
    const entity = approvedBy(media, manager);
    entity.profileId = 1;
    entity.rootFolder = '/movies';

    const update = await send(entity, media);

    assert.deepStrictEqual(update.mock.calls[0].arguments, [42, {}]);
  });

  it('applies the folder and profile a manager approved', async () => {
    const media = buildMedia();
    const entity = approvedBy(media, manager);
    entity.profileId = 4;
    entity.rootFolder = '/other';

    const update = await send(entity, media);

    assert.deepStrictEqual(update.mock.calls[0].arguments, [
      42,
      { qualityProfileId: 4, rootFolderPath: '/other' },
    ]);
  });
});
