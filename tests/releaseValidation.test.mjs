import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseReleaseTag,
  validateChangedReleaseContent,
  validateReleaseContent,
  validateReleaseNotes,
  validateReleaseTopology,
  validateTelegramHtml,
} from '../bin/release/validate-release.mjs';

const releaseTag = 'v1.2.3';
const releasePaths = {
  chinese: `docs/release-notes/${releaseTag}-zh.md`,
  english: `docs/release-notes/${releaseTag}-en.md`,
  telegram: `docs/release-posts/${releaseTag}-telegram.html`,
};

const validMetadata = {
  summary: {
    zh: '更新说明',
    en: 'Release update',
  },
  update: {
    breaking: false,
    migration_required: false,
    minimum_direct_upgrade_version: null,
    upgrade_guide_url: `https://github.com/seakee/CPA-Manager-Plus/releases/tag/${releaseTag}`,
  },
  compatibility: {
    minimum_cpa_version: null,
  },
};

const makeChineseNotes = (metadata = validMetadata) => `# CPA Manager Plus ${releaseTag}

[English ->](https://github.com/seakee/CPA-Manager-Plus/blob/${releaseTag}/docs/release-notes/${releaseTag}-en.md)

<!-- cpamp-update
${typeof metadata === 'string' ? metadata : JSON.stringify(metadata, null, 2)}
-->
`;

const chineseNotes = makeChineseNotes();
const notesWithoutMetadata = `# CPA Manager Plus ${releaseTag}

[English ->](https://github.com/seakee/CPA-Manager-Plus/blob/${releaseTag}/docs/release-notes/${releaseTag}-en.md)
`;
const englishNotes = `# CPA Manager Plus ${releaseTag}

[中文 ->](https://github.com/seakee/CPA-Manager-Plus/blob/${releaseTag}/docs/release-notes/${releaseTag}-zh.md)
`;
const telegramPost = '<b>v1.2.3</b>\n\n• Release update';

describe('release tag validation', () => {
  it('accepts stable and prerelease SemVer tags', () => {
    expect(parseReleaseTag('v1.2.3')).toEqual({ tag: 'v1.2.3', prerelease: false });
    expect(parseReleaseTag('v1.2.3-rc.1')).toEqual({ tag: 'v1.2.3-rc.1', prerelease: true });
  });

  it.each([
    '1.2.3',
    'v1.2',
    'v01.2.3',
    'v1.2.3-',
    'v1.2.3-01',
    'v1.2.3-rc.01',
    'v1.2.3+build.1',
    'vfoo',
  ])('rejects invalid tag %s', (tag) => {
    expect(() => parseReleaseTag(tag)).toThrow();
  });
});

