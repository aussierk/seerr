import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import type { AxiosInstance } from 'axios';

import type { RadarrMovieOptions } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';

function buildRadarr(): RadarrAPI {
  return new RadarrAPI({ url: 'http://localhost:7878/api/v3', apiKey: 'test' });
}

function getAxios(radarr: RadarrAPI): AxiosInstance {
  return (radarr as unknown as { axios: AxiosInstance }).axios;
}

describe('RadarrAPI removeMovie', () => {
  afterEach(() => mock.restoreAll());

  it('removes the movie when it exists in the library', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await radarr.removeMovie(550);

    assert.strictEqual(del.mock.callCount(), 1);
    assert.strictEqual(del.mock.calls[0].arguments[0], '/movie/7');
  });

  it('does nothing when the movie is not in the library', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({
      data: [{ id: 0, title: 'Fight Club' }],
    }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.doesNotReject(() => radarr.removeMovie(550));
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('rejects when the tmdbId is unknown to the lookup', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({ data: [] }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.rejects(() => radarr.removeMovie(550), /Movie not found/);
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('ignores a 404 when the movie was already removed in Radarr', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    mock.method(getAxios(radarr), 'delete', async () => {
      throw { response: { status: 404 } };
    });

    await assert.doesNotReject(() => radarr.removeMovie(550));
  });

  it('rethrows errors other than 404', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    mock.method(getAxios(radarr), 'delete', async () => {
      throw { response: { status: 500 } };
    });

    await assert.rejects(() => radarr.removeMovie(550));
  });

  it('rethrows a 404 from the lookup instead of treating it as removed', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => {
      throw { response: { status: 404 } };
    });
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.rejects(
      () => radarr.removeMovie(550),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 404
    );
    assert.strictEqual(del.mock.callCount(), 0);
  });
});

describe('RadarrAPI addTags', () => {
  afterEach(() => mock.restoreAll());

  it('adds new tags to the existing movie through the editor', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({
      data: { id: 7, title: 'Test Movie', tags: [1] },
    }));
    const put = mock.method(getAxios(radarr), 'put', async () => ({
      data: { id: 7, title: 'Test Movie', tags: [1, 2] },
    }));

    await radarr.addTags(7, [2]);

    assert.strictEqual(put.mock.callCount(), 1);
    assert.strictEqual(put.mock.calls[0].arguments[0], '/movie/editor');
    assert.deepStrictEqual(put.mock.calls[0].arguments[1], {
      movieIds: [7],
      tags: [2],
      applyTags: 'add',
    });
  });

  it('does not save when all tags are already present on the movie', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({
      data: { id: 7, title: 'Test Movie', tags: [1, 2] },
    }));
    const put = mock.method(getAxios(radarr), 'put', async () => ({}));

    await radarr.addTags(7, [2]);

    assert.strictEqual(put.mock.callCount(), 0);
  });
});

describe('RadarrAPI getMovieByTmdbId', () => {
  afterEach(() => mock.restoreAll());

  it('rethrows a 401 from the lookup with the status intact', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => {
      throw { response: { status: 401 } };
    });

    await assert.rejects(
      () => radarr.getMovieByTmdbId(550),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 401
    );
  });

  it('throws "Movie not found" when the lookup returns no results', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({ data: [] }));

    await assert.rejects(() => radarr.getMovieByTmdbId(550), {
      message: 'Movie not found',
    });
  });
});

