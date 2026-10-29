import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getSettingsChange, isInRootFolder } from '@server/api/servarr/base';

describe('isInRootFolder', () => {
  it('matches a path under the folder and the folder itself', () => {
    assert.ok(isInRootFolder('/movies/Test (2020)', '/movies'));
    assert.ok(isInRootFolder('/movies', '/movies'));
  });

  it('ignores trailing slashes and slash direction', () => {
    assert.ok(isInRootFolder('D:\\Movies\\Test (2020)', 'D:/Movies/'));
  });

  it('does not match a sibling folder that only shares a prefix', () => {
    assert.ok(!isInRootFolder('/movies-4k/Test (2020)', '/movies'));
  });

  it('ignores case for a Windows drive path', () => {
    assert.ok(isInRootFolder('C:\\Movies\\Test (2020)', 'c:/movies'));
    assert.ok(isInRootFolder('c:/movies/Test (2020)', 'C:\\Movies\\'));
  });

  it('ignores case for a UNC path', () => {
    assert.ok(
      isInRootFolder('\\\\Server\\Share\\Test (2020)', '\\\\server\\share')
    );
  });

  it('keeps POSIX paths case-sensitive', () => {
    assert.ok(!isInRootFolder('/Movies/Test (2020)', '/movies'));
  });

  it('still tells apart different Windows folders', () => {
    assert.ok(!isInRootFolder('C:\\Movies-4K\\Test (2020)', 'c:/movies'));
  });
});

describe('getSettingsChange', () => {
  const item = { qualityProfileId: 1, path: '/movies/Test (2020)' };

  it('asks for what the request sets and the item lacks', () => {
    assert.deepStrictEqual(
      getSettingsChange(item, { profileId: 4, rootFolder: '/other' }),
      { qualityProfileId: 4, rootFolderPath: '/other' }
    );
  });

  it('ignores anything the request leaves unset', () => {
    assert.deepStrictEqual(getSettingsChange(item, {}), {});
    assert.deepStrictEqual(
      getSettingsChange(item, {
        profileId: null,
        rootFolder: null,
        languageProfileId: null,
      }),
      {}
    );
  });

  it('ignores values the item already has', () => {
    assert.deepStrictEqual(
      getSettingsChange(
        { ...item, languageProfileId: 2 },
        { profileId: 1, rootFolder: '/movies', languageProfileId: 2 }
      ),
      {}
    );
  });

  it('treats the same root folder spelled with other slashes as unchanged', () => {
    assert.deepStrictEqual(
      getSettingsChange(
        { qualityProfileId: 1, path: 'D:\\Movies\\Test (2020)' },
        { rootFolder: 'D:/Movies/' }
      ),
      {}
    );
  });

  it('prefers the root folder the item reports over its path', () => {
    assert.deepStrictEqual(
      getSettingsChange(
        { qualityProfileId: 1, rootFolderPath: '/tv', path: '/elsewhere/Show' },
        { rootFolder: '/tv' }
      ),
      {}
    );
  });

  it('asks for a language profile only when the request sets a different one', () => {
    assert.deepStrictEqual(
      getSettingsChange(
        { ...item, languageProfileId: 1 },
        { languageProfileId: 3 }
      ),
      { languageProfileId: 3 }
    );
  });

  describe('with server defaults', () => {
    const defaults = {
      rootFolders: ['/movies', '/anime'],
      profileIds: [4, 8],
      languageProfileIds: [2],
    };

    it('ignores values that are just a server default', () => {
      assert.deepStrictEqual(
        getSettingsChange(
          { qualityProfileId: 1, path: '/elsewhere/Test (2020)' },
          { profileId: 4, rootFolder: '/movies' },
          defaults
        ),
        {}
      );
    });

    it('ignores the default of either the standard or the anime settings', () => {
      assert.deepStrictEqual(
        getSettingsChange(
          { qualityProfileId: 1, path: '/elsewhere/Show' },
          { profileId: 8, rootFolder: '/anime' },
          defaults
        ),
        {}
      );
    });

    it('compares a default folder whichever way its slashes lean', () => {
      assert.deepStrictEqual(
        getSettingsChange(
          { qualityProfileId: 1, path: '/elsewhere/Test (2020)' },
          { rootFolder: '/movies/' },
          defaults
        ),
        {}
      );
    });

    it('ignores a default language profile', () => {
      assert.deepStrictEqual(
        getSettingsChange(
          { ...item, languageProfileId: 1 },
          { languageProfileId: 2 },
          defaults
        ),
        {}
      );
    });

    it('still applies a value that is not a default', () => {
      assert.deepStrictEqual(
        getSettingsChange(
          { qualityProfileId: 1, path: '/elsewhere/Test (2020)' },
          { profileId: 9, rootFolder: '/other', languageProfileId: 3 },
          defaults
        ),
        { qualityProfileId: 9, rootFolderPath: '/other', languageProfileId: 3 }
      );
    });

    it('behaves as before without defaults', () => {
      assert.deepStrictEqual(
        getSettingsChange(
          { qualityProfileId: 1, path: '/elsewhere/Test (2020)' },
          { profileId: 4, rootFolder: '/movies' }
        ),
        { qualityProfileId: 4, rootFolderPath: '/movies' }
      );
    });
  });
});
