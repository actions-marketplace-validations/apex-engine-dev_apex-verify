# Example: "it said done"

An AI was asked (see `task.txt`) to fix a slug function so it returns *lowercase letters and digits separated by single dashes*. Its change (`agent-change.diff`) fixes the case in the project's own test, so the project's tests pass. It is still wrong: `"Hello -- World"` becomes `hello---world`.

```sh
export GEMINI_API_KEY=...
cd examples/said-done
npx --yes https://github.com/apex-engine-dev/apex-verify/releases/latest/download/reallydone.tgz verify "$(cat task.txt)" --dir project --diff agent-change.diff
```

Expected: `NOT READY`, naming the failing check with expected and actual values (the wording of the checks varies run to run, the verdict was `not ready` in every one of our runs on this example). Without a key, `--no-model` gives `UNKNOWN`: the tests pass and nothing was tampered with, but nothing proves the change does what the task says. That gap is what ReallyDone is for.

The project is untouched: `project/` is only read.
