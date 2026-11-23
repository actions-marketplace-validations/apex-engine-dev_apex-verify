#!/usr/bin/env python3
"""Run the sessions. usage: run.py [--only arm/task/run ...] [--model M] [--jobs 3]"""
import json, os, shutil, subprocess, sys, time, signal, argparse, re
from concurrent.futures import ThreadPoolExecutor
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.join(os.path.dirname(H), "publish2", "apex-engine")
APEX = os.path.join(REPO, "dist", "apex.mjs"); TASKS = os.path.join(REPO, "benchmark", "tasks")
WRAP = os.path.join(H, "scripts", "hookwrap.mjs")
LIMIT = 480

def task_list():
    names = sorted(os.listdir(TASKS))
    return [n for n in names if not n.startswith("real-")] + [n for n in names if n.startswith("real-")][:8]

def sh(args, cwd):
    subprocess.run(args, cwd=cwd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def attempt(arm, task, run, model, tryno):
    proj = os.path.join(H, "runs", arm, task, f"r{run}", "project"); data = os.path.join(H, "data", arm, task, f"r{run}")
    for d in (os.path.dirname(proj), data): shutil.rmtree(d, ignore_errors=True)
    os.makedirs(data); shutil.copytree(os.path.join(TASKS, task, "project"), proj)
    sh(["git", "init", "-q"], proj); sh(["git", "add", "-A"], proj)
    sh(["git", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-q", "-m", "start"], proj)
    with open(os.path.join(proj, ".git", "info", "exclude"), "a") as f: f.write(".gemini/\n")
    if arm in "BC":
        os.makedirs(os.path.join(proj, ".gemini"))
        json.dump({"hooksConfig": {"enabled": True}, "hooks": {"AfterAgent": [{"hooks": [{"type": "command",
            "command": f"node {WRAP} {data} {arm} {APEX}", "timeout": 300000}]}]}}, open(os.path.join(proj, ".gemini", "settings.json"), "w"))
    prompt = json.load(open(os.path.join(TASKS, task, "task.json")))["prompt"]
    t0 = time.time(); timeout = False
    with open(os.path.join(data, "gemini.out"), "w") as out:
        p = subprocess.Popen(["gemini", "-m", model, "-p", prompt, "--yolo"], cwd=proj, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
        try: code = p.wait(timeout=LIMIT)
        except subprocess.TimeoutExpired:
            timeout = True; os.killpg(p.pid, signal.SIGKILL); code = p.wait()
    text = open(os.path.join(data, "gemini.out"), errors="replace").read()
    hook_err = False
    sd = os.path.join(data, "snaps")
    if os.path.isdir(sd):
        for s in os.listdir(sd):
            f = os.path.join(sd, s, "stdout.raw.json")
            if os.path.exists(f) and "could not verify" in open(f).read(): hook_err = True
    failed = (not timeout and code != 0) or hook_err
    meta = {"arm": arm, "task": task, "run": run, "model": model, "try": tryno, "exit": code, "timeout": timeout, "seconds": round(time.time() - t0, 1),
            "hook_error": hook_err, "failed": failed, "api_error_text": bool(re.search(r"\b429\b|RESOURCE_EXHAUSTED|quota|\b50[03]\b|UNAVAILABLE", text))}
    return meta

def session(job):
    arm, task, run, model = job
    data = os.path.join(H, "data", arm, task, f"r{run}")
    if os.path.exists(os.path.join(data, "meta.json")): return json.load(open(os.path.join(data, "meta.json")))
    m = attempt(arm, task, run, model, 1); first = None
    if m["failed"]:
        first = dict(m); shutil.copy(os.path.join(data, "gemini.out"), os.path.join(H, "data", f"failed-first-try-{arm}-{task}-r{run}.out"))
        m = attempt(arm, task, run, model, 2)
    m["first_try"] = first
    json.dump(m, open(os.path.join(data, "meta.json"), "w"), indent=1)
    print(time.strftime("%H:%M:%S"), arm, task, run, "exit", m["exit"], "timeout" if m["timeout"] else "", "FAILED" if m["failed"] else "", f"{m['seconds']}s", flush=True)
    return m

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--only", nargs="*"); ap.add_argument("--model", default="gemini-2.5-flash-lite"); ap.add_argument("--jobs", type=int, default=3)
    a = ap.parse_args()
    jobs = [(arm, t, r, a.model) for r in (1, 2) for t in task_list() for arm in "ABC"]
    if a.only: jobs = [j for j in jobs if f"{j[0]}/{j[1]}/{j[2]}" in a.only]
    with ThreadPoolExecutor(a.jobs) as ex: list(ex.map(session, jobs))