describe('release content validation', () => {
  it('requires reciprocal tag-pinned language links', () => {
    expect(
      validateReleaseNotes({ tag: releaseTag, chinese: chineseNotes, english: englishNotes })
    ).toMatchObject({
      chineseCharacters: expect.any(Number),
      englishCharacters: expect.any(Number),
    });
    expect(() =>
      validateReleaseNotes({
        tag: releaseTag,
        chinese: chineseNotes,
        english: englishNotes.replace(`/blob/${releaseTag}/`, '/blob/v0.0.0/'),
      })
    ).toThrow('English release notes must link');
  });

  it('rejects unsupported Telegram markup and Markdown-only sections', () => {
    expect(validateTelegramHtml(telegramPost)).toEqual({ characters: expect.any(Number) });
    expect(validateTelegramHtml('<b>R&amp;D &#62; &#X3E; baseline</b>')).toEqual({
      characters: expect.any(Number),
    });
    expect(() => validateTelegramHtml('<script>alert(1)</script>')).toThrow('unsupported HTML');
    expect(() => validateTelegramHtml('<b>发布截图</b>')).toThrow('Markdown-only');
    expect(() => validateTelegramHtml('<a href="http://example.com">link</a>')).toThrow('HTTPS');
    expect(() => validateTelegramHtml('<b>R&D</b>')).toThrow('invalid or unescaped');
    expect(() => validateTelegramHtml('<b>A > B</b>')).toThrow('unescaped >');
    expect(() => validateTelegramHtml('<b>&bogus;</b>')).toThrow('invalid or unescaped');
  });

  it('requires all three release files before publishing', () => {
    const contents = new Map([
      [releasePaths.chinese, chineseNotes],
      [releasePaths.english, englishNotes],
      [releasePaths.telegram, telegramPost],
    ]);
    const readFile = (filePath) => contents.get(filePath.split('/').slice(-3).join('/'));
    const fileExists = (filePath) => contents.has(filePath.split('/').slice(-3).join('/'));

    expect(validateReleaseContent({ tag: releaseTag, readFile, fileExists })).toMatchObject({
      paths: releasePaths,
    });
    contents.delete(releasePaths.telegram);
    expect(() => validateReleaseContent({ tag: releaseTag, readFile, fileExists })).toThrow(
      'Missing required release files'
    );
  });

  it('requires valid cpamp-update metadata in Chinese release notes', () => {
    const contents = new Map([
      [releasePaths.chinese, chineseNotes],
      [releasePaths.english, englishNotes],
      [releasePaths.telegram, telegramPost],
    ]);
    const readFile = (filePath) => contents.get(filePath.split('/').slice(-3).join('/'));
    const fileExists = (filePath) => contents.has(filePath.split('/').slice(-3).join('/'));

    // Valid release content passes.
    expect(validateReleaseContent({ tag: releaseTag, readFile, fileExists })).toMatchObject({
      paths: releasePaths,
    });

    // Missing metadata block fails.
    contents.set(releasePaths.chinese, notesWithoutMetadata);
    expect(() => validateReleaseContent({ tag: releaseTag, readFile, fileExists })).toThrow(
      'Release notes require exactly one cpamp-update JSON comment'
    );

    // Malformed JSON fails.
    contents.set(releasePaths.chinese, makeChineseNotes('{ invalid json'));
    expect(() => validateReleaseContent({ tag: releaseTag, readFile, fileExists })).toThrow();

    // Missing required field (breaking) fails.
    const missingBreaking = JSON.parse(JSON.stringify(validMetadata));
    delete missingBreaking.update.breaking;
    contents.set(releasePaths.chinese, makeChineseNotes(missingBreaking));
    expect(() => validateReleaseContent({ tag: releaseTag, readFile, fileExists })).toThrow(
      'Explicit update flags required'
    );
  });

  it('validates every release tag represented by changed release paths and fails on bad metadata', () => {
    const contents = new Map([
      [releasePaths.chinese, chineseNotes],
      [releasePaths.english, englishNotes],
      [releasePaths.telegram, telegramPost],
    ]);
    const readFile = (filePath) => contents.get(filePath.split('/').slice(-3).join('/'));
    const fileExists = (filePath) => contents.has(filePath.split('/').slice(-3).join('/'));

    expect(
      validateChangedReleaseContent({
        changedFiles: Object.values(releasePaths),
        readFile,
        fileExists,
      })
    ).toMatchObject({
      tags: [releaseTag],
      releases: [expect.objectContaining({ paths: releasePaths })],
    });

    // changed-content gate fails when metadata is missing
    contents.set(releasePaths.chinese, notesWithoutMetadata);
    expect(() =>
      validateChangedReleaseContent({
        changedFiles: Object.values(releasePaths),
        readFile,
        fileExists,
      })
    ).toThrow('Release notes require exactly one cpamp-update JSON comment');

    contents.set(releasePaths.chinese, chineseNotes);
    expect(() =>
      validateChangedReleaseContent({
        changedFiles: ['docs/release-notes/README.md'],
        readFile,
        fileExists,
      })
    ).toThrow('Unexpected release content path');
  });
});

