# Accuracy bench

The tools we use to measure the scanner on real public code. Repos are cloned shallow and only read: nothing in
them is installed, built or run.

| Script | What it does |
|---|---|
| `discover.ts` | Finds public repos that call the APIs we cover (GitHub search, metadata only) |
| `grow.ts` | Adds repos to the corpus list (`bench/corpus.txt`) |
| `corpus.ts` | Scans every corpus repo at a pinned commit (`bench/corpus.lock.json`) |
| `sample.ts` | Builds a labelling queue: findings to judge (precision) and places to check (recall) |
| `label.ts` | A local page (127.0.0.1 only) for labelling the queue, one place at a time |
| `rescore.ts`, `accuracy.ts` | Precision and recall from the labels |
| `gate.ts` | Fails if any rule got less accurate than the saved baseline |
| `weekly.ts` | A fresh real-world sample each week |

**Not in this repo:** our corpus list, pinned commits, human labels, baseline, labelling queues and weekly reports.
They name other people's repos and what was found in them, so we keep them private. To run the bench yourself,
make a `bench/corpus.txt` (one `owner/repo` per line) and point the scripts at a feed with `--feed <dir>`.
