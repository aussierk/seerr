import ExternalAPI from '@server/api/externalapi';
import type { AvailableCacheIds } from '@server/lib/cache';
import cacheManager from '@server/lib/cache';
import { getSettings, type DVRSettings } from '@server/lib/settings';
import { isEqual } from 'lodash';

export function mergeTags(
  existingTags: number[],
  incomingTags?: number[]
): { tags: number[]; changed: boolean } {
  if (!incomingTags) {
    return { tags: existingTags, changed: false };
  }
  const merged = Array.from(new Set([...existingTags, ...incomingTags]));
  const changed = !isEqual(new Set(merged), new Set(existingTags));
  return { tags: merged, changed };
}

const isWindowsPath = (value: string): boolean =>
  /^[A-Za-z]:/.test(value) || value.startsWith('\\\\');

export function isInRootFolder(path: string, rootFolder: string): boolean {
  const ignoreCase = isWindowsPath(path) || isWindowsPath(rootFolder);
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return ignoreCase ? normalized.toLowerCase() : normalized;
  };

  return (
    normalize(path) === normalize(rootFolder) ||
    normalize(path).startsWith(`${normalize(rootFolder)}/`)
  );
}

const isSameFolder = (a: string, b: string): boolean =>
  isInRootFolder(a, b) && isInRootFolder(b, a);

export type ItemSettingsChange = {
  qualityProfileId?: number;
  rootFolderPath?: string;
  languageProfileId?: number;
};

export type ServerDefaults = {
  rootFolders?: string[];
  profileIds?: number[];
  languageProfileIds?: number[];
};

export function getSettingsChange(
  item: {
    qualityProfileId: number;
    path?: string;
    rootFolderPath?: string;
    languageProfileId?: number;
  },
  request: {
    profileId?: number | null;
    rootFolder?: string | null;
    languageProfileId?: number | null;
  },
  defaults?: ServerDefaults
): ItemSettingsChange {
  const currentPath = item.rootFolderPath ?? item.path;
  const change: ItemSettingsChange = {};

  if (
    request.profileId &&
    request.profileId !== item.qualityProfileId &&
    !defaults?.profileIds?.includes(request.profileId)
  ) {
    change.qualityProfileId = request.profileId;
  }
  if (
    request.rootFolder &&
    currentPath &&
    !isInRootFolder(currentPath, request.rootFolder) &&
    !defaults?.rootFolders?.some((folder) =>
      isSameFolder(folder, request.rootFolder as string)
    )
  ) {
    change.rootFolderPath = request.rootFolder;
  }
  if (
    request.languageProfileId &&
    request.languageProfileId !== item.languageProfileId &&
    !defaults?.languageProfileIds?.includes(request.languageProfileId)
  ) {
    change.languageProfileId = request.languageProfileId;
  }

  return change;
}

export interface SystemStatus {
  version: string;
  buildTime: Date;
  isDebug: boolean;
  isProduction: boolean;
  isAdmin: boolean;
  isUserInteractive: boolean;
  startupPath: string;
  appData: string;
  osName: string;
  osVersion: string;
  isNetCore: boolean;
  isMono: boolean;
  isLinux: boolean;
  isOsx: boolean;
  isWindows: boolean;
  isDocker: boolean;
  mode: string;
  branch: string;
  authentication: string;
  sqliteVersion: string;
  migrationVersion: number;
  urlBase: string;
  runtimeVersion: string;
  runtimeName: string;
  startTime: Date;
  packageUpdateMechanism: string;
}

export interface RootFolder {
  id: number;
  path: string;
  freeSpace: number;
  totalSpace: number;
  unmappedFolders: {
    name: string;
    path: string;
  }[];
}

export interface QualityProfile {
  id: number;
  name: string;
}

