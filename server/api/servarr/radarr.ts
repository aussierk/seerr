import logger from '@server/logger';
import type { AxiosResponse } from 'axios';
import ServarrBase, { mergeTags } from './base';

export interface RadarrMovieOptions {
  title: string;
  qualityProfileId: number;
  minimumAvailability: string;
  tags: number[];
  profileId: number;
  year: number;
  rootFolderPath: string;
  tmdbId: number;
  monitored?: boolean;
  searchNow?: boolean;
}

export interface RadarrMovie {
  id: number;
  title: string;
  isAvailable: boolean;
  monitored: boolean;
  tmdbId: number;
  imdbId: string;
  titleSlug: string;
  folderName: string;
  path: string;
  profileId: number;
  qualityProfileId: number;
  added: string;
  hasFile: boolean;
  tags: number[];
  movieFile?: {
    id: number;
    movieId: number;
    relativePath?: string;
    path?: string;
    size: number;
    dateAdded: string;
    sceneName?: string;
    releaseGroup?: string;
    edition?: string;
    indexerFlags?: number;
    mediaInfo: {
      id: number;
      audioBitrate: number;
      audioChannels: number;
      audioCodec?: string;
      audioLanguages?: string;
      audioStreamCount: number;
      videoBitDepth: number;
      videoBitrate: number;
      videoCodec?: string;
      videoFps: number;
      videoDynamicRange?: string;
      videoDynamicRangeType?: string;
      resolution?: string;
      runTime?: string;
      scanType?: string;
      subtitles?: string;
    };
    originalFilePath?: string;
    qualityCutoffNotMet: boolean;
  };
}

class RadarrAPI extends ServarrBase<{ movieId: number }> {
  constructor({ url, apiKey }: { url: string; apiKey: string }) {
    super({ url, apiKey, cacheName: 'radarr', apiName: 'Radarr' });
  }

  public getMovies = async (): Promise<RadarrMovie[]> => {
    try {
      const response = await this.axios.get<RadarrMovie[]>('/movie');

      return response.data;
    } catch (e) {
      throw new Error(`[Radarr] Failed to retrieve movies: ${e.message}`, {
        cause: e,
      });
    }
  };

  public getLibraryMoviesByTmdbId = async (
    tmdbId: number
  ): Promise<RadarrMovie[]> => {
    try {
      const response = await this.axios.get<RadarrMovie[]>('/movie', {
        params: { tmdbId },
      });

      return response.data;
    } catch (e) {
      throw new Error(
        `[Radarr] Failed to retrieve movies by TMDB ID: ${e.message}`,
        { cause: e }
      );
    }
  };

  public getMovie = async ({ id }: { id: number }): Promise<RadarrMovie> => {
    try {
      const response = await this.axios.get<RadarrMovie>(`/movie/${id}`);

      return response.data;
    } catch (e) {
      throw new Error(`[Radarr] Failed to retrieve movie: ${e.message}`, {
        cause: e,
      });
    }
  };

  public async getMovieByTmdbId(id: number): Promise<RadarrMovie> {
    let response: AxiosResponse<RadarrMovie[]>;
    try {
      response = await this.axios.get<RadarrMovie[]>('/movie/lookup', {
        params: {
          term: `tmdb:${id}`,
        },
      });
    } catch (e) {
      logger.error('Error retrieving movie by TMDB ID', {
        label: 'Radarr API',
        errorMessage: e.message,
        tmdbId: id,
      });
      throw e;
    }

    if (!response.data[0]) {
      throw new Error('Movie not found');
    }

    return response.data[0];
  }

  // The editor adds to the tags Radarr holds and does not overwrite them
  private async addTagsToMovie(movieId: number, tags: number[]): Promise<void> {
    await this.axios.put('/movie/editor', {
      movieIds: [movieId],
      tags,
      applyTags: 'add',
    });
  }

