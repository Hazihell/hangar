const fs = require('fs');
const path = require('path');
const semver = require('semver');
const { execFileSync } = require('child_process');

const bumpType = process.argv[2] || 'patch';
const validBumpTypes = ['major', 'minor', 'patch'];
const projectRoot = process.cwd();
const packageJsonPath = path.resolve(projectRoot, 'package.json');

const sectionTitles = {
  feat: 'Features',
  fix: 'Fixes',
  perf: 'Performance',
  refactor: 'Refactors',
  docs: 'Documentation',
  test: 'Tests',
  build: 'Maintenance',
  chore: 'Maintenance',
  ci: 'Maintenance',
  revert: 'Reverts',
  other: 'Other Changes',
};

const sectionOrder = [
  'Features',
  'Fixes',
  'Performance',
  'Refactors',
  'Documentation',
  'Tests',
  'Maintenance',
  'Reverts',
  'Other Changes',
];

const releaseTitleTypeOrder = [
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
  'test',
  'build',
  'chore',
  'ci',
  'revert',
  'other',
];

if (!validBumpTypes.includes(bumpType)) {
  console.error(`Invalid bump type: ${bumpType}. Must be one of ${validBumpTypes.join(', ')}.`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function runStreaming(command, args) {
  execFileSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
  });
}

function getPreviousTag() {
  try {
    return run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*']);
  } catch {
    return null;
  }
}

function getCommitSubjects(previousTag) {
  const range = previousTag ? `${previousTag}..HEAD` : 'HEAD';
  const output = run('git', ['log', '--pretty=format:%s', range]);
  return output ? output.split('\n').map((line) => line.trim()).filter(Boolean) : [];
}

function parseCommit(subject) {
  const conventionalMatch = subject.match(/^([a-z]+)(\(([^)]+)\))?(!)?:\s*(.+)$/i);

  if (!conventionalMatch) {
    return {
      description: subject,
      section: sectionTitles.other,
      scope: null,
      line: `- ${subject}`,
      type: 'other',
    };
  }

  const [, rawType, , scope, , description] = conventionalMatch;
  const rawTypeLower = rawType.toLowerCase();
  const type = sectionTitles[rawTypeLower] ? rawTypeLower : 'other';
  const section = sectionTitles[type] || sectionTitles.other;
  const scopedDescription = scope ? `[${scope}] ${description}` : description;

  return {
    description,
    section,
    scope: scope || null,
    line: `- ${scopedDescription}`,
    type,
  };
}

function capitalize(text) {
  if (!text) {
    return text;
  }

  return text.charAt(0).toUpperCase() + text.slice(1);
}

function humanizeScope(scope) {
  return scope
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => capitalize(part))
    .join(' ');
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function buildReleaseTitle({ newVersion, commitSubjects }) {
  const titleSuffix = ` (v${newVersion})`;
  const maxTitleLength = 96;
  const maxCoreLength = maxTitleLength - titleSuffix.length;

  if (commitSubjects.length === 0) {
    return `Release v${newVersion}`;
  }

  const rankedCommits = commitSubjects
    .map((subject, index) => {
      const parsedCommit = parseCommit(subject);

      return {
        ...parsedCommit,
      index,
        priority: releaseTitleTypeOrder.indexOf(parsedCommit.type),
      };
    })
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }

      return left.index - right.index;
    });

  const primaryCommit = rankedCommits[0];
  const noteworthyTypes = new Set(['feat', 'fix', 'perf', 'refactor']);
  const hasAdditionalNoteworthyCommit = rankedCommits.some(
    (entry) => entry.index !== primaryCommit.index && noteworthyTypes.has(entry.type)
  );

  let titleCore = primaryCommit.scope
    ? `${humanizeScope(primaryCommit.scope)}: ${primaryCommit.description}`
    : primaryCommit.type !== 'other'
      ? `${sectionTitles[primaryCommit.type]}: ${primaryCommit.description}`
      : primaryCommit.description;

  titleCore = capitalize(titleCore.trim().replace(/\.+$/, ''));

  if (hasAdditionalNoteworthyCommit) {
    titleCore = `${titleCore} and other updates`;
  }

  return `${truncateText(titleCore, maxCoreLength)}${titleSuffix}`;
}