interface QueueItem {
  size: number;
  title: string;
  sizeleft: number;
  timeleft: string;
  estimatedCompletionTime: string;
  status: string;
  trackedDownloadStatus: string;
  trackedDownloadState: string;
  downloadId: string;
  protocol: string;
  downloadClient: string;
  indexer: string;
  id: number;
}

export interface Tag {
  id: number;
  label: string;
}

interface QueueResponse<QueueItemAppendT> {
  page: number;
  pageSize: number;
  sortKey: string;
  sortDirection: string;
  totalRecords: number;
  records: (QueueItem & QueueItemAppendT)[];
}

class ServarrBase<QueueItemAppendT> extends ExternalAPI {
  static buildUrl(settings: DVRSettings, path?: string): string {
    return `${settings.useSsl ? 'https' : 'http'}://${settings.hostname}:${
      settings.port
    }${settings.baseUrl ?? ''}${path}`;
  }

  protected apiName: string;

  constructor({
    url,
    apiKey,
    cacheName,
    apiName,
  }: {
    url: string;
    apiKey: string;
    cacheName: AvailableCacheIds;
    apiName: string;
  }) {
    const timeout = getSettings().network.apiRequestTimeout;

    super(
      url,
      {
        apikey: apiKey,
      },
      {
        nodeCache: cacheManager.getCache(cacheName).data,
        timeout,
      }
    );

    this.apiName = apiName;
  }

  public getSystemStatus = async (): Promise<SystemStatus> => {
    try {
      const response = await this.axios.get<SystemStatus>('/system/status');

      return response.data;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve system status: ${e.message}`,
        { cause: e }
      );
    }
  };

  public getProfiles = async (): Promise<QualityProfile[]> => {
    try {
      const data = await this.getRolling<QualityProfile[]>(
        `/qualityProfile`,
        undefined,
        3600
      );

      return data;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve profiles: ${e.message}`,
        { cause: e }
      );
    }
  };

  public getRootFolders = async (): Promise<RootFolder[]> => {
    try {
      const data = await this.getRolling<RootFolder[]>(
        `/rootfolder`,
        undefined,
        3600
      );

      return data;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve root folders: ${e.message}`,
        { cause: e }
      );
    }
  };

  public getQueue = async (): Promise<(QueueItem & QueueItemAppendT)[]> => {
    try {
      const response = await this.axios.get<QueueResponse<QueueItemAppendT>>(
        `/queue`,
        {
          params: {
            includeEpisode: true,
          },
        }
      );

      return response.data.records;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve queue: ${e.message}`,
        { cause: e }
      );
    }
  };

  public getTags = async (): Promise<Tag[]> => {
    try {
      const response = await this.axios.get<Tag[]>(`/tag`);

      return response.data;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve tags: ${e.message}`,
        { cause: e }
      );
    }
  };

  public createTag = async ({ label }: { label: string }): Promise<Tag> => {
    try {
      const response = await this.axios.post<Tag>(`/tag`, {
        label,
      });

      return response.data;
    } catch (e) {
      throw new Error(`[${this.apiName}] Failed to create tag: ${e.message}`, {
        cause: e,
      });
    }
  };

  public renameTag = async ({
    id,
    label,
  }: {
    id: number;
    label: string;
  }): Promise<Tag> => {
    try {
      const response = await this.axios.put<Tag>(`/tag/${id}`, {
        id,
        label,
      });

      return response.data;
    } catch (e) {
      throw new Error(`[${this.apiName}] Failed to rename tag: ${e.message}`, {
        cause: e,
      });
    }
  };

  async refreshMonitoredDownloads(): Promise<void> {
    await this.runCommand('RefreshMonitoredDownloads', {});
  }

  protected async runCommand(
    commandName: string,
    options: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.axios.post(`/command`, {
        name: commandName,
        ...options,
      });
    } catch (e) {
      throw new Error(`[${this.apiName}] Failed to run command: ${e.message}`, {
        cause: e,
      });
    }
  }
}

export default ServarrBase;