  public addMovie = async (
    options: RadarrMovieOptions
  ): Promise<RadarrMovie> => {
    try {
      const movie = await this.getMovieByTmdbId(options.tmdbId);

      if (movie.hasFile) {
        const { tags: mergedTags, changed } = mergeTags(
          movie.tags,
          options.tags
        );

        if (!changed) {
          logger.info(
            'Title already exists and is available. Skipping add and returning success',
            {
              label: 'Radarr',
              movie,
            }
          );
          return movie;
        }

        // A failed tag merge must not fail the request
        try {
          await this.addTagsToMovie(movie.id, options.tags);
        } catch (e) {
          logger.warn(
            'Title already exists and is available, but merging the requester tag failed.',
            {
              label: 'Radarr',
              movieId: movie.id,
              movieTitle: movie.title,
              errorMessage: e.message,
            }
          );
          return movie;
        }

        logger.info(
          'Title already exists and is available. Merged requester tag.',
          {
            label: 'Radarr',
            movieId: movie.id,
            movieTitle: movie.title,
          }
        );
        return { ...movie, tags: mergedTags };
      }

      // movie exists in Radarr but is neither downloaded nor monitored
      if (movie.id && !movie.monitored) {
        const response = await this.axios.put<RadarrMovie>(`/movie`, {
          ...movie,
          title: options.title,
          qualityProfileId: options.qualityProfileId,
          profileId: options.profileId,
          titleSlug: options.tmdbId.toString(),
          minimumAvailability: options.minimumAvailability,
          tmdbId: options.tmdbId,
          year: options.year,
          tags: Array.from(new Set([...movie.tags, ...options.tags])),
          rootFolderPath: options.rootFolderPath,
          monitored: options.monitored,
          addOptions: {
            searchForMovie: options.searchNow,
          },
        });

        if (response.data.monitored) {
          logger.info(
            'Found existing title in Radarr and set it to monitored.',
            {
              label: 'Radarr',
              movieId: response.data.id,
              movieTitle: response.data.title,
            }
          );
          logger.debug('Radarr update details', {
            label: 'Radarr',
            movie: response.data,
          });

          if (options.searchNow && response.data.isAvailable) {
            logger.info('Movie is available, triggering Radarr search.', {
              label: 'Radarr',
              movieId: response.data.id,
              movieTitle: response.data.title,
            });
            this.searchMovie(response.data.id);
          }

          return response.data;
        } else {
          logger.error('Failed to update existing movie in Radarr.', {
            label: 'Radarr',
            options,
          });
          throw new Error('Failed to update existing movie in Radarr');
        }
      }

      if (movie.id) {
        // Movie exists and is already monitored
        const { tags: mergedTags, changed: tagsChanged } = mergeTags(
          movie.tags,
          options.tags
        );
        let current = movie;
        if (tagsChanged) {
          // A failed tag merge must not fail the request
          try {
            await this.addTagsToMovie(movie.id, options.tags);
            logger.info(
              'Movie already exists in Radarr and merged requester tag.',
              {
                label: 'Radarr',
                movieId: movie.id,
                movieTitle: movie.title,
              }
            );
            current = { ...movie, tags: mergedTags };
          } catch (e) {
            logger.warn(
              'Movie already exists in Radarr, but merging the requester tag failed.',
              {
                label: 'Radarr',
                movieId: movie.id,
                movieTitle: movie.title,
                errorMessage: e.message,
              }
            );
          }
        } else {
          logger.info('Movie is already monitored in Radarr.', {
            label: 'Radarr',
            movieId: movie.id,
            movieTitle: movie.title,
            hasFile: movie.hasFile,
          });
        }
        // If searchNow is requested, movie doesn't have a file, and Radarr considers the movie 'available' then trigger search
        if (options.searchNow && !movie.hasFile && movie.isAvailable) {
          logger.info(
            'Triggering search for existing, available, monitored movie without file',
            {
              label: 'Radarr',
              movieId: current.id,
              movieTitle: current.title,
            }
          );
          this.searchMovie(current.id);
        }

        return current;
      }

      const response = await this.axios.post<RadarrMovie>(`/movie`, {
        title: options.title,
        qualityProfileId: options.qualityProfileId,
        profileId: options.profileId,
        titleSlug: options.tmdbId.toString(),
        minimumAvailability: options.minimumAvailability,
        tmdbId: options.tmdbId,
        year: options.year,
        rootFolderPath: options.rootFolderPath,
        monitored: options.monitored,
        tags: options.tags,
        addOptions: {
          searchForMovie: options.searchNow,
        },
      });

      if (response.data.id) {
        logger.info('Radarr accepted request', { label: 'Radarr' });
        logger.debug('Radarr add details', {
          label: 'Radarr',
          movie: response.data,
        });
      } else {
        logger.error('Failed to add movie to Radarr', {
          label: 'Radarr',
          options,
        });
        throw new Error('Failed to add movie to Radarr');
      }
      return response.data;
    } catch (e) {
      logger.error(
        'Failed to add movie to Radarr. This might happen if the movie already exists, in which case you can safely ignore this error.',
        {
          label: 'Radarr',
          errorMessage: e.message,
          options,
          response: e?.response?.data,
        }
      );
      throw new Error('Failed to add movie to Radarr', { cause: e });
    }
  };

