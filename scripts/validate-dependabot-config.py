from pathlib import Path

import yaml


config_path = Path(__file__).resolve().parents[1] / ".github" / "dependabot.yml"
root_path = config_path.parents[1]
config = yaml.safe_load(config_path.read_text(encoding="utf-8"))

assert isinstance(config, dict), "dependabot.yml root must be a mapping"
assert config.get("version") == 2, "dependabot.yml must use schema version 2"

updates = config.get("updates")
assert isinstance(updates, list), "dependabot.yml updates must be a list"
by_ecosystem = {
    update.get("package-ecosystem"): update
    for update in updates
    if isinstance(update, dict)
}
expected = {"npm", "github-actions", "pip", "pre-commit"}
assert set(by_ecosystem) == expected, (
    f"dependabot.yml ecosystems must be exactly {sorted(expected)}, "
    f"got {sorted(str(value) for value in by_ecosystem)}"
)

for ecosystem, update in by_ecosystem.items():
    assert update.get("directory") == "/", f"{ecosystem} must monitor the repository root"
    schedule = update.get("schedule")
    assert isinstance(schedule, dict), f"{ecosystem} schedule must be a mapping"
    assert schedule.get("interval") == "daily", f"{ecosystem} must run daily"
    assert "day" not in schedule, f"{ecosystem} daily schedule cannot use weekly-only day"

assert "registries" not in config, "Dependabot must not retain private registry credentials"
assert "registries" not in by_ecosystem["npm"], "npm updates must use the public base registry"

npmrc = (root_path / ".npmrc").read_text(encoding="utf-8")
assert "registry=https://registry.npmjs.org/" in npmrc, (
    ".npmrc must use npmjs.org as npm's global dependency registry"
)

python_source_path = root_path / "python-tools-requirements.in"
python_lock_path = root_path / "python-tools-requirements.txt"
assert python_source_path.is_file(), "pip-compile source manifest is required"
assert python_lock_path.is_file(), "pip-compile hash lock is required"
python_source = python_source_path.read_text(encoding="utf-8")
python_lock = python_lock_path.read_text(encoding="utf-8")
for direct_dependency in ("pre-commit", "pyyaml"):
    source_lines = [
        line.strip()
        for line in python_source.splitlines()
        if line.strip().startswith(f"{direct_dependency}==")
    ]
    assert len(source_lines) == 1, f"{direct_dependency} must have one direct source pin"
    assert source_lines[0].split("#", 1)[0].strip() in python_lock, (
        f"{direct_dependency} source pin must match the compiled lock"
    )

pip_groups = by_ecosystem["pip"].get("groups")
assert isinstance(pip_groups, dict), "pip updates must be grouped to avoid merge races"
python_tools_group = pip_groups.get("python-tools")
assert isinstance(python_tools_group, dict)
assert python_tools_group.get("patterns") == ["*"]
assert python_tools_group.get("update-types") == ["minor", "patch"]

print("dependabot configuration: PASS")
