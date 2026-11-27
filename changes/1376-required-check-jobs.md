Added

`yokoten doctor` notes a required check name that no job in `.github/workflows` on the default branch reports. `yokoten check --pr` notes a pull request that renames or removes such a job. A matrix name such as `tests (ubuntu-latest)` is matched. A ruleset or workflow it cannot read says "not checked" (#1376).
