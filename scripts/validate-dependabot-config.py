from pathlib import Path

import yaml


config_path = Path(__file__).resolve().parents[1] / ".github" / "dependabot.yml"
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
assert stepsecurity.get("replaces-base") is True, (
    "StepSecurity must replace the npm base registry instead of acting as a fallback source"
)
assert by_ecosystem["npm"].get("registries") == ["stepsecurity-javascript"]

print("dependabot configuration: PASS")
