import {execFileSync} from 'node:child_process'

// Derives the app's displayed version straight from git tags instead of a
// hand-bumped package.json field - cutting a release is just tagging a
// commit (e.g. `git tag v0.1.0 && git push origin v0.1.0`). On an exact tag
// this is just "v0.1.0"; ahead of one it's "v0.1.0-3-gabc1234"; with no
// tags reachable at all it's just the short hash. `fallback` covers builds
// outside a git checkout entirely (e.g. a downloaded source archive).
export function gitVersion(fallback) {
  try {
    // execFileSync (argv form, no shell) rather than execSync: the args
    // are fixed literals here, not attacker input, but this keeps it that
    // way even if that ever changes - no shell means no shell metacharacter
    // to worry about in the first place. stdin is ignored too, so a repo
    // state that would otherwise make git prompt (e.g. missing gpg for a
    // signed tag) can't hang the build waiting on input.
    return execFileSync('git', ['describe', '--tags', '--always', '--dirty'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      maxBuffer: 4096,
      windowsHide: true
    })
      .toString()
      .trim()
  } catch {
    return fallback
  }
}
