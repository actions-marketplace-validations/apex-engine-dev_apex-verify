# Example: "it said done"

An AI was asked (see `task.txt`) to fix a slug function so it returns *lowercase letters and digits separated by single dashes*. Its change (`agent-change.diff`) fixes the case in the project's own test, so the project's tests pass. It is still wrong: `"Hello -- World"` becomes `hello---world`.

```sh
export GEMINI_API_KEY=...
cd examples/said-done
npx --yes https://github.com/apex-engine-dev/apex-verify/releases/latest/download/apex-verify.tgz verify "$(cat task.txt)" --dir project --diff agent-change.diff
```

Expected: `NOT READY`, naming the failing checks with expected and actual values. The wording of the checks changes from run to run. In our most recent 11 runs on this example the verdict was `not ready` 10 times, and once `unknown`: the "second look" judged one of two failing checks too strict and softened the whole verdict, even though the other check was clearly right. (That is a known weakness, tracked in issue #15.) Without a key, `--no-model` gives `UNKNOWN`: the tests pass and nothing was tampered with, but nothing proves the change does what the task says. That gap is what Apex verify is for.

The project is untouched: `project/` is only read.