function getGitHubRepoSlug() {
  try {
    const remoteUrl = run('git', ['remote', 'get-url', 'origin']).replace(/\.git$/, '');
    const match = remoteUrl.match(/github\.com[:/]([^\s]+\/[^\s]+)$/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function buildReleaseNotes({ newVersion, previousTag, commitSubjects }) {
  const notes = ['## Changelog'];

  if (commitSubjects.length === 0) {
    notes.push('', '- No project commits found since the previous release.');
  } else {
    const grouped = new Map();

    for (const section of sectionOrder) {
      grouped.set(section, []);
    }

    for (const subject of commitSubjects) {
      const { section, line } = parseCommit(subject);
      grouped.get(section).push(line);
    }

    for (const section of sectionOrder) {
      const lines = grouped.get(section);

      if (!lines || lines.length === 0) {
        continue;
      }

      notes.push('', `### ${section}`, '', ...lines);
    }
  }

  if (previousTag) {
    const repoSlug = getGitHubRepoSlug();
    const tagName = `v${newVersion}`;

    notes.push('', '## Compare', '');

    if (repoSlug) {
      notes.push(`- https://github.com/${repoSlug}/compare/${previousTag}...${tagName}`);
    } else {
      notes.push(`- ${previousTag}...${tagName}`);
    }
  }

  return notes.join('\n');
}

if (!fs.existsSync(packageJsonPath)) {
  console.error('package.json not found in the project root.');
  process.exit(1);
}

const originalPackageJson = fs.readFileSync(packageJsonPath, 'utf8');
let packageJson;

try {
  packageJson = JSON.parse(originalPackageJson);
} catch (error) {
  console.error(`Failed to parse package.json: ${error.message}`);
  process.exit(1);
}

const currentVersion = packageJson.version;

if (!semver.valid(currentVersion)) {
  console.error(`Current version is not valid semver: ${currentVersion}`);
  process.exit(1);
}

const newVersion = semver.inc(currentVersion, bumpType);

if (!newVersion) {
  console.error(`Unable to calculate next version from ${currentVersion} using bump type ${bumpType}.`);
  process.exit(1);
}

let committed = false;

try {
  if (run('git', ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    throw new Error('Current directory is not inside a git repository.');
  }

  const gitRoot = run('git', ['rev-parse', '--show-toplevel']);
  if (path.resolve(gitRoot) !== projectRoot) {
    throw new Error('Run the release script from the git repository root.');
  }

  const worktreeStatus = run('git', ['status', '--porcelain']);
  if (worktreeStatus) {
    throw new Error('Release requires a clean working tree. Commit or stash changes first.');
  }

  run('gh', ['auth', 'status']);

  const previousTag = getPreviousTag();
  const commitSubjects = getCommitSubjects(previousTag);

  if (previousTag && commitSubjects.length === 0) {
    throw new Error(`No commits found since ${previousTag}. Refusing to create an empty release.`);
  }

  const releaseNotes = buildReleaseNotes({
    newVersion,
    previousTag,
    commitSubjects,
  });
  const releaseTitle = buildReleaseTitle({
    newVersion,
    commitSubjects,
  });

  packageJson.version = newVersion;
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
  console.log(`Bumped version from ${currentVersion} to ${newVersion}.`);

  runStreaming('git', ['add', packageJsonPath]);
  runStreaming('git', ['commit', '-m', `chore(release): ${releaseTitle}`]);
  committed = true;
  console.log('Committed version bump.');

  const tagName = `v${newVersion}`;
  runStreaming('git', ['tag', '-a', tagName, '-m', releaseTitle]);
  console.log(`Created git tag ${tagName}.`);

  runStreaming('git', ['push', '--follow-tags']);
  console.log('Pushed commit and tag to remote.');

  runStreaming('gh', ['release', 'create', tagName, '--title', releaseTitle, '--notes', releaseNotes]);
  console.log(`Successfully created GitHub release ${tagName}.`);
} catch (error) {
  if (!committed) {
    fs.writeFileSync(packageJsonPath, originalPackageJson);
  }

  console.error('An error occurred during the release process:', error.message);
  process.exit(1);
}