const makeTopologyGit = ({ extraDevChange = false, promotionTreeDrift = false, tagSha } = {}) => {
  const mainSha = 'a'.repeat(40);
  const previousMainSha = 'b'.repeat(40);
  const devSha = 'c'.repeat(40);
  const releaseParentSha = 'd'.repeat(40);
  const tagTarget = tagSha || mainSha;
  const mainTree = '1'.repeat(40);
  const devTree = promotionTreeDrift ? '2'.repeat(40) : mainTree;
  return {
    mainSha,
    devSha,
    git: (args) => {
      if (args[0] === 'rev-parse' && args[2] === 'origin/main^{commit}') return mainSha;
      if (args[0] === 'rev-parse' && args[2] === 'origin/dev^{commit}') return devSha;
      if (args[0] === 'rev-parse' && args[2] === 'refs/tags/v1.2.3^{commit}') return tagTarget;
      if (args[0] === 'rev-parse' && args[2] === `${mainSha}^{tree}`) return mainTree;
      if (args[0] === 'rev-parse' && args[2] === `${devSha}^{tree}`) return devTree;
      if (args[0] === 'rev-list' && args.at(-1) === mainSha)
        return `${mainSha} ${previousMainSha} ${devSha}`;
      if (args[0] === 'rev-list' && args.at(-1) === devSha)
        return `${devSha} ${releaseParentSha} ${'e'.repeat(40)}`;
      if (args[0] === 'diff') {
        const changes = Object.values(releasePaths).map((filePath) => `A\t${filePath}`);
        if (extraDevChange) changes.push('A\tREADME.md');
        return changes.join('\n');
      }
      throw new Error(`Unexpected git call: ${args.join(' ')}`);
    },
  };
};

