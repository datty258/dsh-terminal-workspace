# Publishing checklist

The repository is pushed to <https://github.com/datty258/dsh-terminal-workspace>
and the package is ready. What remains needs npm credentials.

## 1. Push the repository — done

<https://github.com/datty258/dsh-terminal-workspace> is public, `main` is pushed.
Push any later commit with `git push`.

The repository must be at least **1 day old** before awesome-dsh-plugin's gate
accepts it (created 2026-11-26).

## 2. Publish to npm

```sh
npm publish
```

`dsh-terminal-workspace` is free on npm (verified 404). A prebuilt npm
package means users skip the `allowBuilds` approval step, and it makes the
entry installable through mainland mirrors.

Verify before submitting:

```sh
curl -s https://registry.npmjs.org/dsh-terminal-workspace | \
  jq -r '.versions[."dist-tags".latest".dist.tarball"]'
```

A brand-new name is often not installable the moment `npm publish` returns —
confirm `dist-tags.latest` equals `0.1.0` **and** the tarball downloads.

## 3. awesome-dsh-plugin

Open a PR adding exactly one file, `data/plugins/datty258__dsh-terminal-workspace.yml`
(a copy is in `submission/`). This is the index DSH's built-in Discover tab reads.

CI checks: at most 3 entries per PR, `dsh.bundle` present in the repo, repo age
≥ 1 day, awesome-lint, and that the READMEs regenerate. A maintainer then reads
the repository against the description.

## 4. dsh.so

Paste the repo or npm name into <https://dsh.so/submit/>. It runs its own
security scan and install verification; acceptance needs an SPDX license
(`MIT` is set), a README with install instructions, and scannable source.

## 5. dshopen (Open Plugin Market)

<https://github.com/polang233/dsh-plugin-index/issues/new?template=plugin-add.yml>
— filed as an issue rather than a PR.

## Regenerating the tarball

```sh
npm pack
```

`files` in `package.json` is the authority; `vendor/` stays out of the tarball
and only the built `client/client.xterm.js` ships.
