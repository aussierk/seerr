import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import ExternalAPI from '@server/api/externalapi';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { getConflictsFor } from '@server/lib/requestConflicts';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

mock.method(MediaRequest, 'sendNotification', async () => undefined);

const animeSeries = new Set<number>();
const failingSeries = new Set<number>();

// get is a prototype method unlike getTvShow, and replaces the cache lookup too
const externalApiGetMock = mock.method(
  ExternalAPI.prototype as unknown as {
    get: (endpoint: string) => Promise<unknown>;
  },
  'get',
  async (endpoint: string) => {
    const tmdbId = Number(endpoint.replace(/^\/tv\//, ''));

    if (!tmdbId || failingSeries.has(tmdbId)) {
      throw new Error(`Unstubbed external endpoint: ${endpoint}`);
    }

    return {
      id: tmdbId,
      external_ids: {},
      seasons: [],
      keywords: {
        results: animeSeries.has(tmdbId) ? [{ id: ANIME_KEYWORD_ID }] : [],
      },
      // Skips getTvShow's localized fallback call
      videos: { results: [{ type: 'Trailer', key: 'trailer' }] },
    };
  }
).mock;

setupTestDb();

async function seed(
  type: MediaType,
  tmdbId: number,
  requests: {
    email: string;
    profileId: number;
    rootFolder?: string;
    status?: MediaRequestStatus;
    serverId?: number;
    seasons?: number[];
  }[]
): Promise<MediaRequest[]> {
  const media = await getRepository(Media).save(
    new Media({
      mediaType: type,
      tmdbId,
      status: MediaStatus.PENDING,
      status4k: MediaStatus.UNKNOWN,
    })
  );

  const created: MediaRequest[] = [];
  for (const entry of requests) {
    const requestedBy = await getRepository(User).findOneOrFail({
      where: { email: entry.email },
    });
    created.push(
      await getRepository(MediaRequest).save(
        new MediaRequest({
          type,
          status: entry.status ?? MediaRequestStatus.PENDING,
          media,
          requestedBy,
          is4k: false,
          profileId: entry.profileId,
          rootFolder: entry.rootFolder,
          serverId: entry.serverId,
          seasons: entry.seasons?.map(
            (seasonNumber) =>
              new SeasonRequest({
                seasonNumber,
                status: MediaRequestStatus.PENDING,
              })
          ),
        })
      )
    );
  }
  return created;
}

const load = (ids: number[]) =>
  Promise.all(
    ids.map((id) =>
      getRepository(MediaRequest).findOneOrFail({ where: { id } })
    )
  );

describe('getConflictsFor', () => {
  it('reports a conflict on both pending requests', async () => {
    const [a, b] = await seed(MediaType.MOVIE, 1, [
      { email: 'demo@seerr.dev', profileId: 4 },
      { email: 'admin@seerr.dev', profileId: 5 },
    ]);

    const conflicts = await getConflictsFor(await load([a.id, b.id]));

    assert.deepStrictEqual(
      conflicts.get(a.id)?.map((c) => c.request.id),
      [b.id]
    );
    assert.deepStrictEqual(
      conflicts.get(b.id)?.map((c) => c.request.id),
      [a.id]
    );
    assert.strictEqual(conflicts.get(a.id)?.[0].request.profileId, 5);
    assert.strictEqual(
      conflicts.get(a.id)?.[0].request.requestedBy.displayName,
      b.requestedBy.displayName
    );
  });

  it('leaves requests that are not pending out of the result', async () => {
    const [a, b] = await seed(MediaType.MOVIE, 2, [
      { email: 'demo@seerr.dev', profileId: 4 },
      {
        email: 'admin@seerr.dev',
        profileId: 5,
        status: MediaRequestStatus.COMPLETED,
      },
    ]);

    const conflicts = await getConflictsFor(await load([a.id, b.id]));

    assert.strictEqual(conflicts.get(a.id)?.length, 1);
    assert.ok(!conflicts.has(b.id));
  });

  it('ignores declined requests and requests with the same settings', async () => {
    const [a] = await seed(MediaType.MOVIE, 3, [
      { email: 'demo@seerr.dev', profileId: 4 },
      {
        email: 'admin@seerr.dev',
        profileId: 5,
        status: MediaRequestStatus.DECLINED,
      },
    ]);
    const [c] = await seed(MediaType.MOVIE, 4, [
      { email: 'demo@seerr.dev', profileId: 4 },
      { email: 'admin@seerr.dev', profileId: 4 },
    ]);

    const conflicts = await getConflictsFor(await load([a.id, c.id]));

    assert.deepStrictEqual(conflicts.get(a.id), []);
    assert.deepStrictEqual(conflicts.get(c.id), []);
  });

  it('ignores requests on another server', async () => {
    getSettings().radarr = [1, 2].map((id) => ({
      id,
      name: `Radarr ${id}`,
      is4k: false,
      isDefault: id === 1,
    })) as RadarrSettings[];
    const [a] = await seed(MediaType.MOVIE, 5, [
      { email: 'demo@seerr.dev', profileId: 4, serverId: 1 },
      { email: 'admin@seerr.dev', profileId: 5, serverId: 2 },
    ]);

    const conflicts = await getConflictsFor(await load([a.id]));

    assert.deepStrictEqual(conflicts.get(a.id), []);
  });

  it('only conflicts a series on the seasons both requests hold', async () => {
    const [a, b, c] = await seed(MediaType.TV, 6, [
      { email: 'demo@seerr.dev', profileId: 4, seasons: [1, 2] },
      { email: 'admin@seerr.dev', profileId: 5, seasons: [2, 3] },
      { email: 'admin@seerr.dev', profileId: 6, seasons: [5] },
    ]);

    const conflicts = await getConflictsFor(await load([a.id, c.id]));

    assert.deepStrictEqual(
      conflicts
        .get(a.id)
        ?.map((conflict) => [conflict.request.id, conflict.seasons]),
      [[b.id, [2]]]
    );
    assert.deepStrictEqual(conflicts.get(c.id), []);
  });

  it('does not query anything when no request is pending', async () => {
    const [a] = await seed(MediaType.MOVIE, 7, [
      {
        email: 'demo@seerr.dev',
        profileId: 4,
        status: MediaRequestStatus.COMPLETED,
      },
    ]);

    const conflicts = await getConflictsFor(await load([a.id]));

    assert.strictEqual(conflicts.size, 0);
  });

  describe('anime series', () => {
    beforeEach(() => {
      externalApiGetMock.resetCalls();
      animeSeries.clear();
      failingSeries.clear();
      getSettings().sonarr = [
        {
          id: 1,
          name: 'Sonarr',
          is4k: false,
          isDefault: true,
          activeProfileId: 4,
          activeDirectory: '/tv',
          activeAnimeDirectory: '/anime',
        },
      ] as SonarrSettings[];
    });

    it('treats a blank folder like the anime folder for an anime series', async () => {
      animeSeries.add(11);
      const [a, b] = await seed(MediaType.TV, 11, [
        { email: 'demo@seerr.dev', profileId: 4, seasons: [1] },
        {
          email: 'admin@seerr.dev',
          profileId: 4,
          rootFolder: '/anime',
          seasons: [1],
        },
      ]);

      const conflicts = await getConflictsFor(await load([a.id, b.id]));

      assert.deepStrictEqual(conflicts.get(a.id), []);
      assert.deepStrictEqual(conflicts.get(b.id), []);
    });

    it('still conflicts when the other request picks the standard folder', async () => {
      animeSeries.add(12);
      const [a, b] = await seed(MediaType.TV, 12, [
        { email: 'demo@seerr.dev', profileId: 4, seasons: [1] },
        {
          email: 'admin@seerr.dev',
          profileId: 4,
          rootFolder: '/tv',
          seasons: [1],
        },
      ]);

      const conflicts = await getConflictsFor(await load([a.id, b.id]));

      assert.deepStrictEqual(
        conflicts.get(a.id)?.map((c) => c.request.id),
        [b.id]
      );
    });

    it('compares a series that is not anime against the standard folder', async () => {
      const [a, b] = await seed(MediaType.TV, 13, [
        { email: 'demo@seerr.dev', profileId: 4, seasons: [1] },
        {
          email: 'admin@seerr.dev',
          profileId: 4,
          rootFolder: '/anime',
          seasons: [1],
        },
      ]);

      const conflicts = await getConflictsFor(await load([a.id, b.id]));

      assert.deepStrictEqual(
        conflicts.get(a.id)?.map((c) => c.request.id),
        [b.id]
      );
    });

    it('does not look a series up when no server sets anime defaults', async () => {
      getSettings().sonarr = [
        { id: 1, name: 'Sonarr', is4k: false, isDefault: true },
      ] as SonarrSettings[];
      const [a, b] = await seed(MediaType.TV, 14, [
        { email: 'demo@seerr.dev', profileId: 4, seasons: [1] },
        { email: 'admin@seerr.dev', profileId: 5, seasons: [1] },
      ]);

      await getConflictsFor(await load([a.id, b.id]));

      assert.strictEqual(externalApiGetMock.callCount(), 0);
    });

    it('compares as a standard series when TMDB cannot be reached', async () => {
      failingSeries.add(15);
      const [a, b] = await seed(MediaType.TV, 15, [
        { email: 'demo@seerr.dev', profileId: 4, seasons: [1] },
        {
          email: 'admin@seerr.dev',
          profileId: 4,
          rootFolder: '/tv',
          seasons: [1],
        },
      ]);

      const conflicts = await getConflictsFor(await load([a.id, b.id]));

      assert.deepStrictEqual(conflicts.get(a.id), []);
      assert.deepStrictEqual(conflicts.get(b.id), []);
    });
  });
});
