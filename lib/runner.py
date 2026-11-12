#!/usr/bin/env python3
"""Run one shell skill in an isolated child process.

Usage:
    python runner.py <root> <skill> [json-arguments]

The entry module is loaded as a package so relative imports inside the skill
folder (`from ._impl import ...`) resolve, exactly like shell-tool's in-process
import. Anything the skill prints is redirected to stderr; stdout carries one
JSON envelope:

    {"status": "ok", "result": <json-or-string>}
    {"status": "error", "message": "..."}

The process always exits 0 for a skill-level failure so the Host can read the
envelope; a non-zero exit means the interpreter itself failed.
"""

import importlib.util
import json
import os
import sys
import traceback
import types


def _load(root: str, skill: str):
    """Load `<root>/<skill>/skill.py` as a package module and return it."""
    skill_dir = os.path.join(root, skill)
    entry = os.path.join(skill_dir, "skill.py")
    if not os.path.isfile(entry):
        raise FileNotFoundError(f"skill entry not found: {entry}")

    # A synthetic parent package gives relative imports a home without relying
    # on the root directory name (which may contain characters Python cannot
    # use in an import statement, such as `shell-skills`).
    if skill not in sys.modules:
        package = types.ModuleType(skill)
        package.__path__ = [skill_dir]
        package.__package__ = skill
        sys.modules[skill] = package

    module_name = f"{skill}.skill"
    spec = importlib.util.spec_from_file_location(module_name, entry)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load skill module: {entry}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _jsonable(value):
    """Serialize the skill's return value, falling back to its text form."""
    try:
        json.dumps(value, ensure_ascii=False)
        return value
    except (TypeError, ValueError):
        return str(value)


def main() -> None:
    # Node reads these pipes as UTF-8 regardless of the Windows console default.
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    real_stdout = sys.stdout
    if len(sys.argv) < 3:
        real_stdout.write(json.dumps({"status": "error", "message": "usage: runner.py <root> <skill> [json]"}))
        real_stdout.flush()
        return

    root = os.path.abspath(sys.argv[1])
    skill = sys.argv[2]
    raw_arguments = sys.argv[3] if len(sys.argv) > 3 else "{}"

    try:
        arguments = json.loads(raw_arguments) if raw_arguments.strip() else {}
        if not isinstance(arguments, dict):
            raise ValueError("arguments must be a JSON object")
    except (TypeError, ValueError) as error:
        real_stdout.write(json.dumps({"status": "error", "message": f"invalid arguments: {error}"}, ensure_ascii=False))
        real_stdout.flush()
        return

    # Stray prints from the skill must not corrupt the envelope.
    sys.stdout = sys.stderr
    try:
        sys.path.insert(0, root)
        module = _load(root, skill)
        run = getattr(module, "run", None)
        if not callable(run):
            raise AttributeError("skill entry is missing run(arguments)")
        result = run(arguments)
        payload = {"status": "ok", "result": _jsonable(result)}
    except BaseException as error:  # noqa: BLE001 - the envelope owns every failure
        traceback.print_exc(file=sys.stderr)
        payload = {"status": "error", "message": f"{type(error).__name__}: {error}"}
    finally:
        sys.stdout = real_stdout

    real_stdout.write(json.dumps(payload, ensure_ascii=False))
    real_stdout.flush()


if __name__ == "__main__":
    main()