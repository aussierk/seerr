import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import ExternalAPI from '@server/api/externalapi';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  DuplicateMediaRequestError,
  MediaRequest,
  NoSeasonsAvailableError,
  QuotaRestrictedError,
} from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

// get is a prototype method unlike getMovie, and replaces the cache lookup too
const externalApiGetMock = mock.method(
  ExternalAPI.prototype as unknown as {
    get: (endpoint: string) => Promise<unknown>;
  },
  'get',
  async (endpoint: string) => {
    const tmdbId = Number(endpoint.replace(/^\/(movie|tv)\//, ''));

    if (!tmdbId) {
      throw new Error(`Unstubbed external endpoint: ${endpoint}`);
    }

    return {
      id: tmdbId,
      external_ids: {},
      seasons: [1, 2, 3].map((season_number) => ({
        season_number,
        episode_count: 1,
      })),
      keywords: endpoint.startsWith('/movie')
        ? { keywords: [] }
        : { results: [] },
      // Skips getMovie's localized fallback call
      videos: { results: [{ type: 'Trailer', key: 'trailer' }] },
    };
  }
).mock;

mock.method(MediaRequest, 'sendNotification', async () => undefined);

setupTestDb();

beforeEach(() => {
  externalApiGetMock.resetCalls();
});

async function seedRequester(movieQuotaLimit: number): Promise<User> {
  const userRepository = getRepository(User);

  const requester = await userRepository.findOneOrFail({
    where: { email: 'demo@seerr.dev' },
  });
  requester.movieQuotaLimit = movieQuotaLimit;
  requester.permissions |= Permission.REQUEST_ADVANCED;

  return userRepository.save(requester);
}

async function createRequester(
  email: string,
  permissions = Permission.REQUEST | Permission.REQUEST_ADVANCED
): Promise<User> {
  return getRepository(User).save(new User({ email, permissions, avatar: '' }));
}

function requestMovies(mediaIds: number[], requester: User) {
  return Promise.allSettled(
    mediaIds.map((mediaId) =>
      MediaRequest.request(
        { mediaId, mediaType: MediaType.MOVIE, is4k: false },
        requester
      )
    )
  );
}

function rejections(results: PromiseSettledResult<MediaRequest>[]) {
  return results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
}

function configureRadarr(overrides: Partial<RadarrSettings>[]): void {
  const settings = getSettings();
  settings.radarr = overrides.map((o, i) => ({
    id: i,
    name: `Radarr ${i}`,
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
    isDefault: i === 0,
    syncEnabled: true,
    preventSearch: false,
    externalUrl: '',
    ...o,
  })) as RadarrSettings[];
  settings.sonarr = [] as SonarrSettings[];
}

describe('MediaRequest.request', () => {
  it('rejects the second of two concurrent requests at the movie quota', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(1);

    const results = await requestMovies([11111, 22222], requester);
    const rejected = rejections(results);

    assert.strictEqual(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof QuotaRestrictedError);
    assert.strictEqual(await requestRepository.count(), 1);
    assert.strictEqual(externalApiGetMock.callCount(), 1);
  });

  it('rejects a concurrent duplicate request for the same movie', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);

    const results = await requestMovies([33333, 33333], requester);
    const rejected = rejections(results);

    assert.strictEqual(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof DuplicateMediaRequestError);
    assert.strictEqual(await requestRepository.count(), 1);
    assert.strictEqual(externalApiGetMock.callCount(), 2);
  });

  it('rejects a duplicate request that omits is4k', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const body = { mediaId: 66666, mediaType: MediaType.MOVIE };

    await MediaRequest.request(body, requester);

    await assert.rejects(
      () => MediaRequest.request(body, requester),
      DuplicateMediaRequestError
    );
    assert.strictEqual(await requestRepository.count(), 1);
  });

  it('blocks a new request while the same user has a failed request', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);

    const created = await MediaRequest.request(
      { mediaId: 77777, mediaType: MediaType.MOVIE, is4k: false },
      requester
    );
    created.status = MediaRequestStatus.FAILED;
    await requestRepository.save(created);

    await assert.rejects(
      () =>
        MediaRequest.request(
          { mediaId: 77777, mediaType: MediaType.MOVIE, is4k: false },
          requester
        ),
      DuplicateMediaRequestError
    );
    assert.strictEqual(await requestRepository.count(), 1);
  });

  it('blocks a new request while the same user has an approved request', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);

    const created = await MediaRequest.request(
      { mediaId: 78888, mediaType: MediaType.MOVIE, is4k: false },
      requester
    );
    created.status = MediaRequestStatus.APPROVED;
    await requestRepository.save(created);

    await assert.rejects(
      () =>
        MediaRequest.request(
          { mediaId: 78888, mediaType: MediaType.MOVIE, is4k: false },
          requester
        ),
      DuplicateMediaRequestError
    );
    assert.strictEqual(await requestRepository.count(), 1);
  });

  it('blocks a completed own movie request only while the movie is held', async () => {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);

    const created = await MediaRequest.request(
      { mediaId: 79999, mediaType: MediaType.MOVIE, is4k: false },
      requester
    );
    created.status = MediaRequestStatus.COMPLETED;
    await requestRepository.save(created);

    const media = await mediaRepository.findOneOrFail({
      where: { tmdbId: 79999, mediaType: MediaType.MOVIE },
    });
    for (const status of [
      MediaStatus.AVAILABLE,
      MediaStatus.PARTIALLY_AVAILABLE,
      MediaStatus.PROCESSING,
    ]) {
      media.status = status;
      await mediaRepository.save(media);

      await assert.rejects(
        () =>
          MediaRequest.request(
            { mediaId: 79999, mediaType: MediaType.MOVIE, is4k: false },
            requester
          ),
        DuplicateMediaRequestError
      );
    }
    assert.strictEqual(await requestRepository.count(), 1);

    media.status = MediaStatus.DELETED;
    await mediaRepository.save(media);

    await MediaRequest.request(
      { mediaId: 79999, mediaType: MediaType.MOVIE, is4k: false },
      requester
    );
    assert.strictEqual(await requestRepository.count(), 2);
  });

  it('allows a re-request after the same user request was declined', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);

    const created = await MediaRequest.request(
      { mediaId: 80000, mediaType: MediaType.MOVIE, is4k: false },
      requester
    );
    created.status = MediaRequestStatus.DECLINED;
    await requestRepository.save(created);

    await MediaRequest.request(
      { mediaId: 80000, mediaType: MediaType.MOVIE, is4k: false },
      requester
    );
    assert.strictEqual(await requestRepository.count(), 2);
  });

  it('does not block on an approved request from another user', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester('second@seerr.dev');

    const created = await MediaRequest.request(
      { mediaId: 44444, mediaType: MediaType.MOVIE, is4k: false },
      requester
    );
    created.status = MediaRequestStatus.APPROVED;
    await requestRepository.save(created);

    await MediaRequest.request(
      { mediaId: 44444, mediaType: MediaType.MOVIE, is4k: false },
      otherRequester
    );
    assert.strictEqual(await requestRepository.count(), 2);
  });

  it('allows a concurrent duplicate request from a different user', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester('second@seerr.dev');

    const results = await Promise.allSettled(
      [requester, otherRequester].map((user) =>
        MediaRequest.request(
          { mediaId: 44444, mediaType: MediaType.MOVIE, is4k: false },
          user
        )
      )
    );
    const rejected = rejections(results);

    assert.strictEqual(rejected.length, 0);
    assert.strictEqual(await requestRepository.count(), 2);
  });

  it('allows the same server when only the tags differ', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester('second@seerr.dev');

    await MediaRequest.request(
      { mediaId: 81111, mediaType: MediaType.MOVIE, is4k: false, tags: [1] },
      requester
    );
    await MediaRequest.request(
      { mediaId: 81111, mediaType: MediaType.MOVIE, is4k: false, tags: [2] },
      otherRequester
    );

    assert.strictEqual(await requestRepository.count(), 2);
  });

  it('holds a request with different conditions for resolution instead of rejecting it', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester('second@seerr.dev');

    await MediaRequest.request(
      {
        mediaId: 45555,
        mediaType: MediaType.MOVIE,
        is4k: false,
        profileId: 7,
      },
      requester
    );
    const second = await MediaRequest.request(
      {
        mediaId: 45555,
        mediaType: MediaType.MOVIE,
        is4k: false,
        profileId: 8,
      },
      otherRequester
    );

    assert.strictEqual(await requestRepository.count(), 2);
    assert.strictEqual(second.status, MediaRequestStatus.PENDING);
  });

  it('never auto-approves a conflicting request', async () => {
    const requester = await seedRequester(5);
    const autoApprover = await createRequester(
      'auto@seerr.dev',
      Permission.REQUEST | Permission.AUTO_APPROVE | Permission.REQUEST_ADVANCED
    );

    await MediaRequest.request(
      {
        mediaId: 45556,
        mediaType: MediaType.MOVIE,
        is4k: false,
        profileId: 7,
      },
      requester
    );
    const conflicting = await MediaRequest.request(
      {
        mediaId: 45556,
        mediaType: MediaType.MOVIE,
        is4k: false,
        profileId: 8,
      },
      autoApprover
    );
    assert.strictEqual(conflicting.status, MediaRequestStatus.PENDING);
    assert.strictEqual(conflicting.modifiedBy, undefined);

    const matching = await MediaRequest.request(
      {
        mediaId: 45557,
        mediaType: MediaType.MOVIE,
        is4k: false,
        profileId: 7,
      },
      autoApprover
    );
    assert.strictEqual(matching.status, MediaRequestStatus.APPROVED);
  });

  it('conflicts with approved, completed and failed requests but not declined ones', async () => {
    const requestRepository = getRepository(MediaRequest);
    const autoApprover = await createRequester(
      'auto@seerr.dev',
      Permission.REQUEST | Permission.AUTO_APPROVE | Permission.REQUEST_ADVANCED
    );

    for (const [index, status] of [
      MediaRequestStatus.APPROVED,
      MediaRequestStatus.COMPLETED,
      MediaRequestStatus.FAILED,
      MediaRequestStatus.DECLINED,
    ].entries()) {
      const mediaId = 47000 + index;
      const other = await createRequester(`other${index}@seerr.dev`);
      const existing = await MediaRequest.request(
        { mediaId, mediaType: MediaType.MOVIE, is4k: false, profileId: 7 },
        other
      );
      existing.status = status;
      await requestRepository.save(existing);

      if (status === MediaRequestStatus.COMPLETED) {
        await getRepository(Media).update(existing.media.id, {
          status: MediaStatus.AVAILABLE,
        });
      }

      const created = await MediaRequest.request(
        { mediaId, mediaType: MediaType.MOVIE, is4k: false, profileId: 8 },
        autoApprover
      );

      if (status === MediaRequestStatus.DECLINED) {
        assert.notStrictEqual(created.status, MediaRequestStatus.PENDING);
      } else {
        assert.strictEqual(created.status, MediaRequestStatus.PENDING);
      }
    }
  });

  it('does not conflict with a completed request whose media was removed', async () => {
    const requestRepository = getRepository(MediaRequest);
    const autoApprover = await createRequester(
      'auto@seerr.dev',
      Permission.REQUEST | Permission.AUTO_APPROVE | Permission.REQUEST_ADVANCED
    );
    const other = await createRequester('other@seerr.dev');
    const mediaId = 47100;

    const existing = await MediaRequest.request(
      { mediaId, mediaType: MediaType.MOVIE, is4k: false, profileId: 7 },
      other
    );
    existing.status = MediaRequestStatus.COMPLETED;
    await requestRepository.save(existing);
    await getRepository(Media).update(existing.media.id, {
      status: MediaStatus.DELETED,
    });

    const created = await MediaRequest.request(
      { mediaId, mediaType: MediaType.MOVIE, is4k: false, profileId: 8 },
      autoApprover
    );

    assert.notStrictEqual(created.status, MediaRequestStatus.PENDING);
  });

  it('does not conflict when a default is picked explicitly', async () => {
    configureRadarr([
      { id: 0, isDefault: true, activeProfileId: 4, activeDirectory: '/m' },
    ]);
    const requester = await seedRequester(5);
    const autoApprover = await createRequester(
      'auto@seerr.dev',
      Permission.REQUEST | Permission.AUTO_APPROVE | Permission.REQUEST_ADVANCED
    );

    await MediaRequest.request(
      { mediaId: 45558, mediaType: MediaType.MOVIE, is4k: false },
      requester
    );
    const second = await MediaRequest.request(
      {
        mediaId: 45558,
        mediaType: MediaType.MOVIE,
        is4k: false,
        profileId: 4,
        rootFolder: '/m',
      },
      autoApprover
    );

    // Approved and sent on, which a configured Radarr may then fail
    assert.notStrictEqual(second.status, MediaRequestStatus.PENDING);
  });

  it('allows a different user to request a different server', async () => {
    configureRadarr([{ id: 1, isDefault: true, is4k: false }, { id: 2 }]);
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester('second@seerr.dev');

    await MediaRequest.request(
      {
        mediaId: 46666,
        mediaType: MediaType.MOVIE,
        is4k: false,
        serverId: 1,
        profileId: 7,
      },
      requester
    );
    await MediaRequest.request(
      {
        mediaId: 46666,
        mediaType: MediaType.MOVIE,
        is4k: false,
        serverId: 2,
        profileId: 8,
      },
      otherRequester
    );

    const saved = await requestRepository.find({
      where: { media: { tmdbId: 46666 } },
    });
    assert.strictEqual(saved.length, 2);
    assert.deepStrictEqual(
      saved.map((r) => r.serverId).sort((a, b) => a - b),
      [1, 2]
    );
  });

  it('lets a second user hold an overlapping season with identical conditions', async () => {
    const seasonRequestRepository = getRepository(SeasonRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester('second@seerr.dev');

    const results = await Promise.allSettled(
      [
        [requester, [1, 2]],
        [otherRequester, [2, 3]],
      ].map(([user, seasons]) =>
        MediaRequest.request(
          {
            mediaId: 55555,
            mediaType: MediaType.TV,
            seasons: seasons as number[],
            is4k: false,
          },
          user as User
        )
      )
    );

    assert.strictEqual(rejections(results).length, 0);
    assert.strictEqual(
      await seasonRequestRepository.count({ where: { seasonNumber: 2 } }),
      2
    );
    assert.strictEqual(await seasonRequestRepository.count(), 4);
  });

  it('holds a second user season request with different conditions for resolution', async () => {
    const requester = await seedRequester(5);
    const autoApprover = await createRequester(
      'auto@seerr.dev',
      Permission.REQUEST | Permission.AUTO_APPROVE | Permission.REQUEST_ADVANCED
    );

    await MediaRequest.request(
      {
        mediaId: 56666,
        mediaType: MediaType.TV,
        seasons: [1],
        is4k: false,
      },
      requester
    );
    const overlapping = await MediaRequest.request(
      {
        mediaId: 56666,
        mediaType: MediaType.TV,
        seasons: [1, 2],
        is4k: false,
        profileId: 7,
      },
      autoApprover
    );
    const disjoint = await MediaRequest.request(
      {
        mediaId: 56666,
        mediaType: MediaType.TV,
        seasons: [3],
        is4k: false,
        profileId: 9,
      },
      autoApprover
    );

    assert.strictEqual(overlapping.status, MediaRequestStatus.PENDING);
    assert.notStrictEqual(disjoint.status, MediaRequestStatus.PENDING);
  });

  it('drops the requester own seasons but keeps seasons available through others', async () => {
    const mediaRepository = getRepository(Media);
    const seasonRequestRepository = getRepository(SeasonRequest);
    const requester = await seedRequester(5);

    await MediaRequest.request(
      {
        mediaId: 57777,
        mediaType: MediaType.TV,
        seasons: [1],
        is4k: false,
      },
      requester
    );

    const media = await mediaRepository.findOneOrFail({
      where: { tmdbId: 57777, mediaType: MediaType.TV },
    });
    media.seasons = [
      new Season({
        seasonNumber: 3,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      }),
    ];
    await mediaRepository.save(media);

    const updated = await MediaRequest.request(
      {
        mediaId: 57777,
        mediaType: MediaType.TV,
        seasons: [1, 2, 3],
        is4k: false,
      },
      requester
    );
    assert.deepStrictEqual(
      updated.seasons.map((s) => s.seasonNumber),
      [2, 3]
    );

    await assert.rejects(
      () =>
        MediaRequest.request(
          {
            mediaId: 57777,
            mediaType: MediaType.TV,
            seasons: [3],
            is4k: false,
          },
          requester
        ),
      NoSeasonsAvailableError
    );

    assert.strictEqual(await seasonRequestRepository.count(), 3);
  });

  it('skips library-only seasons when every season is requested but keeps ones another user holds', async () => {
    const mediaRepository = getRepository(Media);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester('later@seerr.dev');

    await MediaRequest.request(
      { mediaId: 58888, mediaType: MediaType.TV, seasons: [3], is4k: false },
      otherRequester
    );

    const media = await mediaRepository.findOneOrFail({
      where: { tmdbId: 58888, mediaType: MediaType.TV },
    });
    media.seasons = [
      new Season({
        seasonNumber: 1,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      }),
      new Season({
        seasonNumber: 3,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      }),
    ];
    await mediaRepository.save(media);

    const created = await MediaRequest.request(
      { mediaId: 58888, mediaType: MediaType.TV, seasons: 'all', is4k: false },
      requester
    );

    // Season 1 is only in the library, season 3 is held by the other user
    assert.deepStrictEqual(
      created.seasons.map((s) => s.seasonNumber),
      [2, 3]
    );
  });

  it('does not conflict on a language profile a movie request cannot store', async () => {
    const requester = await seedRequester(5);
    const autoApprover = await createRequester(
      'auto@seerr.dev',
      Permission.REQUEST | Permission.AUTO_APPROVE | Permission.REQUEST_ADVANCED
    );

    await MediaRequest.request(
      { mediaId: 58999, mediaType: MediaType.MOVIE, is4k: false, profileId: 7 },
      requester
    );
    const created = await MediaRequest.request(
      {
        mediaId: 58999,
        mediaType: MediaType.MOVIE,
        is4k: false,
        profileId: 7,
        languageProfileId: 3,
      },
      autoApprover
    );

    assert.notStrictEqual(created.status, MediaRequestStatus.PENDING);
  });

  it('lets a second user request seasons another user already has in flight or available', async () => {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester('later@seerr.dev');

    const first = await MediaRequest.request(
      { mediaId: 58888, mediaType: MediaType.TV, seasons: [1, 2], is4k: false },
      requester
    );
    first.status = MediaRequestStatus.APPROVED;
    await requestRepository.save(first);

    const media = await mediaRepository.findOneOrFail({
      where: { tmdbId: 58888, mediaType: MediaType.TV },
    });
    media.seasons = [
      new Season({
        seasonNumber: 1,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
      }),
      new Season({
        seasonNumber: 2,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      }),
    ];
    await mediaRepository.save(media);

    const second = await MediaRequest.request(
      { mediaId: 58888, mediaType: MediaType.TV, seasons: [1, 2], is4k: false },
      otherRequester
    );
    assert.deepStrictEqual(
      second.seasons.map((s) => s.seasonNumber),
      [1, 2]
    );
  });

  it('blocks a completed own request only while its season is held', async () => {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);

    const first = await MediaRequest.request(
      { mediaId: 59999, mediaType: MediaType.TV, seasons: [1], is4k: false },
      requester
    );
    first.status = MediaRequestStatus.COMPLETED;
    await requestRepository.save(first);

    const media = await mediaRepository.findOneOrFail({
      where: { tmdbId: 59999, mediaType: MediaType.TV },
    });
    media.seasons = [
      new Season({
        seasonNumber: 1,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      }),
    ];
    await mediaRepository.save(media);

    await assert.rejects(
      () =>
        MediaRequest.request(
          {
            mediaId: 59999,
            mediaType: MediaType.TV,
            seasons: [1],
            is4k: false,
          },
          requester
        ),
      NoSeasonsAvailableError
    );

    // Partially available and processing seasons are still held
    for (const status of [
      MediaStatus.PARTIALLY_AVAILABLE,
      MediaStatus.PROCESSING,
    ]) {
      media.seasons[0].status = status;
      await getRepository(Season).save(media.seasons[0]);

      await assert.rejects(
        () =>
          MediaRequest.request(
            {
              mediaId: 59999,
              mediaType: MediaType.TV,
              seasons: [1],
              is4k: false,
            },
            requester
          ),
        NoSeasonsAvailableError
      );
    }

    media.seasons[0].status = MediaStatus.DELETED;
    await getRepository(Season).save(media.seasons[0]);

    const again = await MediaRequest.request(
      { mediaId: 59999, mediaType: MediaType.TV, seasons: [1], is4k: false },
      requester
    );
    assert.deepStrictEqual(
      again.seasons.map((s) => s.seasonNumber),
      [1]
    );
  });

  it('drops the requester own seasons from approved requests', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);

    const created = await MediaRequest.request(
      { mediaId: 82222, mediaType: MediaType.TV, seasons: [1], is4k: false },
      requester
    );
    created.status = MediaRequestStatus.APPROVED;
    await requestRepository.save(created);

    const updated = await MediaRequest.request(
      { mediaId: 82222, mediaType: MediaType.TV, seasons: [1, 2], is4k: false },
      requester
    );
    assert.deepStrictEqual(
      updated.seasons.map((s) => s.seasonNumber),
      [2]
    );
  });

  it('creates one media row for concurrent 4k and non-4k requests', async () => {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester(
      'second@seerr.dev',
      Permission.REQUEST_4K
    );

    const results = await Promise.allSettled(
      [
        [requester, false],
        [otherRequester, true],
      ].map(([user, is4k]) =>
        MediaRequest.request(
          { mediaId: 88888, mediaType: MediaType.MOVIE, is4k: is4k as boolean },
          user as User
        )
      )
    );

    assert.strictEqual(rejections(results).length, 0);
    assert.strictEqual(await requestRepository.count(), 2);
    assert.strictEqual(
      await mediaRepository.count({
        where: { tmdbId: 88888, mediaType: MediaType.MOVIE },
      }),
      1
    );
  });
});
