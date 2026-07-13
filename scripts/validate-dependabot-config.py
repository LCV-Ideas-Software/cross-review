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

registries = config.get("registries")
assert isinstance(registries, dict), "Dependabot registries must be a mapping"
stepsecurity = registries.get("stepsecurity-javascript")
assert isinstance(stepsecurity, dict), "StepSecurity npm registry must be configured"
assert stepsecurity.get("type") == "npm-registry"
assert stepsecurity.get("url") == "https://registry.stepsecurity.io/javascript"
assert "replaces-base" not in stepsecurity, (
    "Do not combine replaces-base with the global StepSecurity registry in .npmrc; "
    "Dependabot/Corepack must fetch the npm CLI from the ecosystem base registry"
)
assert by_ecosystem["npm"].get("registries") == ["stepsecurity-javascript"]

npmrc = (root_path / ".npmrc").read_text(encoding="utf-8")
assert "registry=https://registry.stepsecurity.io/javascript" in npmrc, (
    ".npmrc must keep StepSecurity as npm's global dependency registry"
)

python_source_path = root_path / "socketsecurity-requirements.in"
python_lock_path = root_path / "socketsecurity-requirements.txt"
assert python_source_path.is_file(), "pip-compile source manifest is required"
assert python_lock_path.is_file(), "pip-compile hash lock is required"
python_source = python_source_path.read_text(encoding="utf-8")
python_lock = python_lock_path.read_text(encoding="utf-8")
for direct_dependency in ("pre-commit", "socketsecurity"):
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
