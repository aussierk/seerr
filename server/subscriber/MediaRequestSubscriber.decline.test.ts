import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import type { TmdbMovieDetails } from '@server/api/themoviedb/interfaces';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get() {
    return async ({ movieId }: { movieId: number }) =>
      ({ id: movieId }) as unknown as TmdbMovieDetails;
  },
  set() {},
  configurable: true,
});

setupTestDb();

const user = (email: string) =>
  getRepository(User).findOneOrFail({ where: { email } });

const saveMovie = (tmdbId: number, status: MediaStatus) =>
  getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId,
      status,
      status4k: MediaStatus.UNKNOWN,
    })
  );

const saveRequest = (
  media: Media,
  requestedBy: User,
  status: MediaRequestStatus
) =>
  getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status,
      media,
      requestedBy,
      is4k: false,
    })
  );

async function setStatus(id: number, status: MediaRequestStatus) {
  const request = await getRepository(MediaRequest).findOneOrFail({
    where: { id },
  });
  request.status = status;
  await getRepository(MediaRequest).save(request);
}

const mediaStatus = async (id: number) =>
  (await getRepository(Media).findOneOrFail({ where: { id } })).status;

describe('declining a movie request', () => {
  it("keeps available media available when another user's request is completed", async (t) => {
    t.mock.method(MediaRequest, 'sendNotification', async () => undefined);
    const media = await saveMovie(31001, MediaStatus.AVAILABLE);
    await saveRequest(
      media,
      await user('demo@seerr.dev'),
      MediaRequestStatus.COMPLETED
    );
    const second = await saveRequest(
      media,
      await user('admin@seerr.dev'),
      MediaRequestStatus.PENDING
    );

    await setStatus(second.id, MediaRequestStatus.DECLINED);

    assert.strictEqual(await mediaStatus(media.id), MediaStatus.AVAILABLE);
  });

  it('keeps media that a library scan made available when a new request is declined', async (t) => {
    // No request records at all: the scan found the movie
    t.mock.method(MediaRequest, 'sendNotification', async () => undefined);
    const media = await saveMovie(31005, MediaStatus.AVAILABLE);
    const only = await saveRequest(
      media,
      await user('admin@seerr.dev'),
      MediaRequestStatus.PENDING
    );

    await setStatus(only.id, MediaRequestStatus.DECLINED);

    assert.strictEqual(await mediaStatus(media.id), MediaStatus.AVAILABLE);
  });

  it('resets media to unknown when the only pending request is declined', async (t) => {
    t.mock.method(MediaRequest, 'sendNotification', async () => undefined);
    const media = await saveMovie(31002, MediaStatus.PENDING);
    const only = await saveRequest(
      media,
      await user('demo@seerr.dev'),
      MediaRequestStatus.PENDING
    );

    await setStatus(only.id, MediaRequestStatus.DECLINED);

    assert.strictEqual(await mediaStatus(media.id), MediaStatus.UNKNOWN);
  });

  it('resets processing media when its only approved request is declined', async (t) => {
    // The request that made the media processing was the only one holding it
    t.mock.method(MediaRequest, 'sendNotification', async () => undefined);
    t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );
    const media = await saveMovie(31003, MediaStatus.PENDING);
    const only = await saveRequest(
      media,
      await user('demo@seerr.dev'),
      MediaRequestStatus.PENDING
    );
    await setStatus(only.id, MediaRequestStatus.APPROVED);
    assert.strictEqual(await mediaStatus(media.id), MediaStatus.PROCESSING);

    await setStatus(only.id, MediaRequestStatus.DECLINED);

    assert.strictEqual(await mediaStatus(media.id), MediaStatus.UNKNOWN);
  });

  it('still resets pending media when an old completed request remains', async (t) => {
    // A completed request from before the media was removed must not pin it
    t.mock.method(MediaRequest, 'sendNotification', async () => undefined);
    const media = await saveMovie(31004, MediaStatus.PENDING);
    await saveRequest(
      media,
      await user('demo@seerr.dev'),
      MediaRequestStatus.COMPLETED
    );
    const second = await saveRequest(
      media,
      await user('admin@seerr.dev'),
      MediaRequestStatus.PENDING
    );

    await setStatus(second.id, MediaRequestStatus.DECLINED);

    assert.strictEqual(await mediaStatus(media.id), MediaStatus.UNKNOWN);
  });
});