  public async addTags(movieId: number, tags: number[]): Promise<void> {
    const movie = await this.getMovie({ id: movieId });
    const { changed } = mergeTags(movie.tags, tags);

    if (!changed) {
      return;
    }

    await this.addTagsToMovie(movieId, tags);
    logger.info('Merged requester tag into existing movie in Radarr.', {
      label: 'Radarr',
      movieId: movie.id,
      movieTitle: movie.title,
    });
  }

  public async updateMovieSettings(
    movieId: number,
    settings: {
      qualityProfileId?: number | null;
      rootFolderPath?: string | null;
    }
  ): Promise<void> {
    const payload: Record<string, unknown> = { movieIds: [movieId] };

    if (settings.qualityProfileId != null) {
      payload.qualityProfileId = settings.qualityProfileId;
    }
    if (settings.rootFolderPath) {
      payload.rootFolderPath = settings.rootFolderPath;
      payload.moveFiles = true;
    }
    if (Object.keys(payload).length === 1) {
      return;
    }

    await this.axios.put('/movie/editor', payload);
    logger.info('Updated quality profile and root folder of movie in Radarr.', {
      label: 'Radarr',
      movieId,
      ...settings,
    });
  }

  public async searchMovie(movieId: number): Promise<void> {
    logger.info('Executing movie search command', {
      label: 'Radarr API',
      movieId,
    });

    try {
      await this.runCommand('MoviesSearch', { movieIds: [movieId] });
    } catch (e) {
      logger.error(
        'Something went wrong while executing Radarr movie search.',
        {
          label: 'Radarr API',
          errorMessage: e.message,
          movieId,
        }
      );
    }
  }
  public removeMovie = async (tmdbId: number): Promise<void> => {
    const { id, title } = await this.getMovieByTmdbId(tmdbId);

    if (!id) {
      logger.info(`[Radarr] Movie not in library, nothing to remove`, {
        tmdbId,
      });
      return;
    }

    try {
      await this.axios.delete(`/movie/${id}`, {
        params: {
          deleteFiles: true,
          addImportExclusion: false,
        },
      });
      logger.info(`[Radarr] Removed movie ${title}`);
    } catch (e) {
      if (e?.response?.status === 404) {
        logger.info(`[Radarr] Movie already removed from Radarr`, {
          tmdbId,
        });
        return;
      }
      throw e;
    }
  };

  public clearCache = ({
    tmdbId,
    externalId,
  }: {
    tmdbId?: number | null;
    externalId?: number | null;
  }) => {
    if (tmdbId) {
      this.removeCache('/movie/lookup', {
        term: `tmdb:${tmdbId}`,
      });
    }
    if (externalId) {
      this.removeCache(`/movie/${externalId}`);
    }
  };
}

export default RadarrAPI;
