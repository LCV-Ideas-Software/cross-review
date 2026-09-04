"""Analysis-only Python marker for GitHub code scanning.

This module is deliberately not imported by the cross-review runtime, by the
release automation or by any test. Its only purpose is to keep one analyzable
Python file in this repository so the CodeQL default setup applied by the
Enterprise security configuration can build a Python database for every
commit: the release gates in `.github/workflows/auto-tag.yml` and
`.github/workflows/publish.yml` require the `/language:python` analysis of the
exact release SHA, and CodeQL fails a language whose source it cannot find.
"""

CODE_QUALITY_PROBE = {
    "repository": "LCV-Ideas-Software/cross-review",
    "purpose": "CodeQL default-setup Python language detection",
}