describe('RadarrAPI addMovie', () => {
  afterEach(() => mock.restoreAll());

  const mergeOptions: RadarrMovieOptions = {
    title: 'Test Movie',
    qualityProfileId: 1,
    minimumAvailability: 'Released',
    tags: [2],
    profileId: 1,
    year: 2026,
    rootFolderPath: '/movies',
    tmdbId: 7,
    searchNow: false,
  };

  for (const [name, hasFile] of [
    ['an available movie', true],
    ['a monitored movie without a file', false],
  ] as const) {
    it(`adds the requester tags to ${name} through the editor`, async () => {
      const radarr = buildRadarr();
      mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
        id: 7,
        title: 'Test Movie',
        monitored: true,
        hasFile,
        isAvailable: false,
        tags: [1],
      }));
      const put = mock.method(getAxios(radarr), 'put', async () => ({}));

      const result = await radarr.addMovie(mergeOptions);

      assert.strictEqual(put.mock.callCount(), 1);
      assert.strictEqual(put.mock.calls[0].arguments[0], '/movie/editor');
      assert.deepStrictEqual(put.mock.calls[0].arguments[1], {
        movieIds: [7],
        tags: [2],
        applyTags: 'add',
      });
      assert.deepStrictEqual(result.tags, [1, 2]);
    });

    it(`does not save ${name} that already has the requester tags`, async () => {
      const radarr = buildRadarr();
      mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
        id: 7,
        title: 'Test Movie',
        monitored: true,
        hasFile,
        isAvailable: false,
        tags: [1, 2],
      }));
      const put = mock.method(getAxios(radarr), 'put', async () => ({}));

      await radarr.addMovie(mergeOptions);

      assert.strictEqual(put.mock.callCount(), 0);
    });

    it(`still succeeds for ${name} when merging the tags fails`, async () => {
      const radarr = buildRadarr();
      mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
        id: 7,
        title: 'Test Movie',
        monitored: true,
        hasFile,
        isAvailable: false,
        tags: [1],
      }));
      mock.method(getAxios(radarr), 'put', async () => {
        throw new Error('editor unavailable');
      });

      const result = await radarr.addMovie(mergeOptions);

      assert.strictEqual(result.id, 7);
      assert.deepStrictEqual(result.tags, [1]);
    });
  }

  it('does not trigger a search for an existing, monitored movie that is not yet available', async () => {
    const radarr = buildRadarr();
    const options: RadarrMovieOptions = {
      title: 'Test Movie',
      qualityProfileId: 1,
      minimumAvailability: 'Released',
      tags: [],
      profileId: 1,
      year: 2026,
      rootFolderPath: '/movies',
      tmdbId: 7,
      searchNow: true,
    };
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
      monitored: true,
      hasFile: false,
      isAvailable: false,
      tags: [],
    }));

    const search = mock.method(
      RadarrAPI.prototype,
      'searchMovie',
      async () => {}
    );
    await radarr.addMovie(options);

    assert.strictEqual(search.mock.callCount(), 0);
  });

  it('triggers a search for an existing, monitored movie that is already available', async () => {
    const radarr = buildRadarr();
    const options: RadarrMovieOptions = {
      title: 'Test Movie',
      qualityProfileId: 1,
      minimumAvailability: 'Released',
      tags: [],
      profileId: 1,
      year: 2026,
      rootFolderPath: '/movies',
      tmdbId: 7,
      searchNow: true,
    };
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
      monitored: true,
      hasFile: false,
      isAvailable: true,
      tags: [],
    }));

    const search = mock.method(
      RadarrAPI.prototype,
      'searchMovie',
      async () => {}
    );
    await radarr.addMovie(options);

    assert.strictEqual(search.mock.callCount(), 1);
  });

  it('does not trigger a search for an existing, previously unmonitored movie that is not yet available', async () => {
    const radarr = buildRadarr();
    const options: RadarrMovieOptions = {
      title: 'Test Movie',
      qualityProfileId: 1,
      minimumAvailability: 'Released',
      tags: [],
      profileId: 1,
      year: 2026,
      rootFolderPath: '/movies',
      tmdbId: 7,
      monitored: true,
      searchNow: true,
    };
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
      monitored: false,
      hasFile: false,
      tags: [],
    }));
    const put = mock.method(getAxios(radarr), 'put', async () => ({
      data: { id: 7, title: 'Test Movie', monitored: true, isAvailable: false },
    }));

    const search = mock.method(
      RadarrAPI.prototype,
      'searchMovie',
      async () => {}
    );
    await radarr.addMovie(options);

    assert.strictEqual(put.mock.callCount(), 1);
    assert.strictEqual(search.mock.callCount(), 0);
  });

  it('triggers a search for an existing, previously unmonitored movie that is already available', async () => {
    const radarr = buildRadarr();
    const options: RadarrMovieOptions = {
      title: 'Test Movie',
      qualityProfileId: 1,
      minimumAvailability: 'Released',
      tags: [],
      profileId: 1,
      year: 2026,
      rootFolderPath: '/movies',
      tmdbId: 7,
      monitored: true,
      searchNow: true,
    };
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
      monitored: false,
      hasFile: false,
      tags: [],
    }));
    const put = mock.method(getAxios(radarr), 'put', async () => ({
      data: { id: 7, title: 'Test Movie', monitored: true, isAvailable: true },
    }));

    const search = mock.method(
      RadarrAPI.prototype,
      'searchMovie',
      async () => {}
    );
    await radarr.addMovie(options);

    assert.strictEqual(put.mock.callCount(), 1);
    assert.strictEqual(search.mock.callCount(), 1);
    assert.strictEqual(search.mock.calls[0].arguments[0], 7);
  });
});

describe('RadarrAPI updateMovieSettings', () => {
  afterEach(() => mock.restoreAll());

  it('updates the profile and moves files when the root folder changes', async () => {
    const radarr = buildRadarr();
    const put = mock.method(getAxios(radarr), 'put', async () => ({}));

    await radarr.updateMovieSettings(7, {
      qualityProfileId: 4,
      rootFolderPath: '/movies-4k',
    });

    assert.deepStrictEqual(put.mock.calls[0].arguments, [
      '/movie/editor',
      {
        movieIds: [7],
        qualityProfileId: 4,
        rootFolderPath: '/movies-4k',
        moveFiles: true,
      },
    ]);
  });

  it('does not call Radarr when there is nothing to change', async () => {
    const radarr = buildRadarr();
    const put = mock.method(getAxios(radarr), 'put', async () => ({}));

    await radarr.updateMovieSettings(7, {});

    assert.strictEqual(put.mock.callCount(), 0);
  });
});
