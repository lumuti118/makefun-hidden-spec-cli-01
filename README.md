# mend — one patch tool for every AI edit format

![competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)
![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lumuti118/makefun-hidden-spec-cli-01/rank.svg)
![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lumuti118/makefun-hidden-spec-cli-01/reward.svg)

`mend` is a small command-line tool that applies AI-written edits to a tree of text
files. Models write edits in four formats — unified diffs (often with wrong line
numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON —
and `mend` reads all four to one written contract (`SPEC.md`), finds the lines each
edit names even when the model drifted their whitespace or indentation, and changes
every file or none.

Matching works in three tiers: exact lines first, then lines equal once trailing
whitespace is ignored, then lines equal once leading and trailing whitespace is
ignored (`--strict` keeps only the exact tier). A patch that changes nothing prints
`ok: 0 files`; a patch with failures reports every failed edit and writes nothing.

## Run it

Node 22 and its standard library only — nothing to install:

```sh
node main.ts [options] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory; when it is absent
  or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`, `json`, or
  `auto` (the default, which detects it).
- `--check` does everything but write: same output and exit code, no file created,
  changed, or deleted.
- `--strict` matches lines exactly (tier 0 only).

Examples:

```sh
node main.ts fix.patch
cat fix.patch | node main.ts --format=unified -
node main.ts --check --strict edits.json
```

Exit codes: `0` applied, `1` one or more edits failed (nothing written), `2`
usage, missing patch file, unknown format, or unparsable patch.

## Practice checks

The kit's practice set (100 checks) runs locally with:

```sh
node check.ts ../kit/hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
```

This entry passes **100 of 100** practice checks (practice score 1000):
unified 30/30, search_replace 20/20, v4a 20/20, json 15/15, cli 15/15.

## The files

- `main.ts` — the CLI.
- `runner.ts` — the kit's runner, kept as it is; in a trial it runs `main.ts` on
  each check and posts the results.
- `check.ts` — runs the practice set against `main.ts` on this machine.
- `SPEC.md` — the specification; the whole contract.
- `LICENSE` — MIT.

---

Built for [make.fun](https://make.fun/r/7vjqmhmr) — one patch tool for every AI edit format.