describe('release topology validation', () => {
  it('requires the tag to point to the current main promotion merge', () => {
    const topology = makeTopologyGit();
    expect(
      validateReleaseTopology({ tag: releaseTag, sha: topology.mainSha, git: topology.git })
    ).toMatchObject({
      mainSha: topology.mainSha,
      devSha: topology.devSha,
    });
  });

  it('rejects a tag that points to an older or unrelated commit', () => {
    const topology = makeTopologyGit({ tagSha: 'f'.repeat(40) });
    expect(() =>
      validateReleaseTopology({ tag: releaseTag, sha: topology.mainSha, git: topology.git })
    ).toThrow('does not point to the candidate');
  });

  it('rejects dev advancement or extra changes after the release PR', () => {
    const topology = makeTopologyGit({ extraDevChange: true });
    expect(() =>
      validateReleaseTopology({ tag: releaseTag, sha: topology.mainSha, git: topology.git })
    ).toThrow('not the exact release PR merge');
  });

  it('rejects a promotion merge whose final tree differs from dev', () => {
    const topology = makeTopologyGit({ promotionTreeDrift: true });
    expect(() =>
      validateReleaseTopology({ tag: releaseTag, sha: topology.mainSha, git: topology.git })
    ).toThrow('tree must exactly match');
  });

  it('validates a complete topology using real Git commands', () => {
    const repository = mkdtempSync(path.join(tmpdir(), 'cpamp-release-topology-'));
    const git = (args) =>
      execFileSync('git', args, {
        cwd: repository,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();

    try {
      git(['init', '--quiet', '--initial-branch=main']);
      git(['config', 'user.name', 'CI Test']);
      git(['config', 'user.email', 'ci-test@example.invalid']);
      git(['config', 'commit.gpgsign', 'false']);
      writeFileSync(path.join(repository, 'base.txt'), 'base\n');
      git(['add', 'base.txt']);
      git(['commit', '--quiet', '-m', 'base']);

      git(['switch', '--quiet', '-c', 'dev']);
      git(['switch', '--quiet', '-c', `release/${releaseTag}`]);
      mkdirSync(path.join(repository, 'docs', 'release-notes'), { recursive: true });
      mkdirSync(path.join(repository, 'docs', 'release-posts'), { recursive: true });
      for (const filePath of Object.values(releasePaths)) {
        writeFileSync(path.join(repository, filePath), `${filePath}\n`);
      }
      git(['add', 'docs']);
      git(['commit', '--quiet', '-m', 'release content']);

      git(['switch', '--quiet', 'dev']);
      git(['merge', '--quiet', '--no-ff', `release/${releaseTag}`, '-m', 'merge release']);
      const devSha = git(['rev-parse', 'HEAD']);
      git(['switch', '--quiet', 'main']);
      git(['merge', '--quiet', '--no-ff', 'dev', '-m', 'promote dev']);
      const mainSha = git(['rev-parse', 'HEAD']);
      git(['tag', releaseTag, mainSha]);

      expect(
        validateReleaseTopology({
          tag: releaseTag,
          sha: mainSha,
          mainRef: 'refs/heads/main',
          devRef: 'refs/heads/dev',
          git,
        })
      ).toMatchObject({ mainSha, devSha });
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});

// 真实 Git 对象/祖先/索引/工作树验证；共享对象只读，不依赖网络或新建产品 worktree。
const historicalSource = '794ef828023960ccad0a2e9848293aee0880d688';
const sourceRoot = path.resolve(import.meta.dirname, '..');
const historicalTags = ['v1.11.0', 'v1.11.1', 'v1.11.2', 'v1.11.3'];
const historicalPaths = historicalTags.flatMap((tag) =>
  ['en', 'zh'].map((language) => `docs/release-notes/${tag}-${language}.md`)
);
const historicalRepository = '0xTract0r/CPA-Manager-Plus';
const historicalBase = 'a425737d886283b2062cd87731b5c1d44881e79f';
const allHistoricalTags = [
  'v1.11.0',
  'v1.11.1',
  'v1.11.10',
  'v1.11.11',
  'v1.11.12',
  'v1.11.2',
  'v1.11.3',
  'v1.11.4',
  'v1.11.5',
  'v1.11.6',
  'v1.11.7',
  'v1.11.8',
  'v1.11.9',
  'v1.12.0',
  'v1.12.0-beta1',
  'v1.12.0-beta2',
  'v1.12.0-beta3',
  'v1.12.0-rc.1',
  'v1.12.0-rc.2',
  'v1.12.0-rc.3',
  'v1.12.1',
  'v1.12.10',
  'v1.12.11',
  'v1.12.12',
  'v1.12.13',
  'v1.12.14',
  'v1.12.2',
  'v1.12.3',
  'v1.12.4',
  'v1.12.5',
  'v1.12.6',
  'v1.12.7',
  'v1.12.8',
  'v1.12.9',
  'v1.13.0',
  'v1.13.1',
  'v1.13.2',
  'v1.14.0',
  'v1.14.1',
  'v1.14.2',
  'v1.14.3',
  'v1.14.4',
  'v1.14.5',
  'v1.14.6',
  'v1.14.7',
  'v1.14.8',
  'v1.14.9',
];
const allHistoricalPaths = execFileSync(
  'git',
  [
    'ls-tree',
    '-r',
    '--name-only',
    historicalSource,
    '--',
    'docs/release-notes',
    'docs/release-posts',
  ],
  { cwd: sourceRoot, encoding: 'utf8' }
)
  .trim()
  .split('\n')
  .filter((filePath) =>
    allHistoricalTags.some(
      (tag) =>
        filePath.startsWith(`docs/release-notes/${tag}-`) ||
        filePath.startsWith(`docs/release-posts/${tag}-`)
    )
  );

const withHistoricalGitFixture = (callback, { missingSource = false } = {}) => {
  const repository = mkdtempSync(path.join(tmpdir(), 'cpamp-historical-release-'));
  const git = (args) =>
    execFileSync('git', args, {
      cwd: repository,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  try {
    if (missingSource) git(['init', '--quiet', '--initial-branch=main']);
    else {
      execFileSync(
        'git',
        ['clone', '--quiet', '--shared', '--no-checkout', sourceRoot, repository],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      git(['read-tree', historicalSource]);
    }
    git(['config', 'user.name', 'CI Test']);
    git(['config', 'user.email', 'ci-test@example.invalid']);
    git(['config', 'commit.gpgsign', 'false']);
    const write = (filePath, content) => {
      mkdirSync(path.dirname(path.join(repository, filePath)), { recursive: true });
      writeFileSync(path.join(repository, filePath), content);
    };
    for (const filePath of allHistoricalPaths) {
      write(
        filePath,
        execFileSync('git', ['show', `${historicalSource}:${filePath}`], { cwd: sourceRoot })
      );
    }
    if (missingSource) {
      git(['add', 'docs']);
      git(['commit', '--quiet', '-m', 'unproven notes copy']);
    }
    const fileExists = (filePath) =>
      existsSync(path.join(repository, path.relative(sourceRoot, filePath)));
    const readFile = (filePath) =>
      readFileSync(path.join(repository, path.relative(sourceRoot, filePath)), 'utf8');
    const validate = (overrides = {}) =>
      validateChangedReleaseContent({
        changedFiles: historicalPaths,
        repository: historicalRepository,
        baseSha: historicalBase,
        git,
        readFile,
        fileExists,
        ...overrides,
      });
    return callback({ git, write, validate, readFile, fileExists, repository });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
};

describe('fixed upstream historical note imports (real Git)', () => {
  it('records the exact 137-file/47-tag historical import shapes with fixed provenance', () => {
    withHistoricalGitFixture(({ validate }) => {
      expect(allHistoricalPaths).toHaveLength(137);
      const result = validate({ changedFiles: allHistoricalPaths });
      expect(result.tags).toEqual(allHistoricalTags);
      expect(result.releases).toEqual([]);
      expect(result.historicalImports).toHaveLength(47);
      expect(result.historicalImports.flatMap(({ files }) => files)).toHaveLength(137);
      expect(
        new Set(
          result.historicalImports.flatMap(({ files }) =>
            files.map(({ path: filePath }) => filePath)
          )
        ).size
      ).toBe(137);
      for (const imported of result.historicalImports) {
        expect(imported).toMatchObject({
          sourceRepository: 'seakee/CPA-Manager-Plus',
          sourceCommit: historicalSource,
        });
        expect(imported.files.map(({ path: filePath }) => filePath).sort()).toEqual(
          allHistoricalPaths
            .filter(
              (filePath) =>
                (/^docs\/release-notes\/(.+)-(?:en|zh)\.md$/.exec(filePath) ||
                  /^docs\/release-posts\/(.+)-telegram\.html$/.exec(filePath))?.[1] === imported.tag
            )
            .sort()
        );
        expect(
          imported.files.every(({ blob, mode }) => /^[a-f0-9]{40}$/.test(blob) && mode === '100644')
        ).toBe(true);
      }
    });
  });

  it.each(['seakee/CPA-Manager-Plus', 'another/CPA-Manager-Plus', undefined])(
    'retains full bundle validation outside the exact fork (%s)',
    (repository) => {
      withHistoricalGitFixture(({ validate }) => {
        expect(() => validate({ repository })).toThrow('Missing required release files');
      });
    }
  );

  it.each(['en', 'zh'])('rejects a one-byte working-tree change to only %s', (language) => {
    withHistoricalGitFixture(({ validate, write, repository }) => {
      const filePath = `docs/release-notes/v1.11.0-${language}.md`;
      write(filePath, readFileSync(path.join(repository, filePath), 'utf8') + ' ');
      expect(() => validate()).toThrow('Missing required release files');
    });
  });

  it('rejects a committed one-language change even when the worktree matches HEAD', () => {
    withHistoricalGitFixture(({ validate, write, git, repository }) => {
      const filePath = 'docs/release-notes/v1.11.0-en.md';
      write(filePath, readFileSync(path.join(repository, filePath), 'utf8') + ' ');
      git(['add', '--', filePath]);
      git(['commit', '--quiet', '-m', 'changed historical note']);
      expect(() => validate()).toThrow('Missing required release files');
    });
  });

  it('does not exempt a single-language import or an absent counterpart', () => {
    withHistoricalGitFixture(({ validate, repository }) => {
      expect(() => validate({ changedFiles: [historicalPaths[0]] })).toThrow(
        'Missing required release files'
      );
      rmSync(path.join(repository, historicalPaths[1]));
      expect(() => validate()).toThrow('Missing required release files');
    });
  });

  it('does not exempt a new tag even with notes copied from upstream history', () => {
    withHistoricalGitFixture(({ validate, write, repository }) => {
      const changedFiles = ['en', 'zh'].map(
        (language) => `docs/release-notes/v9.9.9-${language}.md`
      );
      for (let index = 0; index < 2; index += 1) {
        write(changedFiles[index], readFileSync(path.join(repository, historicalPaths[index])));
      }
      expect(() => validate({ changedFiles })).toThrow('Missing required release files');
    });
  });

  it.each([false, true])('new Telegram content requires the full bundle (listed=%s)', (listed) => {
    withHistoricalGitFixture(({ validate, write }) => {
      const telegram = 'docs/release-posts/v1.11.0-telegram.html';
      write(telegram, '<script>not a release</script>');
      const changedFiles = listed ? [...historicalPaths, telegram] : historicalPaths;
      expect(() => validate({ changedFiles })).toThrow();
    });
  });

  it('does not trust matching notes when the fixed upstream is not an ancestor', () => {
    withHistoricalGitFixture(({ validate, git }) => {
      const root = git(['commit-tree', `${historicalSource}^{tree}`, '-m', 'unrelated root']);
      git(['update-ref', 'HEAD', root]);
      expect(() => validate()).toThrow('Missing required release files');
    });
  });

  it('fails closed when the source object is unavailable', () => {
    withHistoricalGitFixture(
      ({ validate }) => {
        expect(() => validate()).toThrow('Missing required release files');
      },
      { missingSource: true }
    );
  });

  it('fails closed when a shallow boundary prevents proving provenance', () => {
    withHistoricalGitFixture(({ validate, git, repository }) => {
      writeFileSync(path.join(repository, '.git', 'shallow'), `${git(['rev-parse', 'HEAD'])}\n`);
      expect(() => validate()).toThrow('Missing required release files');
    });
  });

  it('still validates ordinary bundles alongside the historical imports', () => {
    withHistoricalGitFixture(({ validate, write }) => {
      write(releasePaths.chinese, chineseNotes);
      write(releasePaths.english, englishNotes);
      write(releasePaths.telegram, telegramPost);
      const changedFiles = [...historicalPaths, ...Object.values(releasePaths)];
      expect(validate({ changedFiles })).toMatchObject({
        historicalImports: expect.any(Array),
        releases: [expect.objectContaining({ paths: releasePaths })],
      });
      write(releasePaths.chinese, notesWithoutMetadata);
      expect(() => validate({ changedFiles })).toThrow(
        'Release notes require exactly one cpamp-update JSON comment'
      );
    });
  });

  it.each([undefined, 'HEAD'])('requires proven base additions (base=%s)', (base) => {
    withHistoricalGitFixture(({ validate, git }) => {
      const baseSha = base ? git(['rev-parse', base]) : undefined;
      expect(() => validate({ baseSha })).toThrow('Missing required release files');
    });
  });

  it.each(['worktree', 'index'])('rejects mode changes in the %s', (where) => {
    withHistoricalGitFixture(({ validate, git, repository }) => {
      const filePath = historicalPaths[0];
      if (where === 'worktree') chmodSync(path.join(repository, filePath), 0o755);
      else git(['update-index', '--chmod=+x', '--', filePath]);
      expect(() => validate()).toThrow('Missing required release files');
    });
  });

  it('rejects even ignored extra files in the same historical tag', () => {
    withHistoricalGitFixture(({ validate, write, git, repository }) => {
      const extra = 'docs/release-notes/v1.11.0-draft.json';
      writeFileSync(path.join(repository, '.git/info/exclude'), extra + '\n');
      write(extra, '{}');
      expect(git(['check-ignore', extra])).toBe(extra);
      expect(() => validate()).toThrow('Missing required release files');
    });
  });

  it('rejects a changed historical bundle shape when an existing post is removed', () => {
    withHistoricalGitFixture(({ validate, repository }) => {
      rmSync(path.join(repository, 'docs/release-posts/v1.11.4-telegram.html'));
      expect(() => validate({ changedFiles: allHistoricalPaths })).toThrow(
        'Missing required release files'
      );
    });
  });

  it('retains all original historical publishing checks: 4 missing posts, 26 old metadata, 17 complete', () => {
    withHistoricalGitFixture(({ readFile, fileExists }) => {
      const failures = [];
      const passed = [];
      for (const tag of allHistoricalTags) {
        try {
          validateReleaseContent({ tag, readFile, fileExists });
          passed.push(tag);
        } catch (error) {
          failures.push({ tag, message: error.message });
        }
      }
      expect(passed).toHaveLength(17);
      expect(
        failures.filter(({ message }) => message.startsWith('Missing required release files'))
      ).toHaveLength(4);
      expect(
        failures.filter(
          ({ message }) => message === 'Release notes require exactly one cpamp-update JSON comment'
        )
      ).toHaveLength(26);
    });
  });

  it.each([
    ['pull_request', 'M'],
    ['pull_request', 'D'],
    ['pull_request', 'T'],
    ['pull_request', 'mode'],
    ['push', 'M'],
    ['initial-push', 'M'],
  ])(
    'collects real %s/%s changes and applies full validation instead of historical import',
    (event, change) => {
      withHistoricalGitFixture(({ validate, git, write, repository }) => {
        git(['read-tree', 'HEAD']);
        git(['config', 'core.filemode', 'true']);
        const baseSha = git(['rev-parse', 'HEAD']);
        const filePath = historicalPaths[0];
        if (change === 'D') git(['rm', '--quiet', '--', filePath]);
        else {
          if (change === 'T') {
            rmSync(path.join(repository, filePath));
            symlinkSync('v1.11.0-zh.md', path.join(repository, filePath));
          } else if (change === 'mode') chmodSync(path.join(repository, filePath), 0o755);
          else write(filePath, readFileSync(path.join(repository, filePath), 'utf8') + ' ');
          git(['add', '--', filePath]);
        }
        git(['commit', '--quiet', '-m', 'change an already imported historical entry']);
        const head = git(['rev-parse', 'HEAD']);
        // 执行真实工作流的收集脚本，不复制另一份近似实现或只断言源码字符串。
        const workflow = readFileSync(
          path.join(sourceRoot, '.github/workflows/pr-check.yml'),
          'utf8'
        );
        const job = workflow.slice(workflow.indexOf('  release-content:'));
        const collector = job
          .slice(
            job.indexOf('          changed_files='),
            job.indexOf('          npm run --silent release:validate')
          )
          .split('\n')
          .map((line) => line.replace(/^          /, ''))
          .join('\n');
        execFileSync('bash', ['-c', 'set -euo pipefail\n' + collector], {
          cwd: repository,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            RUNNER_TEMP: repository,
            EVENT_NAME: event === 'pull_request' ? 'pull_request' : 'push',
            PR_BASE_SHA: baseSha,
            PR_HEAD_SHA: head,
            PUSH_BEFORE_SHA: event === 'initial-push' ? '0'.repeat(40) : baseSha,
            CURRENT_SHA: head,
          },
        });
        const changedFiles = readFileSync(
          path.join(repository, 'release-content-changed-files.bin'),
          'utf8'
        )
          .split('\0')
          .filter(Boolean);
        expect(changedFiles).toEqual([filePath]);
        expect(() => validate({ changedFiles, baseSha })).toThrow('Missing required release files');
      });
    }
  );

  it('keeps explicit historical publication subject to the original three-file rule', () => {
    withHistoricalGitFixture(({ readFile, fileExists }) => {
      expect(() => validateReleaseContent({ tag: 'v1.11.0', readFile, fileExists })).toThrow(
        'Missing required release files'
      );
    });
    expect(() =>
      execFileSync(
        process.execPath,
        [
          path.join(sourceRoot, 'bin/release/validate-release.mjs'),
          '--tag',
          'v1.11.0',
          '--content-only',
          '--repository',
          historicalRepository,
        ],
        { cwd: sourceRoot, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    ).toThrow();
  });
});
