import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import RadarrAPI from '@server/api/servarr/radarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import mediaRoutes from './media';

// A falsy id makes removeMovie() skip the HTTP call, so the deletion is
// reached without touching a server.
const getMovieByTmdbIdMock = mock.method(
  RadarrAPI.prototype,
  'getMovieByTmdbId',
  async () => ({
    id: 0,
    title: 'Test Movie',
  })
).mock;

const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
).mock;

function configureRadarr(overrides: Partial<RadarrSettings>[] = [{}]): void {
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
  settings.sonarr = [];
}

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/media', mediaRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

before(async () => {
  app = createApp();
});

beforeEach(() => {
  configureRadarr();
  getMovieByTmdbIdMock.resetCalls();
  sendNotificationMock.resetCalls();
});

setupTestDb();

async function loginAs(email: string, password: string) {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent.post('/auth/local').send({ email, password });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

async function seedMovie({
  serverId,
  withRequest = false,
  requestStatus = MediaRequestStatus.PENDING,
  requestServerId = serverId,
}: {
  serverId: number;
  withRequest?: boolean;
  requestStatus?: MediaRequestStatus;
  requestServerId?: number;
}): Promise<Media> {
  const userRepo = getRepository(User);
  const mediaRepo = getRepository(Media);
  const requestRepo = getRepository(MediaRequest);

  const media = await mediaRepo.save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 12345,
      status: MediaStatus.PROCESSING,
      status4k: MediaStatus.UNKNOWN,
      serviceId: serverId,
    })
  );

  if (withRequest) {
    const requestedBy = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: requestStatus,
        media,
        requestedBy,
        is4k: false,
        serverId: requestServerId,
      })
    );
  }

  return media;
}

describe('DELETE /media/:id/file', () => {
  it('warns (409) when deleting would drop an active request on that server', async () => {
    const media = await seedMovie({ serverId: 0, withRequest: true });

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/media/${media.id}/file`);

    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.affectedRequests, 1);
    assert.match(res.body.message, /active request/);
    // The guard short-circuits before any *arr deletion is attempted.
    assert.strictEqual(getMovieByTmdbIdMock.callCount(), 0);
  });

  it('warns (409) when deleting would affect a completed request', async () => {
    const media = await seedMovie({
      serverId: 0,
      withRequest: true,
      requestStatus: MediaRequestStatus.COMPLETED,
    });

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/media/${media.id}/file`);

    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.affectedRequests, 1);
  });

  it('does not warn about a request whose server was removed', async () => {
    const media = await seedMovie({
      serverId: 0,
      withRequest: true,
      requestServerId: 99,
    });

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/media/${media.id}/file`);

    assert.strictEqual(res.status, 204);
  });

  it('deletes (204) when ?force=true despite an active request', async () => {
    const media = await seedMovie({ serverId: 0, withRequest: true });

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/media/${media.id}/file?force=true`);

    assert.strictEqual(res.status, 204);
    assert.strictEqual(getMovieByTmdbIdMock.callCount(), 1);
  });

  it('deletes (204) with no warning when no active request targets that server', async () => {
    const media = await seedMovie({ serverId: 0 });

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/media/${media.id}/file`);

    assert.strictEqual(res.status, 204);
    assert.strictEqual(getMovieByTmdbIdMock.callCount(), 1);
  });
});
